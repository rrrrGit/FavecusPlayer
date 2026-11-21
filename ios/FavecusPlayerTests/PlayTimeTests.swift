import XCTest
@testable import FavecusPlayer

@MainActor
final class PlayTimeTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-playtime-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testPlayTimeTracksBackgroundPlaybackExcludesSeeksAndPersists() throws {
        let base = Date(timeIntervalSince1970: 1_795_200_000)
        let store = PlayTimeStore(directory: directory)
        store.begin(now: base)
        store.observe(position: 0, paused: false, rate: 1, now: base)
        // バックグラウンドでの間引き（30秒後の更新）でも加算される
        store.observe(position: 30, paused: false, rate: 1, now: base.addingTimeInterval(30))
        // シークによる大きな飛び（+120秒）は加算しない
        store.observe(position: 150, paused: false, rate: 1, now: base.addingTimeInterval(31))
        // 一時停止した瞬間の最後の区間（+5秒）は加算してフラッシュされ、その後の停止状態は加算しない
        store.observe(position: 155, paused: true, rate: 1, now: base.addingTimeInterval(36))
        store.observe(position: 160, paused: true, rate: 1, now: base.addingTimeInterval(41))
        // 一時停止中にシークして（160→200）20秒後に再開しても、停止中のシークや待機時間は加算されず再開後の実再生（+4秒）だけ加算する
        store.observe(position: 200, paused: false, rate: 1, now: base.addingTimeInterval(61))
        store.observe(position: 204, paused: false, rate: 1, now: base.addingTimeInterval(65))
        store.flush()

        let reloaded = PlayTimeStore(directory: directory)
        let stats = reloaded.stats(months: 12, now: base)
        XCTAssertEqual(stats.totalSeconds, 39)
        XCTAssertEqual(stats.byMonth.values.reduce(0, +), 39)

        let file = directory.appendingPathComponent("play-time.json")
        try Data("{ invalid".utf8).write(to: file)
        XCTAssertEqual(PlayTimeStore(directory: directory).stats(months: 12, now: base).totalSeconds, 0)
    }

    func testFormatDurationFormatsSecondsMinutesAndHours() {
        XCTAssertEqual(PlayTimeStore.formatDuration(0), "0分")
        XCTAssertEqual(PlayTimeStore.formatDuration(45), "45秒")
        XCTAssertEqual(PlayTimeStore.formatDuration(125), "2分")
        XCTAssertEqual(PlayTimeStore.formatDuration(3600), "1時間")
        XCTAssertEqual(PlayTimeStore.formatDuration(3725), "1時間2分")
    }
}
