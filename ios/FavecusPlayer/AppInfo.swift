import Foundation

/// 画面に出すアプリの情報。
enum AppInfo {
    static let name = "FavecusPlayer"
    static let stage = "v0.7.2 開発版"

    static var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return "\(name) \(version)"
    }
}
