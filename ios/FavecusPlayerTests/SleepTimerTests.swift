import XCTest
@testable import FavecusPlayer

/// おやすみタイマー（v0.7.3 F1）。規則は、PC版の test/sleep-timer.test.cjs と同じ。時計は、偽の時刻で進める。
@MainActor
final class SleepTimerTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000_000)
    private var fades: [Double] = []
    private var expired = 0

    private func make() -> SleepTimer {
        let timer = SleepTimer(now: { [unowned self] in self.clock })
        timer.onFade = { [unowned self] in self.fades.append($0) }
        timer.onExpire = { [unowned self] in self.expired += 1 }
        return timer
    }

    func testOnlyListedDurationsAreAccepted() {
        let timer = make()
        XCTAssertFalse(timer.start(minutes: 20))
        XCTAssertEqual(timer.mode, .off)
        XCTAssertTrue(timer.start(minutes: 30))
        XCTAssertEqual(timer.mode, .minutes(30))
        XCTAssertEqual(timer.deadline, clock.addingTimeInterval(30 * 60))
        timer.cancel()
    }

    func testFadesOnlyInTheLastSecondsThenPausesOnceAndRestoresVolume() {
        let timer = make()
        timer.start(minutes: 15)
        clock = clock.addingTimeInterval(15 * 60 - SleepTimerRules.fadeSeconds - 1)
        timer.tick()
        XCTAssertTrue(fades.isEmpty, "フェードの前は音量を触らない")
        clock = clock.addingTimeInterval(1 + SleepTimerRules.fadeSeconds / 2)
        timer.tick()
        XCTAssertEqual(try XCTUnwrap(fades.last), 0.5, accuracy: 0.01)
        clock = clock.addingTimeInterval(SleepTimerRules.fadeSeconds / 2)
        timer.tick()
        XCTAssertEqual(expired, 1)
        XCTAssertEqual(fades.last, 1, "一時停止のあと、音量を元に戻す")
        XCTAssertEqual(timer.mode, .off)
        clock = clock.addingTimeInterval(60)
        timer.tick()
        XCTAssertEqual(expired, 1, "期限のあとは、もう動かない")
    }

    func testALateTickStillStopsAtOnce() {
        let timer = make()
        timer.start(minutes: 45)
        clock = clock.addingTimeInterval(3 * 60 * 60) // 端末が眠っていて、間隔が遅れた
        timer.tick()
        XCTAssertEqual(expired, 1)
    }

    func testCancelRestoresVolumeAndRestartReplaces() {
        let timer = make()
        timer.start(minutes: 60)
        clock = clock.addingTimeInterval(60 * 60 - 3)
        timer.tick()
        XCTAssertFalse(fades.isEmpty)
        timer.cancel()
        XCTAssertEqual(fades.last, 1)
        XCTAssertEqual(timer.mode, .off)
        clock = clock.addingTimeInterval(600)
        timer.tick()
        XCTAssertEqual(expired, 0)
        timer.start(minutes: 15)
        timer.start(minutes: 90)
        XCTAssertEqual(timer.mode, .minutes(90))
        timer.cancel()
    }

    func testEndOfSongStopsOnceAndTimedTimerIsNotConsumedBySongEnd() {
        let timer = make()
        timer.startEndOfSong()
        XCTAssertEqual(timer.mode, .endOfSong)
        XCTAssertTrue(timer.consumeEndOfSong())
        XCTAssertFalse(timer.consumeEndOfSong(), "1回だけ")
        timer.start(minutes: 15)
        XCTAssertFalse(timer.consumeEndOfSong(), "時間のタイマーは、曲の終わりでは止まらない")
        timer.cancel()
    }
}
