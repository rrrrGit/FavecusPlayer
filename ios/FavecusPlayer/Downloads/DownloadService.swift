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
    private var batchTask: Task<Void, Never>?
    private var localFrameTask: Task<Void, Never>?
    private var framesTask: Task<Void, Never>?
    private var frameFailures: [String: Date] = [:]
    private var batchID = 0
    private var batchTargets: [EntryItem] = []
    private var batchKind = "audio"
    private var batchStopped = false
    /// プレイリスト単位の保存の進み具合（保存を始めた曲数／全体）。実行していなければnil。
    @Published private(set) var batch: (done: Int, total: Int)?
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
            message = "保存の記録を読み込めません：\(ErrorText.safe(error))"
        }
    }

    /// 前面へ戻ったとき：取得が終わっているジョブ、仕上げが途中で止まったジョブを続ける。
    func resume() async {
        guard started else { return }
        for job in transfers.jobs() { await evaluate(job.id) }
        for job in transfers.jobs() { await transfers.restartStalled(job.id, idleFor: 180) }
    }

    // MARK: 更新・一覧の表示

    /// 失敗・取り消しの記録を一覧に出しておく時間（秒）。過ぎたものは表示しない（記録は残る）。
    static let problemLifetime: TimeInterval = 3600

    /// 保存済み（完了）の合計容量。曲の一覧に関係なく、すべての記録から求める。
    var savedBytes: Int64 { records.values.filter { $0.state == .completed }.reduce(0) { $0 + $1.bytes } }

    /// 端末の空き容量（取得できないときはnil）。
    func freeBytes() -> Int64? {
        try? directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
    }

    /// 表示してよい失敗・取り消し（一定時間を過ぎたものは出さない）。
    func isRecentProblem(_ record: DeviceMediaRecord, now: Date = Date()) -> Bool {
        (record.state == .failed || record.state == .cancelled) && now.timeIntervalSince1970 - record.updatedAt < Self.problemLifetime
    }

    /// 曲の行に出す失敗の文言。どちらかの形式が保存済みなら出さない（音声だけ保存できた動画の失敗が残り続けないように）。
    func problemStatus(key: String) -> String? {
        let audio = record(key: key, kind: "audio"), video = record(key: key, kind: "video")
        if audio?.state == .completed || video?.state == .completed { return nil }
        return [audio, video].contains { $0.map { $0.state == .failed && isRecentProblem($0) } ?? false } ? "保存に失敗" : nil
    }

    /// 更新：古い失敗の表示を消してから、保存中の処理を実際の状態と照らし合わせ直す。
    func reload() async {
        guard started else { return }
        do { try await catalog.removeProblems() } catch { message = "保存の記録を整理できません：\(ErrorText.safe(error))" }
        await publish()
        await reconcile(idleFor: 45)
    }

    /// 保存中の処理の再確認：取得が終わっていれば仕上げ、失敗していれば止め、通信もジョブもないのに途中のまま残った記録は失敗にする。
    /// idleFor：受信がこの秒数まったく進んでいない取得は、次の候補で取り直す（なければ失敗にする）。
    func reconcile(idleFor: TimeInterval = 180) async {
        guard started else { return }
        let jobs = transfers.jobs()
        let live = await transfers.liveJobIds()
        let now = Date().timeIntervalSince1970
        for job in jobs {
            // 始めたばかりのジョブは、通信の引き継ぎの途中の可能性があるため、通信の有無では判断しない
            await evaluate(job.id, live: now - job.createdAt > 20 ? live : nil)
        }
        for job in transfers.jobs() { await transfers.restartStalled(job.id, idleFor: idleFor) }
        let remaining = Set(transfers.jobs().map(\.recordId))
        for record in records.values where record.state.inProgress && !remaining.contains(record.id) && running[record.id] == nil {
            var next = record
            next.state = .failed
            next.message = "中断されました。もう一度保存してください。"
            next.fileName = nil
            progress[record.id] = nil
            await update(next)
        }
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

    /// 曲を追加するときの動画情報（曲名・長さ）。
    func videoInfo(url: String) async throws -> VideoInfo { try await bilibili.info(url: url) }

    /// 追加した動画のサムネイル（動画の特定の場面）を用意する。失敗しても曲の追加には影響しない。
    func fetchThumbnail(forVideoURL url: String, thumbnailURL: String?) async {
        guard let key = await key(for: EntryItem(id: "", title: "", type: "bilibili", fileName: nil, url: url)) else { return }
        await ensureFrame(key: key, url: url, coverURL: thumbnailURL)
    }

    /// 曲のサムネイルを、動画の特定の場面（60秒付近）で用意する。優先順：保存済みの動画ファイル → 公式のプレビュー画像（videoshot）→（場面が得られない動画だけ）表紙の画像。
    /// 拒否・制限（ログイン要・混雑など）が出たときは、続けて別の通信をしない。
    /// 戻り値：制限（ログイン要・混雑など）が出て、続けて要求してはいけないとき true。
    @discardableResult
    func ensureFrame(key: String, url: String, coverURL: String?) async -> Bool {
        guard let artwork, !artwork.hasFrame(for: key) else { return false }
        // 場面が得られなかった動画は、60秒のあいだ、同じ要求を繰り返さない
        if let failedAt = frameFailures[key], Date().timeIntervalSince(failedAt) < 60 { return false }
        if let file = savedFile(key: key, kind: "video"), await artwork.makeFrame(fromFile: file, key: key) { return false }
        do {
            let cell = try await bilibili.shotCell(url: url)
            if await artwork.makeFrame(fromSheet: cell, key: key) { return false }
        } catch {
            if (error as? BilibiliError)?.stopBatch == true { return true }
        }
        await artwork.fetch(key: key, urlString: coverURL)
        if !artwork.hasImage(for: key) { frameFailures[key] = Date() }
        return false
    }

    /// このリストの曲のサムネイルを、順に取得する（1秒ずつ間隔をあけ、制限が出たら止める。利用者が押したときだけ）。
    func ensureFrames(entries: [EntryItem]) async {
        guard artwork != nil, framesTask == nil else { return } // 実行中は、重ねて始めない
        framesTask = Task {}
        defer { framesTask = nil }
        for entry in entries where entry.type == "bilibili" {
            guard let url = entry.url, let key = entryKeys[entry.id], artwork?.hasFrame(for: key) == false else { continue }
            if await ensureFrame(key: key, url: url, coverURL: nil) {
                message = "サムネイルの取得を止めました：Bilibiliから制限の応答がありました。時間を置いてください。"
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    /// ローカルの動画ファイルのサムネイル（目標の場面）を、順に作る。映像のないファイル（音声だけ）は、調べ直さない。
    func ensureLocalFrames(entries: [EntryItem], mediaDirectory: URL) {
        guard let artwork else { return }
        localFrameTask?.cancel()
        let targets = entries.filter { $0.type == "local" && $0.fileName != nil }
        guard !targets.isEmpty else { return }
        localFrameTask = Task {
            for entry in targets {
                if Task.isCancelled { break }
                guard let name = entry.fileName else { continue }
                let key = "local:" + name
                let file = mediaDirectory.appendingPathComponent(name)
                if artwork.hasFrame(for: key) || artwork.knownWithoutFrame(key) || !FileManager.default.fileExists(atPath: file.path) { continue }
                _ = await artwork.makeFrame(fromFile: file, key: key)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    /// 保存済みの動画ファイル（再生画面の「動画」表示）。
    func savedVideoFile(for entry: EntryItem) async -> URL? {
        guard let key = await key(for: entry) else { return nil }
        return savedFile(key: key, kind: "video")
    }

    /// 動画のURLの一覧に対する同期用メディアキー（共通JS）。求められないURLはnil。
    func mediaKeys(forURLs urls: [String]) async -> [String?] {
        guard !urls.isEmpty else { return [] }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: ["entries": urls.map { ["url": $0] }, "aliases": [Any]()]), as: UTF8.self)
            guard let response = try JSONSerialization.jsonObject(with: Data(try await core.callAsync("MediaKeys", request).utf8)) as? [String: Any], let keys = response["keys"] as? [Any], keys.count == urls.count else { return urls.map { _ in nil } }
            return keys.map { $0 as? String }
        } catch { return urls.map { _ in nil } }
    }

    /// ZIPに同梱された保存済みの動画・音声を取り込む：ライブラリにある曲（取り込んだ曲・すでにあって保存のない曲）の分だけ。
    /// 端末内へ取り出して再生できるか確かめ、保存先へ移してから、記録（完了）を保存する。読み取れないものは取り込まず、数えて知らせる。
    func importDownloaded(from zipURL: URL, records: [ImportDownload], entries: [EntryItem]) async -> (imported: Int, failed: Int) {
        guard started else { return (0, records.count) }
        await refreshKeys(entries: entries)
        let wanted = Set(entryKeys.values)
        let keys = await mediaKeys(forURLs: records.map(\.url))
        var imported = 0, failed = 0
        for (record, key) in zip(records, keys) {
            guard let key, wanted.contains(key) else { continue }
            if savedFile(key: key, kind: record.kind) != nil || self.record(key: key, kind: record.kind)?.state.inProgress == true { continue }
            let staging = directory.appendingPathComponent(".dl-import-" + UUID().uuidString, isDirectory: true)
            defer { try? FileManager.default.removeItem(at: staging) }
            do {
                try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
                try Self.ensureSpace(for: record.bytes, at: directory)
                let name = UUID().uuidString.lowercased() + (record.kind == "video" ? ".mp4" : ".m4a")
                let staged = staging.appendingPathComponent(name)
                let media = record.media
                try await Task.detached {
                    let zip = try ZipArchive(source: try FileSource(url: zipURL))
                    try zip.extract(media, to: staged)
                }.value
                let duration = try await MediaProcessor.validate(file: staged, needsVideo: record.kind == "video", expectedDuration: record.duration)
                // 取り出している間に、同じ曲の保存が始まった・終わった場合は、重ねて記録しない
                if savedFile(key: key, kind: record.kind) != nil || self.record(key: key, kind: record.kind)?.state.inProgress == true { continue }
                let destination = directory.appendingPathComponent(name)
                try FileManager.default.moveItem(at: staged, to: destination)
                var saved = DeviceMediaRecord(key: key, kind: record.kind, state: .completed)
                saved.fileName = name
                saved.quality = record.height
                saved.duration = duration
                saved.bytes = record.bytes
                if record.kind == "video", let artwork {
                    let length = record.duration
                    Task { await artwork.makeFrame(fromFile: destination, key: key, duration: length, force: true) }
                }
                if await save(saved) { imported += 1 } else { try? FileManager.default.removeItem(at: destination); failed += 1 }
            } catch { failed += 1 }
        }
        return (imported, failed)
    }

    /// 一覧の曲のキーを、共通JSで1回にまとめて求める。
    func refreshKeys(entries: [EntryItem]) async {
        // ローカルのファイルの曲：サムネイル用のキー（ファイル名）。Bilibiliの曲は、共通JSのメディアキー
        var locals: [String: String] = [:]
        for entry in entries where entry.type == "local" { if let name = entry.fileName { locals[entry.id] = "local:" + name } }
        let targets = entries.filter { $0.type == "bilibili" && $0.url != nil }
        guard !targets.isEmpty else { if entryKeys != locals { entryKeys = locals }; return }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: ["entries": targets.map { ["url": $0.url ?? ""] }, "aliases": [Any]()]), as: UTF8.self)
            guard let response = try JSONSerialization.jsonObject(with: Data(try await core.callAsync("MediaKeys", request).utf8)) as? [String: Any], let keys = response["keys"] as? [Any], keys.count == targets.count else { return }
            var result = locals
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

    /// プレイリスト単位の保存：曲を1つずつ、間隔をあけて始める（続けて大量の要求を送らない）。すでに保存済み・保存中の曲は飛ばす。
    /// 拒否・制限（ログイン要・混雑・配信先の拒否）が出たら、そこで止めて知らせる（回避しない）。
    func saveAll(entries: [EntryItem], kind: String) {
        batchTask?.cancel()
        let targets = entries.filter { $0.type == "bilibili" && $0.url != nil }
        guard !targets.isEmpty else { return }
        batchStopped = false
        batchID += 1
        let mine = batchID
        batchTargets = targets
        batchKind = kind
        batch = (0, targets.count)
        batchTask = Task { [weak self] in
            guard let self else { return }
            for (index, entry) in targets.enumerated() {
                if Task.isCancelled || self.batchStopped { break }
                self.batch = (index, targets.count)
                guard let key = await self.key(for: entry) else { continue }
                if let existing = self.record(key: key, kind: kind), existing.state.inProgress || (existing.state == .completed && self.savedFile(key: key, kind: kind) != nil) { continue }
                self.save(entry: entry, kind: kind)
                await self.chain?.value
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            if self.batchID == mine { self.batch = nil } // 新しいまとめての保存が始まっていたら、その表示を消さない
        }
    }

    /// まとめての保存を止め、取得中のものも取り消す（entries：対象の曲）。
    func cancelAll() {
        batchTask?.cancel()
        batch = nil
        // 始めたときの対象・形式で取り消す（画面の選択が変わっていても、別の曲・別の形式を取り消さない）
        for entry in batchTargets where entry.type == "bilibili" {
            guard let key = entryKeys[entry.id], record(key: key, kind: batchKind)?.state.inProgress == true else { continue }
            cancel(key: key, kind: batchKind)
        }
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
        do { try await catalog.upsert(record) } catch { saved = false; message = "保存の記録を書き込めません：\(ErrorText.safe(error))" }
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
            Task { if await self.ensureFrame(key: key, url: url, coverURL: media.thumbnailURL) { self.batchStopped = true } }
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
            // ログインが必要・リスク制御・混雑・配信先の拒否は、続けて次の曲を要求せず、まとめての保存を止める
            if (error as? BilibiliError)?.stopBatch == true || (error as? DownloadError)?.isRefusal == true {
                batchStopped = true
                message = "まとめての保存を止めました：\(Self.describe(error))"
            }
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
        if let failed = statuses.compactMap({ status -> (String, Bool)? in if case .failed(let text, let refused) = status { return (text, refused) } else { return nil } }).first {
            // 配信先の拒否（401・403・412・429）は、まとめての保存を止める（続けて次の曲を要求しない）
            if failed.1 { batchStopped = true; message = "まとめての保存を止めました：" + failed.0 }
            await abort(job, message: failed.0, state: .failed)
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
            // 動画を保存できたら、サムネイルを、そのファイルの場面（高画質）に置き換える
            if job.kind == "video", let artwork {
                let key = job.key, length = job.duration
                Task { await artwork.makeFrame(fromFile: destination, key: key, duration: length, force: true) }
            }
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
        ErrorText.safe(error)
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
