import AVFoundation
import XCTest
@testable import FavecusPlayer

/// アラームの音の「ランダム」（v0.7.4 H）：抽選（お気に入りは少しだけ多く）・最初の30秒・鳴ったあとの抽選し直し。
@MainActor
final class AlarmRandomTests: XCTestCase {
    private var directory: URL!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-alarm-random-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func songs(_ count: Int) -> [AlarmSong] {
        (0..<count).map { AlarmSong(key: "local:s\($0).mp3", title: "曲\($0)", file: directory.appendingPathComponent("s\($0).mp3")) }
    }

    func testEveryNormalSongIsEquallyLikelyAndAFavoriteIsAboutOneAndAHalfTimesMoreLikely() {
        var state: UInt64 = 12345
        let rng: () -> Double = { state = state &* 6364136223846793005 &+ 1442695040888963407; return Double(state >> 11) / Double(1 << 53) }
        let pool = songs(4)
        var counts: [String: Int] = [:]
        let rounds = 40000
        for _ in 0..<rounds { counts[AlarmRandom.pick(pool, favorites: ["local:s0.mp3"], rng: rng)!.key, default: 0] += 1 }
        let favoriteShare = Double(counts["local:s0.mp3"] ?? 0) / Double(rounds)
        XCTAssertEqual(favoriteShare, 1.5 / 4.5, accuracy: 0.02, "お気に入りの確率は、1.5 / (1.5+1+1+1)")
        for key in ["local:s1.mp3", "local:s2.mp3", "local:s3.mp3"] { XCTAssertEqual(Double(counts[key] ?? 0) / Double(rounds), 1 / 4.5, accuracy: 0.02, key) }
        let plain = (0..<rounds).filter { _ in AlarmRandom.pick(pool, favorites: [], rng: rng)!.key == "local:s0.mp3" }.count
        XCTAssertEqual(Double(plain) / Double(rounds), 0.25, accuracy: 0.02, "お気に入りがなければ、完全に均等")
        XCTAssertNil(AlarmRandom.pick([], favorites: [], rng: rng))
        XCTAssertEqual(AlarmRandom.pick(pool, favorites: [], rng: { 0.9999999 })?.key, "local:s3.mp3", "乱数が上限でも、範囲外にならない")
    }

    func testTheRandomSoundIsTheFirstThirtySecondsOfTheChosenSong() {
        let sound = AlarmRandom.sound(for: songs(1)[0])
        XCTAssertEqual(sound, AlarmSound(mediaKey: "local:s0.mp3", startSeconds: 0, durationSeconds: 30))
    }

    func testOldSavedAlarmsWithoutTheRandomFieldsStillLoad() throws {
        let old = #"{"id":"0A0B0C0D-0000-4000-8000-000000000001","hour":7,"minute":0,"weekdays":[2],"enabled":true,"label":"朝"}"#
        let item = try JSONDecoder().decode(AlarmItem.self, from: Data(old.utf8))
        XCTAssertFalse(item.randomSound)
        XCTAssertNil(item.rolledFor)
        XCTAssertFalse(item.hasSound)
        let round = try JSONDecoder().decode(AlarmItem.self, from: JSONEncoder().encode(AlarmItem(hour: 6, minute: 30, randomSound: true, rolledFor: clock)))
        XCTAssertTrue(round.randomSound)
        XCTAssertEqual(round.rolledFor, clock)
    }

    private func makeTone() throws -> URL {
        let url = directory.appendingPathComponent("tone-\(UUID().uuidString).wav")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        let frames = AVAudioFrameCount(40 * 44100)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<Int(frames) { samples[index] = 0.3 * sin(Float(index) * 0.05) }
        try file.write(from: buffer)
        return url
    }

    private func service(_ scheduler: AlarmTests.FakeScheduler, picks: @escaping () -> AlarmSound?) throws -> AlarmService {
        let sut = AlarmService(store: AlarmStore(directory: directory), scheduler: scheduler)
        let tone = try makeTone()
        sut.soundsDirectory = directory.appendingPathComponent("Sounds")
        sut.soundSource = { _ in tone }
        sut.randomPicker = picks
        sut.now = { [unowned self] in self.clock }
        return sut
    }

    func testSavingARandomAlarmChoosesASongAndMakesItsSound() async throws {
        let scheduler = AlarmTests.FakeScheduler()
        let sut = try service(scheduler) { AlarmSound(mediaKey: "local:s0.mp3", startSeconds: 0, durationSeconds: 30) }
        let item = AlarmItem(hour: 7, minute: 0, weekdays: [], randomSound: true)
        await sut.save(item)
        let saved = try XCTUnwrap(sut.alarms.first)
        XCTAssertEqual(saved.sound?.mediaKey, "local:s0.mp3")
        XCTAssertTrue(saved.randomSound)
        XCTAssertNotNil(saved.rolledFor, "次に鳴る時刻を覚える")
        XCTAssertNotNil(scheduler.soundNames[item.id] ?? nil, "選ばれた曲の音が、予約に渡る")
    }

    func testTheSongIsChosenAgainOnlyAfterTheRolledTimePassesAndNotWhileItsPlayButtonIsPending() async throws {
        let scheduler = AlarmTests.FakeScheduler()
        var rolls = 0
        let sut = try service(scheduler) { rolls += 1; return AlarmSound(mediaKey: "local:s\(rolls).mp3", startSeconds: 0, durationSeconds: 30) }
        let item = AlarmItem(hour: 7, minute: 0, weekdays: [1, 2, 3, 4, 5, 6, 7], randomSound: true)
        await sut.save(item)
        XCTAssertEqual(rolls, 1)
        await sut.resync() // まだ鳴る時刻の前：抽選し直さない
        XCTAssertEqual(rolls, 1)
        clock = try XCTUnwrap(sut.alarms.first?.rolledFor).addingTimeInterval(60) // 鳴ったあと
        AlarmPlayRequest.set(item.id.uuidString) // 「曲を再生」で開かれる途中：曲を変えない
        await sut.resync()
        XCTAssertEqual(rolls, 1, "再生する曲が、変わらない")
        _ = AlarmPlayRequest.take()
        await sut.resync()
        XCTAssertEqual(rolls, 2, "鳴ったあとに開くと、次の曲を選び直す")
        XCTAssertEqual(sut.alarms.first?.sound?.mediaKey, "local:s2.mp3")
        XCTAssertGreaterThan(try XCTUnwrap(sut.alarms.first?.rolledFor), clock, "次の時刻へ更新される")
    }

    func testWithoutSavedSongsARandomAlarmFallsBackToTheDefaultSoundWithANotice() async throws {
        let scheduler = AlarmTests.FakeScheduler()
        let sut = try service(scheduler) { nil }
        let item = AlarmItem(hour: 7, minute: 0, randomSound: true)
        await sut.save(item)
        XCTAssertNotNil(scheduler.scheduled[item.id], "アラーム自体は予約する")
        XCTAssertNil(scheduler.soundNames[item.id] ?? nil)
        XCTAssertNotNil(sut.notice)
    }
}
