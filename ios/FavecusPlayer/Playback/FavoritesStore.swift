import Foundation

/// お気に入り（v0.7.4 G）。お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくなる（重みの倍率は、共通JS：src/core/play-ledger.cjs の FAVORITE_BOOST）。
/// 規則は、PC版（src/core/favorites.cjs）と同じ：曲のメディアのキー単位（同じ動画・パートは共通）。この端末内だけに保存し、同期しない。
/// 保存は Application Support/FavecusPlayer/favorites.json（原子的に書く）。以前の版の UserDefaults の保存は、初回だけ、ここへ移す。
/// 正しくないキー・壊れた保存は、使わない（壊れたファイルは、別名で残してから、空で始める）。
@MainActor
final class FavoritesStore: ObservableObject {
    static let maxKeys = 20000
    static let currentVersion = 1
    @Published private(set) var keys: Set<String> = []
    private let defaults: UserDefaults
    private let legacyKey = "favoriteKeys"
    private let fileURL: URL
    /// 直近の保存の失敗（なければ nil）。保存できなくても、メモリ上の状態では動く。
    private(set) var saveError: String?

    private struct Document: Codable { var version: Int; var keys: [String] }

    init(defaults: UserDefaults = .standard, directory: URL? = nil) {
        self.defaults = defaults
        let folder = directory ?? Self.defaultDirectory()
        fileURL = folder.appendingPathComponent("favorites.json")
        load()
    }

    static func defaultDirectory() -> URL {
        AtomicJsonFile.defaultDirectory()
    }

    nonisolated static func isValid(_ key: String) -> Bool {
        key.range(of: "^[A-Za-z0-9:._-]{1,200}$", options: .regularExpression) != nil
    }

    private func load() {
        if FileManager.default.fileExists(atPath: fileURL.path) {
            do {
                let document = try AtomicJsonFile.read(Document.self, from: fileURL)
                keys = Set(document.keys.filter { Self.isValid($0) }.prefix(Self.maxKeys))
            } catch {
                // 壊れた保存は、消さずに別名で残す
                try? FileManager.default.moveItem(at: fileURL, to: fileURL.deletingLastPathComponent().appendingPathComponent("favorites.broken-\(Int(Date().timeIntervalSince1970)).json"))
            }
            return
        }
        // 以前の版（UserDefaults）からの移行：書き込めたことを確かめてから、古い保存を消す
        if let list = defaults.array(forKey: legacyKey) as? [String] {
            keys = Set(list.filter { Self.isValid($0) }.prefix(Self.maxKeys))
            if save() { defaults.removeObject(forKey: legacyKey) }
        }
    }

    @discardableResult
    private func save() -> Bool {
        do {
            try AtomicJsonFile.write(Document(version: Self.currentVersion, keys: keys.sorted()), to: fileURL)
            saveError = nil
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
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
        save()
        return true
    }
}
