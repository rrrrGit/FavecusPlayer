import XCTest
@testable import FavecusPlayer

@MainActor
final class ActivityLogTests: XCTestCase {
    private var directory: URL!
    private var calendar: Calendar!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-activity-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    func testRecordsPersistAndPruneEntriesOlderThanSevenDays() {
        var now = date(2026, 11, 10, 9, 0)
        let first = ActivityLogStore(directory: directory, calendar: calendar, now: { now })
        first.record("app.launch")

        now = date(2026, 11, 15, 14, 30)
        first.record("alarm.resync", detail: ["liveCount": "1"])

        now = date(2026, 11, 17, 10, 0)
        first.record("app.foreground")

        // 11/17 時点で保持されるのは 11/11〜11/17 の 7 日間（11/10 は削除される）
        XCTAssertEqual(first.entries.map(\.day), ["2026-11-15", "2026-11-17"])
        XCTAssertEqual(first.dirtyDays, ["2026-11-15", "2026-11-17"])

        let reloaded = ActivityLogStore(directory: directory, calendar: calendar, now: { now })
        XCTAssertEqual(reloaded.entries.count, 2)
        XCTAssertEqual(reloaded.entries.first?.detail?["liveCount"], "1")
    }

    func testDailySyncDetectionMidnightCalculationAndMarkSynced() {
        var now = date(2026, 11, 27, 23, 50)
        let store = ActivityLogStore(directory: directory, calendar: calendar, now: { now })
        XCTAssertTrue(store.needsDailySync())
        XCTAssertEqual(store.nextMidnight(), date(2026, 11, 28, 0, 0))

        store.record("app.launch")
        let payload = store.pendingSyncPayload()
        XCTAssertEqual(payload.retentionBeforeDay, "2026-11-21")
        XCTAssertEqual(payload.days.count, 1)
        XCTAssertEqual(payload.days.first?["day"] as? String, "2026-11-27")

        store.markSynced(days: ["2026-11-27"])
        XCTAssertFalse(store.needsDailySync())

        store.record("sync.activity_logs", detail: ["ok": "1"], markDirty: false)
        XCTAssertTrue(store.dirtyDays.isEmpty, "同期成功の記録で再dirty化しない")
        store.record("app.foreground")
        store.record("sync.activity_logs", detail: ["ok": "1"], markDirty: false)
        XCTAssertEqual(store.dirtyDays, ["2026-11-27"])
        XCTAssertFalse(store.needsDailySync(), "当日中の通常ログは次の0:00まで蓄積する")
        let reloaded = ActivityLogStore(directory: directory, calendar: calendar, now: { now })
        XCTAssertFalse(reloaded.needsDailySync(), "再起動後も当日の同期済み状態を保持する")
        XCTAssertEqual(reloaded.entries.last?.kind, "sync.activity_logs")

        // 0:00 を跨ぐと再び日次同期が必要になる
        now = date(2026, 11, 28, 0, 0)
        XCTAssertTrue(store.needsDailySync())
    }

    func testAnUnsyncedPreviousDayStillRequiresSyncAfterTodaysSync() {
        var now = date(2026, 11, 26, 23, 59)
        let store = ActivityLogStore(directory: directory, calendar: calendar, now: { now })
        store.record("app.background")
        now = date(2026, 11, 27, 9)
        store.record("app.foreground")
        store.markSynced(days: ["2026-11-27"])
        XCTAssertTrue(store.needsDailySync(), "今日同期済みでも前日分を取り残さない")
        store.markSynced(days: ["2026-11-26"])
        store.record("app.foreground")
        XCTAssertFalse(store.needsDailySync())
        XCTAssertFalse(store.needsDailySync(at: date(2026, 11, 27, 23, 59)))
        XCTAssertTrue(store.needsDailySync(at: date(2026, 11, 28)))
    }

    func testCorruptFileIsBackedUpInsteadOfCrashing() throws {
        let file = directory.appendingPathComponent("activity-logs.json")
        try Data("{broken".utf8).write(to: file)
        let store = ActivityLogStore(directory: directory, calendar: calendar, now: { self.date(2026, 11, 27, 9, 0) })
        XCTAssertTrue(store.entries.isEmpty)
        store.record("app.launch")
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(files.contains { $0.hasPrefix("activity-logs.broken-") })
    }

    func testAlarmServiceRecordsSaveResyncAndRemoveEvents() async {
        let scheduler = AlarmTests.FakeScheduler()
        let logs = ActivityLogStore(directory: directory, calendar: calendar, now: { self.date(2026, 11, 27, 9, 5) })
        let service = AlarmService(store: AlarmStore(directory: directory), scheduler: scheduler)
        service.activityLog = { kind, detail in logs.record(kind, detail: detail) }

        let alarm = AlarmItem(hour: 9, minute: 5, weekdays: [2, 3, 4, 5, 6])
        await service.save(alarm)
        await service.resync()
        await service.remove(id: alarm.id)

        XCTAssertEqual(logs.entries.map(\.kind), ["alarm.save", "alarm.resync", "alarm.remove"])
        XCTAssertEqual(logs.entries.first?.detail?["time"], "09:05")
        XCTAssertEqual(logs.entries.first?.detail?["weekdays"], "2,3,4,5,6")
    }
}
