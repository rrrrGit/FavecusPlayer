import XCTest
@testable import FavecusPlayer

/// 再生速度：選べる値・保存・表示。
final class PlaybackSpeedTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "favecus-speed-\(UUID().uuidString)")! }

    func testValuesSnapToTheNearestAllowedSpeedAndBadValuesBecomeNormal() {
        XCTAssertEqual(PlaybackSpeed.nearest(1.0), 1.0)
        XCTAssertEqual(PlaybackSpeed.nearest(1.3), 1.25)
        XCTAssertEqual(PlaybackSpeed.nearest(9), 2.0)
        XCTAssertEqual(PlaybackSpeed.nearest(0.1), 0.5)
        XCTAssertEqual(PlaybackSpeed.nearest(.nan), 1.0)
        XCTAssertEqual(PlaybackSpeed.nearest(.infinity), 1.0)
    }

    func testTheSpeedIsRememberedAndAnOddSavedValueIsCorrected() {
        let suite = defaults()
        XCTAssertEqual(PlaybackSpeed.stored(suite), 1.0)
        PlaybackSpeed.store(1.5, suite)
        XCTAssertEqual(PlaybackSpeed.stored(suite), 1.5)
        suite.set(7.0, forKey: "playbackSpeed")
        XCTAssertEqual(PlaybackSpeed.stored(suite), 2.0)
        suite.set("fast", forKey: "playbackSpeed")
        XCTAssertEqual(PlaybackSpeed.stored(suite), 1.0)
    }

    func testTheLabels() {
        XCTAssertEqual(PlaybackSpeed.text(1.0), "1.0倍")
        XCTAssertEqual(PlaybackSpeed.text(0.75), "0.75倍")
        XCTAssertEqual(PlaybackSpeed.text(1.5), "1.5倍")
    }
}
