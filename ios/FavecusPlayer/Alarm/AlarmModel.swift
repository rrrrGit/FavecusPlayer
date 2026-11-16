import Foundation

/// アラームの音に使う曲と範囲。曲は登録曲のメディアキー（ファイルパスは使わない）、範囲は秒で持つ。
struct AlarmSound: Codable, Equatable {
    /// 保存済みの曲のメディアキー（例：bili:BV…:p1、local:…）。
    var mediaKey: String
    var startSeconds: Double
    var durationSeconds: Double

    /// 音声ファイルにする長さの上限（AlarmKitの条件は未確認のため、確認できるまで30秒に切る）。
    static let maxDuration: Double = 30
    static let minDuration: Double = 1

    /// 範囲を、有効な値に直す（開始は0以上、長さは1〜上限秒）。
    func normalized() -> AlarmSound {
        let start = startSeconds.isFinite ? max(0, startSeconds) : 0
        let length = durationSeconds.isFinite ? min(Self.maxDuration, max(Self.minDuration, durationSeconds)) : Self.maxDuration
        return AlarmSound(mediaKey: mediaKey, startSeconds: start, durationSeconds: length)
    }
}

/// 端末内のアラーム1件。曜日は Calendar の番号（1＝日曜〜7＝土曜）。空なら、繰り返しなし（次の1回だけ）。
struct AlarmItem: Codable, Equatable, Identifiable {
    var id: UUID
    var hour: Int
    var minute: Int
    var weekdays: Set<Int>
    var enabled: Bool
    var label: String
    var sound: AlarmSound?

    init(id: UUID = UUID(), hour: Int, minute: Int, weekdays: Set<Int> = [], enabled: Bool = true, label: String = "", sound: AlarmSound? = nil) {
        self.id = id
        self.hour = hour
        self.minute = minute
        self.weekdays = weekdays
        self.enabled = enabled
        self.label = label
        self.sound = sound
    }

    var isValid: Bool {
        (0...23).contains(hour) && (0...59).contains(minute) && weekdays.allSatisfy { (1...7).contains($0) }
    }

    /// 次に鳴る時刻（表示用。繰り返しなしは、次に来るその時刻）。
    func nextFireDate(after now: Date, calendar: Calendar = .current) -> Date? {
        guard isValid else { return nil }
        var best: Date?
        let days: [Int?] = weekdays.isEmpty ? [nil] : weekdays.sorted().map { Optional($0) }
        for day in days {
            var parts = DateComponents(hour: hour, minute: minute, second: 0)
            if let day { parts.weekday = day }
            if let date = calendar.nextDate(after: now, matching: parts, matchingPolicy: .nextTime), best == nil || date < best! { best = date }
        }
        return best
    }
}
