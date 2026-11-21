import XCTest
@testable import FavecusPlayer

/// クロスフェード：始めるかどうかの判断（曲の終わりの手前だけ・短い曲・1曲リピート・次の曲の準備・二重に始めない）と、設定値の丸め。
final class CrossfadeTests: XCTestCase {
    private func start(seconds: Int = 4, position: Double = 196, duration: Double = 200, playing: Bool = true, repeatOne: Bool = false, ready: Bool = true, started: Bool = false) -> Bool {
        Crossfade.shouldStart(seconds: seconds, position: position, duration: duration, isPlaying: playing, repeatOne: repeatOne, nextIsReady: ready, alreadyStarted: started)
    }

    func testItStartsOnlyInsideTheLastSecondsOfASong() {
        XCTAssertTrue(start(position: 196))
        XCTAssertTrue(start(position: 195.8))
        XCTAssertFalse(start(position: 190), "まだ早い")
        XCTAssertFalse(start(position: 199.9), "もう終わる直前")
    }

    func testItIsOffByDefaultAndNeverStartsWhenAnythingIsNotReady() {
        XCTAssertFalse(start(seconds: 0))
        XCTAssertFalse(start(playing: false))
        XCTAssertFalse(start(repeatOne: true))
        XCTAssertFalse(start(ready: false), "次の曲を、すぐ鳴らせないとき")
        XCTAssertFalse(start(started: true), "同じ曲で、二重に始めない")
        XCTAssertFalse(Crossfade.shouldStart(seconds: 4, position: .nan, duration: 200, isPlaying: true, repeatOne: false, nextIsReady: true, alreadyStarted: false))
    }

    func testAShortSongIsNeverCrossfaded() {
        XCTAssertFalse(start(seconds: 6, position: 10, duration: 12))
        XCTAssertFalse(start(seconds: 4, position: 9, duration: 10), "つなぎ目の2倍＋2秒より短い")
        XCTAssertTrue(start(seconds: 4, position: 106, duration: 110))
    }

    func testStoredValuesSnapToTheChoices() {
        XCTAssertEqual(Crossfade.seconds(stored: 0), 0)
        XCTAssertEqual(Crossfade.seconds(stored: -3), 0)
        XCTAssertEqual(Crossfade.seconds(stored: 5), 4)
        XCTAssertEqual(Crossfade.seconds(stored: 7), 6)
        XCTAssertEqual(Crossfade.seconds(stored: 99), 10)
        XCTAssertEqual(Crossfade.choices, [0, 2, 4, 6, 8, 10])
    }
}
