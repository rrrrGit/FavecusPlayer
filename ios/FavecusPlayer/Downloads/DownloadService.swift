import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Bilibiliの曲の保存（ダウンロード）とオンライン再生用の取得。
/// 配信先の決定は共通JS、取得は BackgroundTransfers（背面・画面ロック中も続く。api.bilibili.com 以外にCookieを付けない）、仕上げ・検証は MediaProcessor。
/// 保存の状態は DeviceMedia（同期しない・パスは同期データに含めない）。取得中のジョブはファイルとして残し、再起動後は、実際のファイルと通信中のタスクから状態を決める。
@MainActor
final class DownloadService: ObservableObject, MediaProvider {
    @Published private(set) var records: [String: DeviceMediaRecord] = [:]
    @Published private(set) var progress: [String: Double] = [:]
    @Published var message: String?
    /// 曲ID → 同期用メディアキー（Bilibiliの曲）。一覧の表示（保存の状態・サムネイル）で使う。
    @Published private(set) var entryKeys: [String: String] = [:]
    /// サムネイルの取得（配信先を取得できたときに1回だけ）。
    var artwork: ArtworkStore?

    private let catalog: DownloadCatalog
    private let bilibili: BilibiliService
    private let downloader: MediaDownloader
    private let transfers: BackgroundTransfers
    private let core: SharedCore
    let directory: URL      // 保存したメディア（バックアップ対象外・初回ロック解除までの保護）
    let cacheDirectory: URL // オンライン再生用の一時ファイル（容量を超えたら古いものから消す）
    private var chain: Task<Void, Never>?
    private var running: [String: Task<Void, Never>] = [:]
    private var finishing: Set<String> = []       // 仕上げ中のジョブID（重ねて仕上げない）
    private var cancelRequested: Set<String> = [] // 仕上げ中に取り消された記録ID
    private var started = false                  // 記録を読み込み終えるまで、取得の結果を処理しない（読み込み前に仕上げて、記録を失わないため）
    private var jobRecords: [String: String] = [:] // ジョブID → 記録ID（進み具合の表示用）
    private var fetching: [String: Task<URL, Error>] = [:]
    private var served: [URL] = []                // 直近に再生へ渡した一時ファイル（容量の整理で消さない）
    private static let cacheLimit: Int64 = 500 * 1024 * 1024

    init(catalog: DownloadCatalog, bilibili: BilibiliService, downloader: MediaDownloader, transfers: BackgroundTransfers, core: SharedCore, directory: URL, cacheDirectory: URL) {
        self.catalog = catalog
        self.bilibili = bilibili
        self.downloader = downloader
        self.transfers = transfers
        self.core = core
        self.directory = directory
        self.cacheDirectory = cacheDirectory
        transfers.onChange = { [weak self] id in Task { @MainActor in await self?.evaluate(id) } }
        transfers.onProgress = { [weak self] id, value in Task { @MainActor in self?.setProgress(jobId: id, value) } }
    }

    // MARK: 開始

    /// 記録を読み込み、前回から続いている取得を引き継ぐ（取得できたファイルが揃っていれば仕上げ、通信中ならそのまま待つ、どちらでもなければ失敗にする）。
    func start() async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var url = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true // 再取得できるため、バックアップ（iCloud）から外す
            try url.setResourceValues(values)
            let jobs = transfers.jobs()
            let live = await transfers.liveJobIds()
            let owned = Set(jobs.map { ".dl-\($0.id)" })
            // 持ち主のいない作業フォルダだけを片付ける（続いているジョブのフォルダは残す）
            for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] where name.hasPrefix(".dl-") && !owned.contains(name) {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
            }
            // 起動直後に始まったオンライン再生の作業フォルダを消さないよう、古いものだけを片付ける
            for name in (try? FileManager.default.contentsOfDirectory(atPath: cacheDirectory.path)) ?? [] where name.hasPrefix(".dl-") {
                let target = cacheDirectory.appendingPathComponent(name)
                let modified = (try? FileManager.default.attributesOfItem(atPath: target.path)[.modificationDate] as? Date) ?? .distantPast
                if Date().timeIntervalSince(modified) > 3600 { try? FileManager.default.removeItem(at: target) }
            }
            try await catalog.load(keeping: Set(jobs.map { $0.recordId }))
            await publish()
            for job in jobs { jobRecords[job.id] = job.recordId }
            started = true
            for job in jobs { await evaluate(job.id, live: live) }
        } catch {
            message = "保存の記録を読み込めません：\(error)"
        }
    }

    /// 前面へ戻ったとき：取得が終わっているジョブ、仕上げが途中で止まったジョブを続ける。
    func resume() async {
        guard started else { return }
        for job in transfers.jobs() { await evaluate(job.id) }
    }

    private func publish() async {
        records = Dictionary(uniqueKeysWithValues: await catalog.all().map { ($0.id, $0) })
    }

    private func setProgress(jobId: String, _ value: Double) {
        guard let id = jobRecords[jobId] else { return }
        progress[id] = value
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

    /// 一覧の曲のキーを、共通JSで1回にまとめて求める。
    func refreshKeys(entries: [EntryItem]) async {
        let targets = entries.filter { $0.type == "bilibili" && $0.url != nil }
        guard !targets.isEmpty else { if !entryKeys.isEmpty { entryKeys = [:] }; return }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: ["entries": targets.map { ["url": $0.url ?? ""] }, "aliases": [Any]()]), as: UTF8.self)
            guard let response = try JSONSerialization.jsonObject(with: Data(try await core.callAsync("MediaKeys", request).utf8)) as? [String: Any], let keys = response["keys"] as? [Any], keys.count == targets.count else { return }
            var result: [String: String] = [:]
            for (entry, key) in zip(targets, keys) { if let key = key as? String { result[entry.id] = key } }
            if result != entryKeys { entryKeys = result }
        } catch {}
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
            let task = Task { await self.begin(key: key, kind: kind, url: url, title: entry.title) }
            self.running["\(key)|\(kind)"] = task
            await task.value
            self.running["\(key)|\(kind)"] = nil
        }
        chain = task
    }

    /// 取り消す。準備中は処理を止め、取得中は通信を止めて作業を消し、仕上げ中は、区切りで止める。
    func cancel(key: String, kind: String = "audio") {
        let id = "\(key)|\(kind)"
        running[id]?.cancel()
        guard let job = transfers.jobs().first(where: { $0.key == key && $0.kind == kind }) else {
            // 通信もジョブもないのに「保存中」のまま残った記録は、取り消しで解消できる
            if running[id] == nil, let record = record(key: key, kind: kind), record.state.inProgress {
                var next = record
                next.state = .cancelled
                next.message = "取り消しました。"
                Task { await self.update(next) }
            }
            return
        }
        if finishing.contains(job.id) { cancelRequested.insert(id); return }
        Task { await self.abort(job, message: "取り消しました。", state: .cancelled) }
    }

    /// 保存を削除する（この記録が持つファイルだけ。他の記録が参照するファイルは消さない）。曲そのものは消えない。
    func remove(key: String, kind: String = "audio") async {
        guard let record = record(key: key, kind: kind), !record.state.inProgress else { return }
        if let name = record.fileName, !(await catalog.isReferenced(fileName: name, except: record.id)) { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        try? await catalog.remove(key: key, kind: kind)
        await publish()
    }

    private func update(_ record: DeviceMediaRecord) async {
        _ = await save(record)
    }

    private func save(_ record: DeviceMediaRecord) async -> Bool {
        var saved = true
        do { try await catalog.upsert(record) } catch { saved = false; message = "保存の記録を書き込めません：\(error)" }
        await publish()
        return saved
    }

    /// 準備：配信先を決め、空き容量を確認し、取得（背面でも続く）を始める。ここで失敗したものは、失敗として記録する。
    private func begin(key: String, kind: String, url: String, title: String) async {
        let id = "\(key)|\(kind)"
        var record = DeviceMediaRecord(key: key, kind: kind, state: .preparing)
        await update(record)
        #if canImport(UIKit)
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask(withName: "favecus-download-prepare") { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        #endif
        var job: DownloadJob?
        do {
            let media = try await bilibili.resolve(url: url, kind: kind)
            try Task.checkCancellation()
            if let artwork { Task { await artwork.fetch(key: key, urlString: media.thumbnailURL) } }
            guard media.layout == "dash" || media.layout == "muxed" else { throw DownloadError.message("この形式（分割された配信）は、保存に対応していません。") }
            let expected = media.streams.reduce(0) { $0 + $1.size }
            try Self.ensureSpace(for: Int64(expected), at: directory)
            record.state = .downloading
            record.quality = media.height ?? 0
            await update(record)
            let streams = media.streams.enumerated().map { index, stream in
                JobStream(urls: stream.urls, size: stream.size, ext: media.layout == "dash" && media.streams.count == 2 && index == 1 ? "m4a" : "mp4")
            }
            try Task.checkCancellation() // ここから先は、ジョブを作って取得を始める
            let made = DownloadJob(id: UUID().uuidString.lowercased(), key: key, kind: kind, title: title, quality: media.height ?? 0, duration: media.duration, layout: media.layout, streams: streams, createdAt: Date().timeIntervalSince1970)
            job = made
            jobRecords[made.id] = made.recordId
            try transfers.start(made)
        } catch {
            if let job { await transfers.cancel(job.id); transfers.remove(job.id) }
            progress[id] = nil
            if error is CancellationError || (error as? DownloadError)?.isCancelled == true {
                record.state = .cancelled
                record.message = "取り消しました。"
            } else {
                record.state = .failed
                record.message = Self.describe(error)
            }
            record.fileName = nil
            await update(record)
        }
    }

    /// 取得の状態を見て、失敗なら止め、揃っていれば仕上げる。通信中なら何もしない（live が分かるとき＝起動直後は、通信も作業もないジョブを失敗にする）。
    private func evaluate(_ id: String, live: Set<String>? = nil) async {
        guard started, !finishing.contains(id), let job = transfers.job(id) else { return }
        let statuses = transfers.status(of: job)
        if let failed = statuses.compactMap({ status -> String? in if case .failed(let text, _) = status { return text } else { return nil } }).first {
            await abort(job, message: failed, state: .failed)
            return
        }
        if statuses.allSatisfy({ if case .done = $0 { return true } else { return false } }) {
            finishing.insert(id)
            await finish(job, files: statuses.compactMap { if case .done(let url) = $0 { return url } else { return nil } })
            finishing.remove(id)
            return
        }
        if let live, !live.contains(id) {
            await abort(job, message: "中断されました。もう一度保存してください。", state: .failed)
        }
    }

    /// 失敗・取り消し：通信を止め、作業を消し、記録を更新する。
    private func abort(_ job: DownloadJob, message: String, state: DeviceMediaState) async {
        guard !finishing.contains(job.id) else { return }
        finishing.insert(job.id)
        cancelRequested.remove(job.recordId)
        await transfers.cancel(job.id)
        transfers.remove(job.id)
        var record = DeviceMediaRecord(key: job.key, kind: job.kind, state: state)
        record.quality = job.quality
        record.message = message
        progress[job.recordId] = nil
        await update(record)
        finishing.remove(job.id)
    }

    /// 仕上げ：（映像は音声と）結合・検証して、保存先へ移す。アプリが背面でも、与えられた時間の範囲で進める
    /// （時間切れで中断されても、取得したファイルとジョブが残るので、次に前面へ戻ったとき・再起動後に続きから仕上げる）。
    private func finish(_ job: DownloadJob, files: [URL]) async {
        let id = job.recordId
        #if canImport(UIKit)
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask(withName: "favecus-download-finish") { UIApplication.shared.endBackgroundTask(background); background = .invalid }
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        #endif
        var record = DeviceMediaRecord(key: job.key, kind: job.kind, state: .processing)
        record.quality = job.quality
        await update(record)
        let staging = transfers.staging(job.id)
        // 前回の仕上げの途中のファイルを消す（取得したファイルだけを残す）
        for name in (try? FileManager.default.contentsOfDirectory(atPath: staging.path)) ?? [] where !name.hasPrefix("stream-") {
            try? FileManager.default.removeItem(at: staging.appendingPathComponent(name))
        }
        do {
            let name = "\(UUID().uuidString.lowercased()).\(job.kind == "video" ? "mp4" : "m4a")"
            let output = staging.appendingPathComponent(name)
            record.state = .validating
            await update(record)
            let duration: Double
            if job.kind == "video", job.layout == "dash", files.count == 2 {
                do { duration = try await MediaProcessor.mergeVideo(video: files[0], audio: files[1], output: output, expectedDuration: job.duration) }
                catch {
                    // 結合に失敗：音声だけの保存は残せるよう、音声の取得済みファイルを使う（映像の保存は失敗として記録する）
                    let audio = self.record(key: job.key, kind: "audio")?.state
                    let audioJob = transfers.jobs().contains { $0.key == job.key && $0.kind == "audio" }
                    if !audioJob, audio == nil || audio == .failed || audio == .cancelled || audio == .notDownloaded { await saveAudioFallback(key: job.key, audioFile: files[1], duration: job.duration, staging: staging) }
                    throw error
                }
            } else {
                duration = try await MediaProcessor.finalizeAudio(input: files[0], output: output, expectedDuration: job.duration)
            }
            if cancelRequested.contains(id) { throw DownloadError.cancelled } // 仕上げの間に取り消されたら、完了にしない
            let destination = directory.appendingPathComponent(name)
            try FileManager.default.moveItem(at: output, to: destination)
            record.state = .completed
            record.fileName = name
            record.duration = duration
            record.bytes = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
            record.message = nil
        } catch {
            if (error as? DownloadError)?.isCancelled == true || error is CancellationError {
                record.state = .cancelled
                record.message = "取り消しました。"
            } else {
                record.state = .failed
                record.message = Self.describe(error)
            }
            record.fileName = nil
        }
        cancelRequested.remove(id)
        progress[id] = nil
        // 記録を保存できたときだけ、ジョブを消す（保存できなければ、取得したファイルとジョブを残し、次に続きから仕上げる）
        if await save(record) {
            transfers.remove(job.id)
        } else if record.state == .completed, let name = record.fileName {
            try? FileManager.default.moveItem(at: directory.appendingPathComponent(name), to: staging.appendingPathComponent(name))
        }
    }

    private func saveAudioFallback(key: String, audioFile: URL, duration: Double, staging: URL) async {
        let name = "\(UUID().uuidString.lowercased()).m4a"
        let output = staging.appendingPathComponent(name)
        guard let measured = try? await MediaProcessor.finalizeAudio(input: audioFile, output: output, expectedDuration: duration) else { return }
        let destination = directory.appendingPathComponent(name)
        guard (try? FileManager.default.moveItem(at: output, to: destination)) != nil else { return }
        var record = DeviceMediaRecord(key: key, kind: "audio", state: .completed)
        record.fileName = name
        record.duration = measured
        record.bytes = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
        await update(record)
    }

    /// 記録（downloads.json）には、署名つきの配信URLを含みうる通信エラーの詳細を残さない。
    private static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError { return "通信に失敗しました（\(urlError.code.rawValue)）。" }
        return (error as? CustomStringConvertible)?.description ?? "保存に失敗しました。"
    }

    static func ensureSpace(for bytes: Int64, at url: URL) throws {
        guard bytes > 0 else { return }
        let available = (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? Int64.max
        if available < bytes + bytes / 5 + 100 * 1024 * 1024 { throw DownloadError.message("空き容量が足りません。不要なデータを消してから、もう一度お試しください。") }
    }

    // MARK: オンライン再生

    /// 再生に使う音声ファイル。保存済みならそれ、なければ一時ファイルへ取得する（オンライン再生）。同じ曲の取得が重なったら、1つにまとめる。取得できなければ、理由つきで失敗する（再試行や回避はしない）。
    func playableFile(for entry: EntryItem) async throws -> URL {
        guard let key = await key(for: entry), let url = entry.url else { throw DownloadError.message("この曲の情報を確認できません。") }
        if let saved = savedFile(key: key) { return saved }
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
        if let artwork { Task { await artwork.fetch(key: key, urlString: media.thumbnailURL) } }
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
