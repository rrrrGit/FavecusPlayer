import AVFoundation
import XCTest
@testable import FavecusPlayer

/// アラームの音（v0.7.3 Step3）：選んだ範囲から音のファイルを作る処理と、予約への受け渡し。
@MainActor
final class AlarmSoundTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-alarm-sound-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// 無音ではない、指定の長さのテスト用の音声（44.1kHz・モノ・16bit・WAV）。
    private func makeSource(seconds: Double) throws -> URL {
        let url = directory.appendingPathComponent("source-\(UUID().uuidString).wav")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        let frames = AVAudioFrameCount(seconds * 44100)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<Int(frames) { samples[index] = 0.3 * sin(Float(index) * 0.05) }
        try file.write(from: buffer)
        return url
    }

    private func duration(_ url: URL) async throws -> Double {
        try await AVURLAsset(url: url).load(.duration).seconds
    }

    func testMakesAFileOfTheChosenLength() async throws {
        let source = try makeSource(seconds: 6)
        let output = directory.appendingPathComponent("Sounds/out.caf")
        try await AlarmSoundMaker.make(source: source, start: 1, duration: 3, output: output)
        let length = try await duration(output)
        XCTAssertEqual(length, 3, accuracy: 0.2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.deletingLastPathComponent().path), ["out.caf"], "一時ファイルが残らない")
    }

    func testRangeIsCutToTheSongEndAndTheLimit() async throws {
        let source = try makeSource(seconds: 5)
        let output = directory.appendingPathComponent("tail.caf")
        try await AlarmSoundMaker.make(source: source, start: 4, duration: 30, output: output)
        let length = try await duration(output)
        XCTAssertEqual(length, 1, accuracy: 0.2)
    }

    func testNonAudioSourceFailsWithoutLeavingAFile() async throws {
        let bogus = directory.appendingPathComponent("bogus.wav")
        try Data("not audio".utf8).write(to: bogus)
        let output = directory.appendingPathComponent("bad.caf")
        do { try await AlarmSoundMaker.make(source: bogus, start: 0, duration: 5, output: output); XCTFail("失敗するはず") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    private func service(_ scheduler: AlarmTests.FakeScheduler, source: URL?) -> AlarmService {
        let sut = AlarmService(store: AlarmStore(directory: directory), scheduler: scheduler)
        sut.soundsDirectory = directory.appendingPathComponent("Sounds")
        sut.soundSource = { _ in source }
        return sut
    }

    func testScheduleReceivesTheMadeSoundFile() async throws {
        let scheduler = AlarmTests.FakeScheduler()
        let sut = service(scheduler, source: try makeSource(seconds: 8))
        let item = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 2, durationSeconds: 4))
        await sut.save(item)
        let name = try XCTUnwrap(scheduler.soundNames[item.id] ?? nil)
        XCTAssertEqual(name, AlarmService.soundFileName(id: item.id))
        let made = directory.appendingPathComponent("Sounds").appendingPathComponent(name)
        let length = try await duration(made)
        XCTAssertEqual(length, 4, accuracy: 0.2)
        await sut.remove(id: item.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: made.path), "削除したアラームの音は残さない")
    }

    func testMissingSongFallsBackToTheDefaultSoundWithANotice() async {
        let scheduler = AlarmTests.FakeScheduler()
        let sut = service(scheduler, source: nil)
        let item = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 0, durationSeconds: 5))
        await sut.save(item)
        XCTAssertNotNil(scheduler.scheduled[item.id], "音が作れなくても、アラーム自体は予約する")
        XCTAssertNil(scheduler.soundNames[item.id] ?? nil)
        XCTAssertNotNil(sut.notice)
        XCTAssertEqual(sut.alarms.first?.sound?.mediaKey, "bili:BV1aaaaaaaaa:p1", "選んだ曲の記録は残す")
    }

    func testResyncRecreatesMissingSoundFileWhenScheduleLost() async throws {
        let source = try makeSource(seconds: 6)
        let first = service(AlarmTests.FakeScheduler(), source: source)
        let item = AlarmItem(hour: 7, minute: 0, weekdays: [2], sound: AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 0, durationSeconds: 3))
        await first.save(item)
        let name = AlarmService.soundFileName(id: item.id)
        let made = directory.appendingPathComponent("Sounds").appendingPathComponent(name)
        try FileManager.default.removeItem(at: made)
        XCTAssertFalse(FileManager.default.fileExists(atPath: made.path))

        let scheduler = AlarmTests.FakeScheduler()
        let second = service(scheduler, source: source)
        await second.resync()
        XCTAssertEqual(scheduler.soundNames[item.id] ?? nil, name, "消えていたアラーム音源ファイルを作り直して予約する")
        XCTAssertTrue(FileManager.default.fileExists(atPath: made.path))
    }

    func testResyncWhileLibraryNotReadyDoesNotLockOutCustomSound() async throws {
        let source = try makeSource(seconds: 6)
        let first = service(AlarmTests.FakeScheduler(), source: source)
        let item = AlarmItem(hour: 7, minute: 0, weekdays: [2], sound: AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 0, durationSeconds: 3))
        await first.save(item)
        let name = AlarmService.soundFileName(id: item.id)
        let made = directory.appendingPathComponent("Sounds").appendingPathComponent(name)
        try FileManager.default.removeItem(at: made)

        let scheduler = AlarmTests.FakeScheduler()
        var ready = false
        let second = service(scheduler, source: source)
        second.isLibraryReady = { ready }
        await second.resync()
        XCTAssertNil(scheduler.scheduled[item.id], "ライブラリ未準備で音源欠損時は既定の音で仮予約しない")

        ready = true
        await second.resync()
        XCTAssertEqual(scheduler.soundNames[item.id] ?? nil, name, "ライブラリ読み込み完了後に音源を作り直して予約する")
        XCTAssertTrue(FileManager.default.fileExists(atPath: made.path))
    }
}
