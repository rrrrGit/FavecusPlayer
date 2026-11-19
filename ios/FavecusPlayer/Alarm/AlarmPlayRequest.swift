import Foundation

/// アラームの「曲を再生」ボタンからの再生の依頼（アラームのID）。アプリが開いてから、受け取って再生する。
/// 古い依頼（2分より前）は、無視する。
enum AlarmPlayRequest {
    private static let key = "alarmPlayRequest"
    static let lifetime: TimeInterval = 120

    static func set(_ id: String, now: Date = Date(), defaults: UserDefaults = .standard) {
        defaults.set(["id": id, "at": now.timeIntervalSince1970], forKey: key)
    }

    /// 依頼を1回だけ受け取る（受け取ったら消す）。
    static func take(now: Date = Date(), defaults: UserDefaults = .standard) -> String? {
        defer { defaults.removeObject(forKey: key) }
        guard let value = defaults.dictionary(forKey: key), let id = value["id"] as? String, let at = value["at"] as? Double,
              now.timeIntervalSince1970 - at <= lifetime else { return nil }
        return id
    }
}
