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
        let mine = generation
        queueSyncSerial += 1
        let serial = queueSyncSerial
        guard syncRequest() != nil else { return }
        Task {
            let weights: [String: Double]? = on ? await shuffleWeights() : nil
            guard self.shuffle == on, mine == self.generation, serial == self.queueSyncSerial, var request = syncRequest() else { return }
            if let weights { request["weights"] = weights } else { request["weights"] = NSNull() }
            _ = await queue("QueueSync", request)
            guard self.shuffle == on, mine == self.generation, serial == self.queueSyncSerial else { return }
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

    /// 曲の終わりが近く、次の曲が、この端末で、すぐ鳴らせるとき（ローカル・保存済み）、次の曲を重ねて始める（設定の秒数。0ならしない）。
    func startCrossfadeIfDue() {
        let seconds = Crossfade.seconds(stored: UserDefaults.standard.integer(forKey: Crossfade.defaultsKey))
        // ローカルの曲どうしだけ（保存済みのBilibiliの曲は、読み込みの前に再生を止めるため、重ならない）。「この曲の終わりまで」のおやすみタイマー中は、いまの曲で止めるため、始めない
        guard seconds > 0, let current, !isPreparing, !videoMode, sleepTimer.mode != .endOfSong, let next = upcoming.first else { return }
        let ready = next.type == "local" && canPlay(next)
        guard Crossfade.shouldStart(seconds: seconds, position: position, duration: duration, isPlaying: isPlaying, repeatOne: repeatMode == .one, nextIsReady: ready, alreadyStarted: crossfadeStartedFor == current.entryId) else { return }
        crossfadeStartedFor = current.entryId
        crossfadePending = true
        Task {
            await advance(direction: 1, automatic: true)
        }
    }

    /// 「次に再生」（where: "next"）・「キューの最後に追加」（where: "end"）。再生していないときは、何もしない。
    @discardableResult
    func enqueue(_ item: EntryItem, listId: String, where position: String) async -> Bool {
        guard current != nil, canPlay(item) else { message = "再生中の曲があるときに使えます"; return false }
        if restoredPending { await prepareRestoredQueue() }
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
        crossfadePending = false
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
        let settings = autoSettings.settings
        var request: [String: Any] = ["text": store.currentText, "keys": keyMap, "counts": countMap, "favorites": Array(favorites.keys),
                                      "limits": settings.limits, "frequentMin": settings.frequentMin, "recentDays": settings.recentDays, "nowMs": (Date().timeIntervalSince1970 * 1000).rounded()]
        request["history"] = await history?.keys(limit: 500) ?? []
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let reply = try? await core.callAsync("AutoLists", String(decoding: data, as: UTF8.self)),
              let result = try? JSONDecoder().decode(AutoListsResult.self, from: Data(reply.utf8)) else { return nil }
        return result
    }

    /// 再生統計（月ごとの回数・よく聴いた曲）。曲名は、いまのライブラリから引く（なければ「ライブラリにない曲」）。
    func playStats() async -> PlayStats? {
        guard let raw = await counts?.stats() else { return nil }
        var seen = Set<String>(), unique: [EntryItem] = []
        for entry in (store.document?.playlists ?? []).flatMap(\.entries) where seen.insert(entry.id).inserted { unique.append(entry) }
        let keys = await countKeys(for: unique)
        var titles: [String: String] = [:]
        for (entry, key) in zip(unique, keys) { if let key, titles[key] == nil { titles[key] = entry.title.isEmpty ? "（無題）" : entry.title } }
        func songs(_ value: Any?) -> [StatsSong] {
            (value as? [[String: Any]] ?? []).compactMap { row in
                guard let key = row["key"] as? String, let count = row["count"] as? Int else { return nil }
                return StatsSong(title: titles[key] ?? "（ライブラリにない曲）", count: count)
            }
        }
        let time = playTime.stats(months: 12)
        let months = (raw["months"] as? [[String: Any]] ?? []).compactMap { row -> StatsMonth? in
            guard let month = row["month"] as? String, let plays = row["plays"] as? Int else { return nil }
            return StatsMonth(month: month, plays: plays, seconds: time.byMonth[month] ?? 0)
        }
        return PlayStats(total: raw["total"] as? Int ?? 0, totalSeconds: time.totalSeconds, months: months, top: songs(raw["top"]), thisMonthTop: songs(raw["thisMonthTop"]))
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
