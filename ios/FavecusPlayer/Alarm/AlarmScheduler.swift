import Foundation
#if canImport(AlarmKit)
import ActivityKit
import AlarmKit
import SwiftUI
#endif

enum AlarmAuthorization: Equatable { case authorized, denied, unsupported }

/// 端末のアラーム予約。実体はAlarmKit（iOS 26以降）。テストでは差し替える。
protocol AlarmScheduling {
    func requestAuthorization() async -> AlarmAuthorization
    /// soundName：アラームの音のファイル名（Library/Sounds にあるもの）。nil なら既定の音。
    func schedule(_ item: AlarmItem, soundName: String?) async throws
    func cancel(id: UUID) async
    /// OS側に予約が残っているアラームのID（取得できないときは nil）。
    func scheduledIDs() async -> Set<UUID>?
}

/// iOS 26未満、またはAlarmKitのない環境。
struct UnsupportedAlarmScheduler: AlarmScheduling {
    func requestAuthorization() async -> AlarmAuthorization { .unsupported }
    func schedule(_ item: AlarmItem, soundName: String?) async throws { throw AlarmError.unsupported }
    func cancel(id: UUID) async {}
    func scheduledIDs() async -> Set<UUID>? { nil }
}

enum AlarmSchedulers {
    static func make() -> AlarmScheduling {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) { return AlarmKitScheduler() }
        #endif
        return UnsupportedAlarmScheduler()
    }
}

#if canImport(AlarmKit)
struct FavecusAlarmMetadata: AlarmMetadata {}

@available(iOS 26.0, *)
struct AlarmKitScheduler: AlarmScheduling {
    func requestAuthorization() async -> AlarmAuthorization {
        let manager = AlarmManager.shared
        switch manager.authorizationState {
        case .authorized: return .authorized
        case .denied: return .denied
        default:
            return (try? await manager.requestAuthorization()) == .authorized ? .authorized : .denied
        }
    }

    func schedule(_ item: AlarmItem, soundName: String?) async throws {
        guard item.isValid else { throw AlarmError.invalid }
        guard await requestAuthorization() == .authorized else { throw AlarmError.notAuthorized }
        let time = Alarm.Schedule.Relative.Time(hour: item.hour, minute: item.minute)
        let repeats: Alarm.Schedule.Relative.Recurrence = item.weekdays.isEmpty ? .never : .weekly(Self.weekdays(item.weekdays))
        let schedule = Alarm.Schedule.relative(.init(time: time, repeats: repeats))
        let title = item.label.isEmpty ? "アラーム" : item.label
        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), stopButton: AlarmButton(text: "停止", textColor: .white, systemImageName: "stop.circle"))
        let attributes = AlarmAttributes(presentation: AlarmPresentation(alert: alert), metadata: FavecusAlarmMetadata(), tintColor: .indigo)
        let configuration = AlarmManager.AlarmConfiguration.alarm(schedule: schedule, attributes: attributes, sound: soundName.map { AlertConfiguration.AlertSound.named($0) } ?? .default)
        // 同じIDの予約があれば、置き換える
        try? AlarmManager.shared.cancel(id: item.id)
        _ = try await AlarmManager.shared.schedule(id: item.id, configuration: configuration)
    }

    func cancel(id: UUID) async {
        try? AlarmManager.shared.cancel(id: id)
    }

    func scheduledIDs() async -> Set<UUID>? {
        guard let alarms = try? AlarmManager.shared.alarms else { return nil }
        return Set(alarms.map { $0.id })
    }

    static func weekdays(_ numbers: Set<Int>) -> [Locale.Weekday] {
        let all: [Int: Locale.Weekday] = [1: .sunday, 2: .monday, 3: .tuesday, 4: .wednesday, 5: .thursday, 6: .friday, 7: .saturday]
        return numbers.sorted().compactMap { all[$0] }
    }
}
#endif
