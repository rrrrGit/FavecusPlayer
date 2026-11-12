import Foundation

/// 仮の最小画面用の情報。Step15でユーザーのUI案に沿って置き換える。
enum AppInfo {
    static let name = "FavecusPlayer"
    static let stage = "v0.7.0 ビルド基盤の検証"

    static var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return "\(name) \(version)"
    }
}
