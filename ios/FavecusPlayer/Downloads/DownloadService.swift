import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Bilibiliの曲の保存（ダウンロード）とオンライン再生用の取得。
/// 配信先の決定は共通JS、通信はMediaDownloader（api.bilibili.com以外にCookieを付けない）、仕上げ・検証はMediaProcessor。
/// 保存の状態は DeviceMedia（同期しない・パスは同期データに含めない）。バックグラウンドでの継続は後の工程（この版は前面で動く）。
@MainActor
final class DownloadService: ObservableObject, MediaProvider {
    @Published private(set) var records: [String: DeviceMediaRecord] = [:]
    @Published private(set) var progress: [String: Double] = [:]
    @Published var message: String?

    private let catalog: DownloadCatalog
    private let bilibili: BilibiliService
    private let downloader: MediaDownloader
    private let core: SharedCore
    let directory: URL      // 保存したメディア（バックアップ対象外・初回ロック解除までの保護）
    let cacheDirectory: URL // オンライン再生用の一時ファイル（容量を超えたら古いものから消す）
    private var chain: Task<Void, Never>?
    private var running: [String: Task<Void, Never>] = [:]
    private static let cacheLimit: Int64 = 500 * 1024 * 1024

    init(catalog: DownloadCatalog, bilibili: BilibiliService, downloader: MediaDownloader, core: SharedCore, directory: URL, cacheDirectory: URL) {
        self.catalog = catalog
        self.bilibili = bilibili
        self.downloader = downloader
        self.core = core
        self.directory = directory
        self.cacheDirectory = cacheDirectory
    }

    // MARK: 開始

    /// 記録を読み込み、前回の途中で残った自分のステージングを片付ける。
    func start() async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var url = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true // 再取得できるため、バックアップ（iCloud）から外す
            try url.setResourceValues(values)
            for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] where name.hasPrefix(".dl-") {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
            }
            try await catalog.load()
            await publish()
        } catch {
            message = "保存の記録を読み込めません：\(error)"
        }
    }

    private func publish() async {
        records = Dictionary(uniqueKeysWithValues: await catalog.all().map { ($0.id, $0) })
    }

    // MARK: 参照

    /// 曲の同期用メディアキー（共通JS）。取得できない曲はnil。
    func key(for entry: EntryItem) async -> String? {
        guard entry.type == "bilibili", let url = entry.url else { return nil }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: ["entries": [["url": url]], "aliases": [Any]()]), as: UTF8.self)
            let response = try JSONSerialization.jsonObject(with: Data(try await core.callAsync("MediaKeys", request).utf8)) as? [String: Any]
            return (response?["keys"] as? [Any])?.first as? String
        } catch { return nil }
    }

    func record(key: String, kind: String = "audio") -> DeviceMediaRecord? { records["\(key)|\(kind)"] }

    /// 保存済み（完了）の音声ファイル。実体を確認してから返す。
    func savedFile(key: String, kind: String = "audio") -> URL? {
        guard let record = record(key: key, kind: kind), record.state == .completed, let name = record.fileName else { return nil }
        let url = directory.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: 保存

    /// kind：audio（既定）または video。同じキー・形式が進行中なら、重ねて始めない。
    func save(entry: EntryItem, kind: String = "audio") {
        guard entry.type == "bilibili", let url = entry.url else { return }
        let previous = chain
        let task = Task { [weak self] in
            await previous?.value
            guard let self, let key = await self.key(for: entry) else { return }
            if let existing = self.record(key: key, kind: kind), existing.state.inProgress || (existing.state == .completed && self.savedFile(key: key, kind: kind) != nil) { return }
            let task = Task { await self.run(key: key, kind: kind, url: url, title: entry.title) }
            self.running["\(key)|\(kind)"] = task
            await task.value
            self.running["\(key)|\(kind)"] = nil
        }
        chain = task
    }

    func cancel(key: String, kind: String = "audio") { running["\(key)|\(kind)"]?.cancel() }

    /// 保存を削除する（この記録が持つファイルだけ。他の記録が参照するファイルは消さない）。曲そのものは消えない。
    func remove(key: String, kind: String = "audio") async {
        guard let record = record(key: key, kind: kind), !record.state.inProgress else { return }
        if let name = record.fileName, !(await catalog.isReferenced(fileName: name, except: record.id)) { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        try? await catalog.remove(key: key, kind: kind)
        await publish()
    }

    private func update(_ record: DeviceMediaRecord) async {
        try? await catalog.upsert(record)
        await publish()
    }

    private func run(key: String, kind: String, url: String, title: String) async {
        let id = "\(key)|\(kind)"
        var record = DeviceMediaRecord(key: key, kind: kind, state: .preparing)
        await update(record)
        let staging = directory.appendingPathComponent(".dl-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        #if canImport(UIKit)
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask(withName: "favecus-download") { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        #endif
        do {
            let media = try await bilibili.resolve(url: url, kind: kind)
            try Task.checkCancellation()
            let expected = media.streams.reduce(0) { $0 + $1.size }
            try Self.ensureSpace(for: Int64(expected), at: directory)
            record.state = .downloading
            record.quality = media.height ?? 0
            await update(record)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            let files = try await downloader.download(streams: media.streams, into: staging) { [weak self] value in
                Task { @MainActor in self?.progress[id] = value }
            }
            try Task.checkCancellation()
            record.state = .processing
            await update(record)
            let name = "\(UUID().uuidString.lowercased()).\(kind == "video" ? "mp4" : "m4a")"
            let output = staging.appendingPathComponent(name)
            record.state = .validating
            await update(record)
            let duration: Double
            if kind == "video", files.count == 2 {
                do { duration = try await MediaProcessor.mergeVideo(video: files[0], audio: files[1], output: output, expectedDuration: media.duration) }
                catch {
                    // 結合に失敗：音声だけの保存は残せるよう、音声の取得済みファイルを使う（映像の保存は失敗として記録する）
                    if self.record(key: key, kind: "audio")?.state != .completed { await self.saveAudioFallback(key: key, audioFile: files[1], media: media, staging: staging) }
                    throw error
                }
            } else {
                duration = try await MediaProcessor.finalizeAudio(input: files[0], output: output, expectedDuration: media.duration)
            }
            try Task.checkCancellation() // 仕上げの間に取り消されたら、完了にしない
            let destination = directory.appendingPathComponent(name)
            try FileManager.default.moveItem(at: output, to: destination)
            record.state = .completed
            record.fileName = name
            record.duration = duration
            record.bytes = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
            record.message = nil
            progress[id] = nil
            await update(record)
        } catch {
            progress[id] = nil
            if error is CancellationError || (error as? DownloadError).map({ if case .cancelled = $0 { return true } else { return false } }) == true {
                record.state = .cancelled
                record.message = "取り消しました。"
            } else {
                record.state = .failed
                // 記録（downloads.json）には、署名つきの配信URLを含みうる通信エラーの詳細を残さない。
                if let urlError = error as? URLError { record.message = "通信に失敗しました（(urlError.code.rawValue)）。" }
                else { record.message = (error as? CustomStringConvertible)?.description ?? "保存に失敗しました。" }
            }
            record.fileName = nil
            await update(record)
        }
    }

    private func saveAudioFallback(key: String, audioFile: URL, media: ResolvedMedia, staging: URL) async {
        let name = "\(UUID().uuidString.lowercased()).m4a"
        let output = staging.appendingPathComponent(name)
        guard let duration = try? await MediaProcessor.finalizeAudio(input: audioFile, output: output, expectedDuration: media.duration) else { return }
        let destination = directory.appendingPathComponent(name)
        guard (try? FileManager.default.moveItem(at: output, to: destination)) != nil else { return }
        var record = DeviceMediaRecord(key: key, kind: "audio", state: .completed)
        record.fileName = name
        record.duration = duration
        record.bytes = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
        await update(record)
    }

    static func ensureSpace(for bytes: Int64, at url: URL) throws {
        guard bytes > 0 else { return }
        let available = (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? Int64.max
        if available < bytes + bytes / 5 + 100 * 1024 * 1024 { throw DownloadError.message("空き容量が足りません。不要なデータを消してから、もう一度お試しください。") }
    }

    // MARK: オンライン再生

    /// 再生に使う音声ファイル。保存済みならそれ、なければ一時ファイルへ取得する（オンライン再生）。取得できなければ、理由つきで失敗する（再試行や回避はしない）。
    func playableFile(for entry: EntryItem) async throws -> URL {
        guard let key = await key(for: entry), let url = entry.url else { throw DownloadError.message("この曲の情報を確認できません。") }
        if let saved = savedFile(key: key) { return saved }
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
        try Self.ensureSpace(for: Int64(media.streams.reduce(0) { $0 + $1.size }), at: cacheDirectory)
        let files = try await downloader.download(streams: media.streams, into: staging) { _ in }
        guard let first = files.first else { throw DownloadError.message("配信先から取得できません。") }
        let output = staging.appendingPathComponent(name)
        _ = try await MediaProcessor.finalizeAudio(input: first, output: output, expectedDuration: media.duration)
        if FileManager.default.fileExists(atPath: cached.path) { try? FileManager.default.removeItem(at: cached) }
        try FileManager.default.moveItem(at: output, to: cached)
        trimCache(keeping: cached)
        return cached
    }

    /// 一時ファイルが上限を超えたら、古いものから消す（いま再生するもの・自分のキャッシュだけ）。
    private func trimCache(keeping: URL) {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: cacheDirectory.path) else { return }
        var items: [(url: URL, date: Date, size: Int64)] = names.filter { !$0.hasPrefix(".") }.compactMap { name in
            let url = cacheDirectory.appendingPathComponent(name)
            guard let attributes = try? manager.attributesOfItem(atPath: url.path) else { return nil }
            return (url, (attributes[.modificationDate] as? Date) ?? .distantPast, (attributes[.size] as? NSNumber)?.int64Value ?? 0)
        }
        items.sort { $0.date < $1.date }
        var total = items.reduce(0) { $0 + $1.size }
        for item in items where total > Self.cacheLimit && item.url != keeping {
            try? manager.removeItem(at: item.url)
            total -= item.size
        }
    }
}
