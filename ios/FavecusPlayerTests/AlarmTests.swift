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
        var soundNames: [UUID: String?] = [:]
        var failure: AlarmError?
        var waitBeforeSchedule: (() async -> Void)?
        func requestAuthorization() async -> AlarmAuthorization { failure == nil ? .authorized : .denied }
        func schedule(_ item: AlarmItem, soundName: String?) async throws {
            if let waitBeforeSchedule { await waitBeforeSchedule() }
            if let failure { throw failure }
            scheduled[item.id] = item
            soundNames[item.id] = soundName
        }
        func cancel(id: UUID) async { scheduled[id] = nil }
        func scheduledIDs() async -> Set<UUID>? { Set(scheduled.keys) }
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

    func testResyncRebuildsRepeatingAlarmsAndRetiresFiredOneShots() async {
        let first = service(FakeScheduler())
        let repeating = AlarmItem(hour: 7, minute: 0, weekdays: [2]), oneShot = AlarmItem(hour: 8, minute: 0), off = AlarmItem(hour: 9, minute: 0, enabled: false)
        await first.save(repeating)
        await first.save(oneShot)
        await first.save(off)
        let fresh = FakeScheduler() // OS側の予約が、すべて消えている状態
        let sut = service(fresh)
        await sut.resync()
        XCTAssertEqual(Set(fresh.scheduled.keys), [repeating.id])
        XCTAssertEqual(sut.alarms.first { $0.id == oneShot.id }?.enabled, false)
        XCTAssertEqual(service(FakeScheduler()).alarms.first { $0.id == oneShot.id }?.enabled, false)
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

    func testSoundSummaryShowsChosenSongRandomSongAndFallback() {
        let titles = ["bili:BV1aaaaaaaaa:p1": "お気に入りの曲", "local:song.mp3": "ローカル曲"]
        let picked = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "bili:BV1aaaaaaaaa:p1", startSeconds: 0, durationSeconds: 15))
        XCTAssertEqual(AlarmListView.soundSummary(picked) { titles[$0] }, "お気に入りの曲")

        let randomRolled = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "local:song.mp3", startSeconds: 0, durationSeconds: 30), randomSound: true)
        XCTAssertEqual(AlarmListView.soundSummary(randomRolled) { titles[$0] }, "ランダム：ローカル曲")

        let randomUnrolled = AlarmItem(hour: 7, minute: 0, sound: nil, randomSound: true)
        XCTAssertEqual(AlarmListView.soundSummary(randomUnrolled) { titles[$0] }, "ランダム（既定の音）")

        let randomUnknown = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "local:missing.mp3", startSeconds: 0, durationSeconds: 30), randomSound: true)
        XCTAssertEqual(AlarmListView.soundSummary(randomUnknown) { titles[$0] }, "ランダム（曲未取得）")

        let missingSong = AlarmItem(hour: 7, minute: 0, sound: AlarmSound(mediaKey: "local:missing.mp3", startSeconds: 0, durationSeconds: 30))
        XCTAssertEqual(AlarmListView.soundSummary(missingSong) { titles[$0] }, "曲が見つかりません")

        let defaultSound = AlarmItem(hour: 7, minute: 0)
        XCTAssertEqual(AlarmListView.soundSummary(defaultSound) { titles[$0] }, "既定の音")
    }

    func testResyncSkipsRandomRollUntilLibraryReady() async {
        let scheduler = FakeScheduler()
        let sut = service(scheduler)
        var current = Date(timeIntervalSince1970: 1_700_000_000)
        var ready = false
        var rollCount = 0
        sut.now = { current }
        sut.isLibraryReady = { ready }
        sut.randomPicker = {
            rollCount += 1
            return AlarmSound(mediaKey: "local:song.mp3", startSeconds: 0, durationSeconds: 30)
        }
        await sut.save(AlarmItem(hour: 7, minute: 0, weekdays: [2], randomSound: true))
        XCTAssertEqual(rollCount, 1)

        current = current.addingTimeInterval(14 * 86400)
        await sut.resync()
        XCTAssertEqual(rollCount, 1, "ライブラリ読み込み完了前はランダム再抽選しない")

        ready = true
        await sut.resync()
        XCTAssertEqual(rollCount, 2, "ライブラリ読み込み完了後の resync で再抽選する")
    }

    func testSaveAndRemoveAreSerializedAndDisablingDoesNotReRollOrLeaveOldCaf() async throws {
        let scheduler = FakeScheduler()
        var gateContinuation: CheckedContinuation<Void, Never>?
        var enterContinuation: CheckedContinuation<Void, Never>?
        scheduler.waitBeforeSchedule = {
            enterContinuation?.resume()
            enterContinuation = nil
            await withCheckedContinuation { gateContinuation = $0 }
        }
        let sut = service(scheduler)
        sut.soundsDirectory = directory.appendingPathComponent("Sounds", isDirectory: true)
        try FileManager.default.createDirectory(at: sut.soundsDirectory!, withIntermediateDirectories: true)

        // 1) save のスケジュール待機中に remove を呼んでも、削除済みアラームが復活しない
        let raced = AlarmItem(hour: 7, minute: 0, weekdays: [2])
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            enterContinuation = cont
            Task { await sut.save(raced) }
        }
        let removeTask = Task { await sut.remove(id: raced.id) }
        await Task.yield()
        scheduler.waitBeforeSchedule = nil
        gateContinuation?.resume()
        gateContinuation = nil
        await removeTask.value
        XCTAssertTrue(sut.alarms.isEmpty, "save 待機中の remove 後に削除済みアラームが復活しない")
        XCTAssertTrue(scheduler.scheduled.isEmpty)

        // 2) setEnabled(false) ではランダム再抽選せず、pendingPlayAlarmId 設定中も resync で再抽選しない
        var current = Date(timeIntervalSince1970: 1_700_000_000)
        var rollCount = 0
        sut.now = { current }
        sut.randomPicker = {
            rollCount += 1
            return AlarmSound(mediaKey: "local:song.mp3", startSeconds: 0, durationSeconds: 30)
        }
        let randomAlarm = AlarmItem(hour: 8, minute: 0, weekdays: [2], randomSound: true)
        await sut.save(randomAlarm)
        XCTAssertEqual(rollCount, 1)
        await sut.setEnabled(id: randomAlarm.id, false)
        XCTAssertEqual(rollCount, 1, "無効化時は再抽選しない")
        await sut.setEnabled(id: randomAlarm.id, true)
        XCTAssertEqual(rollCount, 2)

        current = current.addingTimeInterval(14 * 86400)
        sut.pendingPlayAlarmId = { randomAlarm.id.uuidString }
        await sut.resync()
        XCTAssertEqual(rollCount, 2, "曲を再生の待機中は resync で上書き抽選しない")
        sut.pendingPlayAlarmId = nil

        // 3) 既定の音に戻すと旧 .caf が削除され、前回の notice も消える
        let custom = AlarmItem(hour: 9, minute: 0, sound: AlarmSound(mediaKey: "local:missing.mp3", startSeconds: 0, durationSeconds: 10))
        await sut.save(custom)
        XCTAssertNotNil(sut.notice)
        let oldCaf = sut.soundsDirectory!.appendingPathComponent(AlarmService.soundFileName(id: custom.id))
        try Data("dummy".utf8).write(to: oldCaf)
        var reverted = custom
        reverted.sound = nil
        await sut.save(reverted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldCaf.path), "既定の音に戻すと旧 .caf を削除する")
        XCTAssertNil(sut.notice, "保存成功時は過去の notice を消す")
    }
}

/// 「曲を再生」ボタンからの再生の依頼（v0.7.3 Step4）。
final class AlarmPlayRequestTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "favecus-alarm-request-\(UUID().uuidString)")! }

    func testRequestIsTakenOnceAndThenGone() {
        let store = defaults()
        AlarmPlayRequest.set("abc", defaults: store)
        XCTAssertEqual(AlarmPlayRequest.take(defaults: store), "abc")
        XCTAssertNil(AlarmPlayRequest.take(defaults: store))
    }

    func testStaleRequestIsIgnoredAndCleared() {
        let store = defaults()
        let past = Date(timeIntervalSinceNow: -(AlarmPlayRequest.lifetime + 5))
        AlarmPlayRequest.set("old", now: past, defaults: store)
        XCTAssertNil(AlarmPlayRequest.take(defaults: store))
        XCTAssertNil(AlarmPlayRequest.take(defaults: store))
    }
}
