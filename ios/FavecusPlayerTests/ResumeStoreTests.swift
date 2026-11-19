import XCTest
@testable import FavecusPlayer

/// 前回の続きから再生の保存（v0.7.3 F2）。規則は、PC版の test/resume-point.test.cjs と同じ。
@MainActor
final class ResumeStoreTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000_000)
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "favecus-resume-store-\(UUID().uuidString)")
    }

    private func make() -> ResumeStore { ResumeStore(defaults: defaults, now: { [unowned self] in self.clock }) }
    private func sample(_ position: Double) -> ResumeRecord {
        ResumeRecord(entryId: "e1", playlistId: "p1", scope: "*", position: position, duration: 300)
    }

    func testPositionNearTheStartOrEndResumesFromTheBeginning() {
        XCTAssertEqual(ResumeStore.resumePosition(position: 3, duration: 200), 0)
        XCTAssertEqual(ResumeStore.resumePosition(position: 5, duration: 200), 5)
        XCTAssertEqual(ResumeStore.resumePosition(position: 123.9, duration: 200), 123)
        XCTAssertEqual(ResumeStore.resumePosition(position: 196, duration: 200), 0, "終わりの5秒以内")
        XCTAssertEqual(ResumeStore.resumePosition(position: 195, duration: 200), 195)
        XCTAssertEqual(ResumeStore.resumePosition(position: 50, duration: 0), 50, "長さが分からないときは、そのまま")
        XCTAssertEqual(ResumeStore.resumePosition(position: .nan, duration: 200), 0)
    }

    func testWritesAboutEveryTenSecondsAndAtOnceWhenPaused() {
        let store = make()
        store.observe(sample(10), paused: false) // 最初の1回は、すぐ保存
        XCTAssertEqual(make().get()?.position, 10)
        clock = clock.addingTimeInterval(3)
        store.observe(sample(13), paused: false)
        XCTAssertEqual(make().get()?.position, 10, "間隔の途中では、書き込まない")
        XCTAssertEqual(store.get()?.position, 13, "読み出しは、最新の位置")
        clock = clock.addingTimeInterval(ResumeStore.interval)
        store.observe(sample(25), paused: false)
        XCTAssertEqual(make().get()?.position, 25)
        clock = clock.addingTimeInterval(1)
        store.observe(sample(26), paused: true) // 一時停止にした瞬間
        XCTAssertEqual(make().get()?.position, 26)
    }

    func testFlushPersistsThePendingPositionAcrossARestart() {
        let store = make()
        store.observe(sample(40), paused: false)
        clock = clock.addingTimeInterval(2)
        store.observe(sample(42), paused: false)
        store.flush()
        XCTAssertEqual(make().get()?.position, 42)
    }

    func testMalformedDataIsIgnoredAndInvalidSamplesNeverOverwrite() {
        defaults.set(Data("{ not json".utf8), forKey: "playbackResume")
        XCTAssertNil(make().get())
        let store = make()
        store.observe(sample(30), paused: false)
        store.observe(ResumeRecord(entryId: "", playlistId: "p", scope: "*", position: 1, duration: 1), paused: false)
        store.observe(sample(-5), paused: false)
        store.flush()
        XCTAssertEqual(make().get()?.position, 30)
        store.clear()
        XCTAssertNil(make().get())
    }
}
