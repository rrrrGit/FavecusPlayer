import Foundation

// 再生履歴・自動リストの設定・再生統計（v0.7.4）。規則は共通JS（core/play-history.cjs・auto-list-settings.cjs・play-ledger.cjs の Stats。PC版と同じ）。
// この端末内だけに保存し、同期しない。Application Support/FavecusPlayer に、原子的に書く。

/// 自動リストの設定（件数・条件）。選択肢は、PC版・共通JS（auto-list-settings.cjs）と同じ。知らない値は、いちばん近い選択肢にする。
struct AutoListSettings: Codable, Equatable {
    static let limitChoices = [10, 20, 50, 100, 200, 500]
    static let frequentMinChoices = [1, 2, 3, 5, 10]
    static let recentDaysChoices = [0, 7, 30, 90, 365]
    static let kinds = ["frequent", "recent", "unplayed", "favorites", "history"]
    static let defaultLimits = ["frequent": 50, "recent": 50, "unplayed": 200, "favorites": 200, "history": 100]

    var limits: [String: Int] = AutoListSettings.defaultLimits
    var frequentMin = 1
    var recentDays = 0

    private static func nearest(_ choices: [Int], _ value: Int, fallback: Int) -> Int {
        choices.min { abs($0 - value) < abs($1 - value) } ?? fallback
    }

    func normalized() -> AutoListSettings {
        var result = AutoListSettings()
        for kind in Self.kinds { result.limits[kind] = Self.nearest(Self.limitChoices, limits[kind] ?? Self.defaultLimits[kind] ?? 50, fallback: Self.defaultLimits[kind] ?? 50) }
        result.frequentMin = Self.nearest(Self.frequentMinChoices, frequentMin, fallback: 1)
        result.recentDays = Self.nearest(Self.recentDaysChoices, recentDays, fallback: 0)
        return result
    }

    static func listName(_ kind: String) -> String {
        ["frequent": "よく聴く曲", "recent": "最近追加した曲", "unplayed": "未再生", "favorites": "お気に入り", "history": "最近聴いた曲"][kind] ?? kind
    }
}

@MainActor
final class AutoListSettingsStore: ObservableObject {
    private struct Document: Codable { var version: Int; var settings: AutoListSettings }
    @Published private(set) var settings = AutoListSettings()
    private let fileURL: URL

    init(directory: URL? = nil) {
        fileURL = (directory ?? FavoritesStore.defaultDirectory()).appendingPathComponent("auto-list-settings.json")
        if let data = try? Data(contentsOf: fileURL), let document = try? JSONDecoder().decode(Document.self, from: data), document.version == 1 {
            settings = document.settings.normalized()
        }
    }

    func set(_ next: AutoListSettings) {
        settings = next.normalized()
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Document(version: 1, settings: settings)) { try? data.write(to: fileURL, options: .atomic) }
    }
}

/// 再生履歴（最近聴いた曲）。数え方は、再生回数と同じ（実再生の3秒など）。新しいものが先頭・最大500件・同じ曲が1分以内に続いたら1回。
@MainActor
final class PlayHistoryStore {
    private let core: SharedCore
    private let fileURL: URL
    private var items: [[String: Any]] = []
    private var tail: Task<Void, Never> = Task {}

    init(core: SharedCore, directory: URL) {
        self.core = core
        fileURL = directory.appendingPathComponent("play-history.json")
        if let data = try? Data(contentsOf: fileURL), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], object["version"] as? Int == 1 {
            items = object["items"] as? [[String: Any]] ?? []
        }
    }

    /// 1回の再生を足す。順に1つずつ行う（await の間に、古い内容で上書きしないため）。
    func add(key: String) async {
        let previous = tail
        let mine = Task { @MainActor in
            await previous.value
            let request: [String: Any] = ["items": items, "key": key, "at": (Date().timeIntervalSince1970 * 1000).rounded()]
            guard let text = try? String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
                  let reply = try? await core.callAsync("HistoryAdd", text),
                  let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], let next = object["items"] as? [[String: Any]] else { return }
            items = next
            save()
        }
        tail = mine
        await mine.value
    }

    /// 最近聴いた曲のキー（新しい順。同じ曲は1つ）。
    func keys(limit: Int) async -> [String] {
        let request: [String: Any] = ["items": items, "limit": limit]
        guard let text = try? String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
              let reply = try? await core.callAsync("HistoryKeys", text),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any] else { return [] }
        return object["keys"] as? [String] ?? []
    }

    func clear() {
        items = []
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func save() {
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "items": items]) { try? data.write(to: fileURL, options: .atomic) }
    }
}

/// 再生統計の1行（曲名と回数）。
struct StatsSong: Equatable, Identifiable {
    let id = UUID()
    let title: String
    let count: Int
}

struct StatsMonth: Equatable, Identifiable {
    let month: String
    let plays: Int
    var id: String { month }
}

/// 再生統計（共通JSの LedgerStats ＝ PC版と同じ規則）。
struct PlayStats: Equatable {
    var total = 0
    var months: [StatsMonth] = []
    var top: [StatsSong] = []
    var thisMonthTop: [StatsSong] = []
}
