import Foundation

/// お気に入り（v0.7.4 G）。お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくなる（重みの倍率は、共通JS：src/core/play-ledger.cjs の FAVORITE_BOOST）。
/// 規則は、PC版（src/core/favorites.cjs）と同じ：曲のメディアのキー単位（同じ動画・パートは共通）。この端末内だけに保存し、同期しない。
/// 正しくないキー・壊れた保存は、使わない。
@MainActor
final class FavoritesStore: ObservableObject {
    static let maxKeys = 20000
    @Published private(set) var keys: Set<String> = []
    private let defaults: UserDefaults
    private let storageKey = "favoriteKeys"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let list = defaults.array(forKey: storageKey) as? [String] {
            keys = Set(list.filter { Self.isValid($0) }.prefix(Self.maxKeys))
        }
    }

    nonisolated static func isValid(_ key: String) -> Bool {
        key.range(of: "^[A-Za-z0-9:._-]{1,200}$", options: .regularExpression) != nil
    }

    func contains(_ key: String?) -> Bool {
        guard let key else { return false }
        return keys.contains(key)
    }

    /// お気に入りにする／外す。キーが正しくない・上限を超える場合は、何も変えず false。
    @discardableResult
    func set(_ key: String?, _ value: Bool) -> Bool {
        guard let key, Self.isValid(key) else { return false }
        if value {
            guard keys.contains(key) || keys.count < Self.maxKeys else { return false }
            keys.insert(key)
        } else {
            keys.remove(key)
        }
        defaults.set(Array(keys), forKey: storageKey)
        return true
    }
}
