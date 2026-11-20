import Foundation
import UIKit

// 画質の選択・オフライン用データの削除と、オンライン再生用のキャッシュ。
// 本体（DownloadService.swift）から分けたもの（動作は同じ）。
extension DownloadService {
    // MARK: 画質・オフライン用データの削除

    /// 動画の画質（高さ）の選択肢と、既定の選択（設定・保存の画面で選ぶ。選んだ画質がない動画は、共通処理が近い画質を選ぶ）。
    nonisolated static let heightChoices = [360, 720, 1080]
    nonisolated static var preferredHeight: Int {
        let value = UserDefaults.standard.integer(forKey: "downloadVideoHeight")
        return heightChoices.contains(value) ? value : 720
    }

    /// 保存したオフライン用データ（音声・動画のファイル）をすべて削除する。曲・プレイリスト・同一性は消さない。
    /// 保存中のものがあるときは何もしない（nil）。削除するのは、保存の記録が指すファイルだけ（アプリが管理していないファイルには触れない）。
    /// ファイルを先に消し、消せなかったものの記録は残す。戻り値：削除した件数と容量。
    func removeAllOffline() async -> (count: Int, bytes: Int64)? {
        guard started, !removingAll, !records.values.contains(where: { $0.state.inProgress }) else { return nil }
        removingAll = true // 削除の間に、同じ曲の保存を始めない
        defer { removingAll = false }
        var removedIds: [String] = []
        var bytes: Int64 = 0
        for record in records.values where record.state == .completed {
            guard let name = record.fileName, !name.isEmpty, name == (name as NSString).lastPathComponent, !name.hasPrefix(".") else { continue }
            let url = directory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) {
                guard (try? FileManager.default.removeItem(at: url)) != nil else { continue }
                bytes += record.bytes
            }
            removedIds.append(record.id)
        }
        do { try await catalog.removeRecords(ids: removedIds) } catch { message = "保存の記録を整理できません：\(ErrorText.safe(error))" }
        await publish()
        return (removedIds.count, bytes)
    }

    /// プレイリスト単位の削除の対象：このリストの曲のうち、保存済みで、ほかのリストの曲が使っていないもの（記録のキー）。
    /// 同じ動画をほかのリストにも登録しているときは、そのリストの曲の保存を消さないため、対象に含めない。
    nonisolated static func exclusiveKeys(target: [EntryItem], all: [EntryItem], keyOf: (EntryItem) -> String?) -> (keys: [String], shared: Int) {
        let targetIds = Set(target.map(\.id))
        let others = Set(all.filter { !targetIds.contains($0.id) }.compactMap(keyOf))
        var seen = Set<String>(), exclusive: [String] = [], shared = 0
        for entry in target where entry.type == "bilibili" {
            guard let key = keyOf(entry), seen.insert(key).inserted else { continue }
            if others.contains(key) { shared += 1 } else { exclusive.append(key) }
        }
        return (exclusive, shared)
    }

    /// 指定した動画（キー）の保存済みの音声・動画を削除する。保存中のものは削除しない。曲・プレイリストは消さない。戻り値：削除した件数と容量。
    func removeOffline(keys: [String]) async -> (count: Int, bytes: Int64) {
        guard started, !removingAll else { return (0, 0) }
        removingAll = true
        defer { removingAll = false }
        var count = 0
        var bytes: Int64 = 0
        for key in keys {
            for kind in ["audio", "video"] {
                guard let record = record(key: key, kind: kind), record.state == .completed else { continue }
                bytes += record.bytes
                await remove(key: key, kind: kind)
                count += 1
            }
        }
        return (count, bytes)
    }

    /// このキーの保存済みの件数と容量（削除の確認の表示用）。
    func savedSummary(keys: [String]) -> (count: Int, bytes: Int64) {
        var count = 0
        var bytes: Int64 = 0
        for key in keys {
            for kind in ["audio", "video"] {
                if let record = record(key: key, kind: kind), record.state == .completed { count += 1; bytes += record.bytes }
            }
        }
        return (count, bytes)

    // MARK: オンライン再生

    /// 再生に使う音声ファイル。保存済みならそれ、なければ一時ファイルへ取得する（オンライン再生）。同じ曲の取得が重なったら、1つにまとめる。取得できなければ、理由つきで失敗する（再試行や回避はしない）。
    /// 音声を保存していなくても、動画を保存済みなら、その音声を使う（動画だけを保存した曲が、オフラインで再生できないのを防ぐ）。
    func playableFile(for entry: EntryItem) async throws -> URL {
        guard let key = await key(for: entry), let url = entry.url else { throw DownloadError.message("この曲の情報を確認できません。") }
        if let saved = savedFile(key: key) ?? savedFile(key: key, kind: "video") { return saved }
        if let existing = fetching[key] { return try await existing.value }
        let task = Task { try await self.fetchOnline(key: key, url: url) }
        fetching[key] = task
        defer { fetching[key] = nil }
        let file = try await task.value
        served = Array((served.filter { $0 != file } + [file]).suffix(3))
        return file
    }

    private func fetchOnline(key: String, url: String) async throws -> URL {
        try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        let name = key.replacingOccurrences(of: ":", with: "_") + ".m4a"
        let cached = cacheDirectory.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: cached.path), (try? await MediaProcessor.validate(file: cached, needsVideo: false, expectedDuration: 0)) != nil {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: cached.path)
            return cached
        }
        let staging = cacheDirectory.appendingPathComponent(".dl-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        let media = try await bilibili.resolve(url: url, kind: "audio")
        Task { if await self.ensureFrame(key: key, url: url, coverURL: media.thumbnailURL) { self.batchStopped = true } }
        try Self.ensureSpace(for: Int64(media.streams.reduce(0) { $0 + $1.size }), at: cacheDirectory)
        let files = try await downloader.download(streams: media.streams, into: staging) { _ in }
        guard let first = files.first else { throw DownloadError.message("配信先から取得できません。") }
        let output = staging.appendingPathComponent(name)
        _ = try await MediaProcessor.finalizeAudio(input: first, output: output, expectedDuration: media.duration)
        // 再生中のファイルを置き換えない：再生に渡している最中のものは、新しい名前で置く代わりに、そのまま使う
        if FileManager.default.fileExists(atPath: cached.path) {
            if served.contains(cached) { return cached }
            try? FileManager.default.removeItem(at: cached)
        }
        try FileManager.default.moveItem(at: output, to: cached)
        trimCache(keeping: [cached] + served)
        return cached
    }

    /// 一時ファイルが上限を超えたら、古いものから消す（いま取得したもの・直近に再生へ渡したものは消さない。自分のキャッシュだけ）。
    private func trimCache(keeping: [URL]) {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: cacheDirectory.path) else { return }
        var items: [(url: URL, date: Date, size: Int64)] = names.filter { !$0.hasPrefix(".") }.compactMap { name in
            let url = cacheDirectory.appendingPathComponent(name)
            guard let attributes = try? manager.attributesOfItem(atPath: url.path) else { return nil }
            return (url, (attributes[.modificationDate] as? Date) ?? .distantPast, (attributes[.size] as? NSNumber)?.int64Value ?? 0)
        }
        items.sort { $0.date < $1.date }
        var total = items.reduce(0) { $0 + $1.size }
        for item in items where total > Self.cacheLimit && !keeping.contains(item.url) {
            try? manager.removeItem(at: item.url)
            total -= item.size
        }
    }
}
