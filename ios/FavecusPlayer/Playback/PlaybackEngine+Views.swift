import Foundation

// 曲の並べ替え・絞り込み（共通JSの ArrangeEntries ＝ ui/entry-view.js。PC版と同じ規則）。表示と、再生順の両方に使う。
// 本体（PlaybackEngine.swift）から分けたもの。
extension PlaybackEngine {
    /// 選んだ曲を、まとめて、お気に入りにする・外す（曲のメディア単位。キーが分からない曲は、飛ばす）。戻り値：変えた曲の数。
    @discardableResult
    func setFavorites(entries: [EntryItem], _ value: Bool) async -> Int {
        let keys = await countKeys(for: entries)
        var changed = 0
        for key in Set(keys.compactMap { $0 }) where favorites.set(key, value) { changed += 1 }
        favoriteRevision += 1
        message = changed > 0 ? (value ? "お気に入りにしました" : "お気に入りから外しました") : "お気に入りにできる曲がありませんでした"
        return changed
    }

    /// リストの曲（子のリストの曲も含む。親→子の順）。
    func entriesInScope(_ scope: String) -> [EntryItem] {
        guard let document = store.document else { return [] }
        var seen = Set<String>(), result: [EntryItem] = []
        func visit(_ id: String) {
            guard seen.insert(id).inserted, let list = document.playlist(id) else { return }
            result.append(contentsOf: list.entries)
            for child in list.childIds { visit(child) }
        }
        if scope == "*" { for id in document.rootPlaylistIds { visit(id) } } else { visit(scope) }
        return result
    }

    /// そのリストの再生順の曲のID（選んだ並べ替え・絞り込みの結果）。
    func arrangedIds(scope: String, view: EntryViewSetting) async -> [String]? {
        await arrangedIds(forEntries: entriesInScope(scope), view: view)
    }

    /// 曲の並びを、並べ替え・絞り込みした結果のID。共通JSが返せなかったときは nil（保存した順のまま）。
    func arrangedIds(forEntries entries: [EntryItem], view: EntryViewSetting) async -> [String]? {
        let keys = await countKeys(for: entries)
        let counts = await counts?.counts(for: Array(Set(keys.compactMap { $0 }))) ?? [:]
        let items: [[String: Any]] = zip(entries, keys).map { entry, key in
            var item: [String: Any] = ["id": entry.id, "title": entry.title, "type": entry.type, "count": key.flatMap { counts[$0] } ?? 0,
                                       "favorite": favorites.contains(key), "saved": entry.type == "local" || (provider?.isSaved(entry) ?? false)]
            if let videoId = entry.videoId { item["videoId"] = videoId }
            if let addedAt = entry.addedAt { item["addedAt"] = addedAt }
            if let duration = entry.duration { item["duration"] = duration }
            return item
        }
        let viewJSON: [String: Any] = ["sort": view.sort, "favorite": view.favorite, "saved": view.saved, "source": view.source, "played": view.played]
        let request: [String: Any] = ["items": items, "view": viewJSON]
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let reply = try? await core.callAsync("ArrangeEntries", String(decoding: data, as: UTF8.self)),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], object["error"] == nil,
              let ids = object["ids"] as? [String] else { return nil }
        return ids
    }
}
