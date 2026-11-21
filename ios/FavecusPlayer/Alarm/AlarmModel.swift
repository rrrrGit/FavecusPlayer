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
    /// 「ランダム」：保存済みの曲から、抽選で選ぶ（v0.7.4 H）。このとき sound は、いま抽選で選ばれている曲（最初の30秒）。
    var randomSound: Bool
    /// ランダムの抽選が対象にした、次に鳴る時刻。この時刻を過ぎたあと、アプリを開くと、次の曲を抽選し直す。
    var rolledFor: Date?

    init(id: UUID = UUID(), hour: Int, minute: Int, weekdays: Set<Int> = [], enabled: Bool = true, label: String = "", sound: AlarmSound? = nil, randomSound: Bool = false, rolledFor: Date? = nil) {
        self.id = id
        self.hour = hour
        self.minute = minute
        self.weekdays = weekdays
        self.enabled = enabled
        self.label = label
        self.sound = sound
        self.randomSound = randomSound
        self.rolledFor = rolledFor
    }

    enum CodingKeys: String, CodingKey { case id, hour, minute, weekdays, enabled, label, sound, randomSound, rolledFor }

    /// 古い保存（ランダムの項目がない）も読める（項目がなければ、ランダムなし）。
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        hour = try values.decode(Int.self, forKey: .hour)
        minute = try values.decode(Int.self, forKey: .minute)
        weekdays = try values.decode(Set<Int>.self, forKey: .weekdays)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        label = try values.decode(String.self, forKey: .label)
        sound = try values.decodeIfPresent(AlarmSound.self, forKey: .sound)
        randomSound = try values.decodeIfPresent(Bool.self, forKey: .randomSound) ?? false
        rolledFor = try values.decodeIfPresent(Date.self, forKey: .rolledFor)
    }

    /// 音を設定している（曲を選んだ、またはランダム）。
    var hasSound: Bool { sound != nil || randomSound }

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
