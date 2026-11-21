import Foundation

/// 曲の並べ替え・絞り込みの選択（v0.7.4）。規則（段階・並べ替え・絞り込み）は、共通の ui/entry-view.js（PC版と同じ）。
/// この端末内だけに保存し、同期しない。Application Support/FavecusPlayer/list-views.json に、原子的に書く。
struct EntryViewSetting: Codable, Equatable {
    var sort = "manual"
    var favorite = "any"
    var saved = "any"
    var source = "any"
    var played = "any"

    static let sorts = ["manual", "title", "count-desc", "count-asc", "added-desc", "added-asc", "duration-desc", "duration-asc", "favorite-first"]
    static let favorites = ["any", "on", "off"]
    static let saveds = ["any", "saved", "unsaved"]
    static let sources = ["any", "bilibili", "local"]
    static let playeds = ["any", "played", "unplayed"]

    var isActive: Bool { self != EntryViewSetting() }

    /// 知らない値は、既定に戻す。
    func normalized() -> EntryViewSetting {
        var result = EntryViewSetting()
        if Self.sorts.contains(sort) { result.sort = sort }
        if Self.favorites.contains(favorite) { result.favorite = favorite }
        if Self.saveds.contains(saved) { result.saved = saved }
        if Self.sources.contains(source) { result.source = source }
        if Self.playeds.contains(played) { result.played = played }
        return result
    }

    static func label(sort value: String) -> String {
        ["manual": "保存した順", "title": "曲名", "count-desc": "再生回数が多い順", "count-asc": "再生回数が少ない順", "added-desc": "追加が新しい順", "added-asc": "追加が古い順",
         "duration-desc": "長い順", "duration-asc": "短い順", "favorite-first": "お気に入りを先に"][value] ?? value
    }
    static func label(favorite value: String) -> String { ["any": "すべて", "on": "お気に入りだけ", "off": "お気に入り以外"][value] ?? value }
    static func label(saved value: String) -> String { ["any": "すべて", "saved": "保存済みだけ", "unsaved": "未保存だけ"][value] ?? value }
    static func label(source value: String) -> String { ["any": "すべて", "bilibili": "Bilibiliだけ", "local": "ローカルだけ"][value] ?? value }
    static func label(played value: String) -> String { ["any": "すべて", "played": "再生したことがある", "unplayed": "未再生だけ"][value] ?? value }
}

@MainActor
final class ListViewStore: ObservableObject {
    static let maxLists = 2000
    private struct Document: Codable { var version: Int; var views: [String: EntryViewSetting] }

    @Published private(set) var views: [String: EntryViewSetting] = [:]
    private let fileURL: URL

    init(directory: URL? = nil) {
        fileURL = (directory ?? AtomicJsonFile.defaultDirectory()).appendingPathComponent("list-views.json")
        if let document = AtomicJsonFile.readOptional(Document.self, from: fileURL), document.version == 1 {
            for (id, view) in document.views.prefix(Self.maxLists) where id.count <= 80 && view.normalized().isActive { views[id] = view.normalized() }
        }
    }

    func view(for playlistId: String) -> EntryViewSetting? { views[playlistId] }

    /// 既定（並べ替えも絞り込みもなし）にしたときは、記録を消す。
    func set(_ view: EntryViewSetting, for playlistId: String) {
        let normalized = view.normalized()
        if normalized.isActive {
            guard views[playlistId] != nil || views.count < Self.maxLists else { return }
            views[playlistId] = normalized
        } else {
            views[playlistId] = nil
        }
        save()
    }

    private func save() {
        // 保存できなくても、この起動の間は使える
        try? AtomicJsonFile.write(Document(version: 1, views: views), to: fileURL)
    }
}

/// 並べ替え・絞り込みの選択か、リストの曲が変わったら、結果を取り直すための印。
struct ArrangeKey: Equatable {
    let view: EntryViewSetting?
    let entries: [EntryItem]
}
