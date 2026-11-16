import XCTest
@testable import FavecusPlayer

/// アラームの保存・予約の受け渡し（v0.7.3 Step1）。AlarmKit本体は実機でしか確認できないため、予約は差し替えて確認する。
@MainActor
final class AlarmTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-alarm-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    final class FakeScheduler: AlarmScheduling, @unchecked Sendable {
        var scheduled: [UUID: AlarmItem] = [:]
        var failure: AlarmError?
        func requestAuthorization() async -> AlarmAuthorization { failure == nil ? .authorized : .denied }
        func schedule(_ item: AlarmItem) async throws {
            if let failure { throw failure }
            scheduled[item.id] = item
        }
        func cancel(id: UUID) async { scheduled[id] = nil }
    }

    private func service(_ scheduler: FakeScheduler) -> AlarmService {
        AlarmService(store: AlarmStore(directory: directory), scheduler: scheduler)
    }

    func testSavedAlarmIsScheduledAndSurvivesARestart() async {
        let scheduler = FakeScheduler()
        let first = service(scheduler)
        let item = AlarmItem(hour: 7, minute: 30, weekdays: [2, 3, 4, 5, 6], label: "朝")
        await first.save(item)
        XCTAssertEqual(scheduler.scheduled[item.id]?.hour, 7)
        let second = service(FakeScheduler())
        XCTAssertEqual(second.alarms, [item])
    }

    func testDisablingCancelsTheScheduleButKeepsTheAlarm() async {
        let scheduler = FakeScheduler()
        let sut = service(scheduler)
        let item = AlarmItem(hour: 6, minute: 0)
        await sut.save(item)
        await sut.setEnabled(id: item.id, false)
        XCTAssertNil(scheduler.scheduled[item.id])
        XCTAssertEqual(sut.alarms.first?.enabled, false)
        await sut.setEnabled(id: item.id, true)
        XCTAssertNotNil(scheduler.scheduled[item.id])
    }

    func testRemoveDeletesBothTheScheduleAndTheRecord() async {
        let scheduler = FakeScheduler()
        let sut = service(scheduler)
        let item = AlarmItem(hour: 6, minute: 0)
        await sut.save(item)
        await sut.remove(id: item.id)
        XCTAssertTrue(sut.alarms.isEmpty)
        XCTAssertTrue(scheduler.scheduled.isEmpty)
        XCTAssertTrue(service(FakeScheduler()).alarms.isEmpty)
    }

    func testFailedScheduleIsKeptDisabledWithANotice() async {
        let scheduler = FakeScheduler()
        scheduler.failure = .notAuthorized
        let sut = service(scheduler)
        let item = AlarmItem(hour: 8, minute: 15)
        await sut.save(item)
        XCTAssertEqual(sut.alarms.first?.enabled, false)
        XCTAssertNotNil(sut.notice)
        XCTAssertTrue(scheduler.scheduled.isEmpty)
    }

    func testInvalidAlarmIsRejected() async {
        let scheduler = FakeScheduler()
        let sut = service(scheduler)
        await sut.save(AlarmItem(hour: 24, minute: 0))
        await sut.save(AlarmItem(hour: 7, minute: 0, weekdays: [0]))
        XCTAssertTrue(sut.alarms.isEmpty)
        XCTAssertTrue(scheduler.scheduled.isEmpty)
    }

    func testSoundRangeIsClampedToTheLimit() async {
        let sut = service(FakeScheduler())
        let sound = AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: -5, durationSeconds: 300)
        await sut.save(AlarmItem(hour: 7, minute: 0, sound: sound))
        XCTAssertEqual(sut.alarms.first?.sound, AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 0, durationSeconds: AlarmSound.maxDuration))
        XCTAssertEqual(AlarmSound(mediaKey: "x", startSeconds: 10, durationSeconds: 0).normalized().durationSeconds, AlarmSound.minDuration)
    }

    func testResyncReschedulesOnlyEnabledAlarms() async {
        let setup = FakeScheduler()
        let first = service(setup)
        let on = AlarmItem(hour: 7, minute: 0), off = AlarmItem(hour: 8, minute: 0, enabled: false)
        await first.save(on)
        await first.save(off)
        let fresh = FakeScheduler()
        await service(fresh).resync()
        XCTAssertEqual(Set(fresh.scheduled.keys), [on.id])
    }

    func testCorruptOrNewerFileIsNeverOverwritten() async throws {
        let file = directory.appendingPathComponent("alarms.json")
        try Data("{ not json".utf8).write(to: file)
        let sut = service(FakeScheduler())
        XCTAssertNotNil(sut.notice)
        await sut.save(AlarmItem(hour: 7, minute: 0))
        XCTAssertEqual(try String(contentsOf: file), "{ not json")
        try Data(#"{"version":99,"alarms":[]}"#.utf8).write(to: file)
        _ = service(FakeScheduler())
        XCTAssertEqual(try String(contentsOf: file), #"{"version":99,"alarms":[]}"#)
    }

    func testNextFireDateForOneShotAndWeekly() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 9, minute: 0))) // 月曜
        let once = try XCTUnwrap(AlarmItem(hour: 7, minute: 30).nextFireDate(after: now, calendar: calendar))
        XCTAssertEqual(calendar.dateComponents([.day, .hour, .minute], from: once), DateComponents(day: 17, hour: 7, minute: 30))
        let weekly = try XCTUnwrap(AlarmItem(hour: 7, minute: 30, weekdays: [2, 4]).nextFireDate(after: now, calendar: calendar)) // 月・水
        XCTAssertEqual(calendar.dateComponents([.day, .hour], from: weekly), DateComponents(day: 18, hour: 7))
        XCTAssertNil(AlarmItem(hour: 7, minute: 30, weekdays: [9]).nextFireDate(after: now, calendar: calendar))
    }
}
