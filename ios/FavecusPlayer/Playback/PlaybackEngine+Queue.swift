import AVFoundation
import Combine
import Foundation
import UIKit

// 再生キューの操作・自動リスト・再生速度・検索。
// 本体（PlaybackEngine.swift）から分けたもの（動作は同じ）。
extension PlaybackEngine {
    // MARK: 再生キュー

    /// 再生キューの表示を、共通JSの再生順に合わせる。
    func refreshQueue() async {
        guard let text = try? await core.callAsync("QueueList", "{}"),
              let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any], object["error"] == nil,
              let ids = object["upcoming"] as? [String] else { return }
        upcoming = ids.compactMap { entry($0) }
    }

    /// シャッフルの切り替え（利用者の操作）。再生キューも、すぐに組み直す。
    func setShuffle(_ on: Bool) {
        guard shuffle != on else { return }
        shuffle = on
        guard var request = syncRequest() else { return }
        request["shuffle"] = on
        Task {
            _ = await queue("QueueSync", request)
            await refreshQueue()
        }
    }

    /// 再生キューの並べ替え：これから再生する曲の from 番目を to 番目へ。
    func moveQueued(from: Int, to: Int) async {
        let text = String(decoding: (try? JSONSerialization.data(withJSONObject: ["from": from, "to": to])) ?? Data(), as: UTF8.self)
        _ = try? await core.callAsync("QueueReorder", text)
        await refreshQueue()
    }

    /// 曲を持つリストのID（自動リスト・すべて、のときも、実際の所属を使う）。
    private func ownerListId(of item: EntryItem) -> String? {
        store.document?.playlists.first { $0.entries.contains { $0.id == item.id } }?.id
    }

    /// 「次に再生」（where: "next"）・「キューの最後に追加」（where: "end"）。再生していないときは、何もしない。
    @discardableResult
    func enqueue(_ item: EntryItem, listId: String, where position: String) async -> Bool {
        guard current != nil, canPlay(item) else { message = "再生中の曲があるときに使えます"; return false }
        let entry: [String: Any] = ["id": item.id, "playlistId": ownerListId(of: item) ?? listId, "title": item.title, "type": item.type]
        let request: [String: Any] = ["entry": entry, "where": position]
        guard let text = try? String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
              let reply = try? await core.callAsync("QueueInsert", text),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], object["error"] == nil else { return false }
        await refreshQueue()
        let ok = object["ok"] as? Bool ?? false
        message = ok ? (position == "end" ? "キューの最後に追加しました" : "次に再生します") : "追加できませんでした"
        return ok
    }

    /// 再生キューの曲を選んだ：その曲へ移る。
    func playQueued(_ id: String) async {
        guard let canPlayEntry = entry(id), canPlay(canPlayEntry) else { return }
        failureStreak = 0
        generation += 1
        let mine = generation
        guard let result = await queue("QueueJump", ["id": id]), let target = result.id, let playlistId = result.playlistId else { return }
        guard mine == generation else { return }
        await load(id: target, playlistId: playlistId)
    }

    /// 自動リスト（よく聴く曲・最近追加した曲・未再生）。選び方は共通JS（src/core/auto-lists.cjs。PC版と同じ）。ここは、曲のキーと再生回数を集めて渡すだけ。
    func autoLists() async -> AutoListsResult? {
        var seen = Set<String>(), unique: [EntryItem] = []
        for entry in (store.document?.playlists ?? []).flatMap(\.entries) where seen.insert(entry.id).inserted { unique.append(entry) }
        let keys = await countKeys(for: unique)
        var keyMap: [String: String] = [:]
        for (entry, key) in zip(unique, keys) { if let key { keyMap[entry.id] = key } }
        let countMap = await counts?.counts(for: Array(Set(keyMap.values))) ?? [:]
        let request: [String: Any] = ["text": store.currentText, "keys": keyMap, "counts": countMap, "favorites": Array(favorites.keys)]
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let reply = try? await core.callAsync("AutoLists", String(decoding: data, as: UTF8.self)),
              let result = try? JSONDecoder().decode(AutoListsResult.self, from: Data(reply.utf8)) else { return nil }
        return result
    }

    /// 再生速度を変える（決められた値のなかから）。再生中なら、すぐ反映する。
    func setSpeed(_ value: Double) {
        let next = PlaybackSpeed.nearest(value)
        speed = next
        backend.speed = Float(next)
        PlaybackSpeed.store(next)
        refresh()
    }

    /// 検索（PC版と同じ共通の規則：全角半角・大小・ひらがな/カタカナを同一視、空白区切りのAND、所属リストの経路も対象。50件ごと）。
    func search(query: String, page: Int) async -> LibrarySearchResult? {
        let request: [String: Any] = ["text": store.currentText, "query": query, "page": page]
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let reply = try? await core.callAsync("Search", String(decoding: data, as: UTF8.self)),
              let result = try? JSONDecoder().decode(LibrarySearchResult.self, from: Data(reply.utf8)) else { return nil }
        return result
    }
}
