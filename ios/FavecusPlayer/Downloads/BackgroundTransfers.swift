import Foundation

/// 保存の1件分の作業（取得先の一覧と進み具合）。アプリが終了・再起動しても続けられるよう、ファイルとして残す。
/// 署名つきの配信URLを含むため、バックアップ対象外の保存先に置き、ログ・保存記録（downloads.json）・メッセージには出さない。
struct JobStream: Codable, Equatable {
    var urls: [String]
    var size: Int
    var ext: String
    var urlIndex: Int = 0
}

struct DownloadJob: Codable, Equatable {
    var id: String
    var key: String
    var kind: String
    var title: String
    var quality: Int
    var duration: Double
    var layout: String
    var streams: [JobStream]
    var createdAt: Double

    var recordId: String { "\(key)|\(kind)" }
}

enum StreamStatus: Equatable {
    case done(URL)
    case failed(String, refused: Bool)
    case pending
}

/// 配信先からの取得。iPhoneでは、アプリが背面・画面ロック中でも続く background の URLSession で動かす
/// （アプリを上へスワイプして終了した場合は、iOSの仕様で取得が止まる）。テストでは、決まった応答を返す通常の設定へ差し替える。
/// 取得の結果は、ファイルで残す（取得できた分は staging/stream-N.ext、失敗は stream-N.err）ので、再起動後も実際のファイルから状態を決められる。
/// 続けても同じ結果になる拒否（401/403/412/429）は、別の候補へ進まず止める。Cookieは付けない。
final class BackgroundTransfers: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let identifier = "app.favecus.player.downloads"
    /// AppDelegate が受け取った、背面で終わった通信の完了通知（identifier ごと。メインスレッドだけで触る）。
    nonisolated(unsafe) static var pendingCompletion: [String: () -> Void] = [:]
    nonisolated(unsafe) private static var eventsFinished: Set<String> = []

    /// AppDelegate から：背面の通信の完了通知を登録する（先に終了イベントが届いていれば、すぐ呼ぶ）。メインスレッドだけ。
    static func register(identifier: String, completion: @escaping () -> Void) {
        if eventsFinished.remove(identifier) != nil { completion() } else { pendingCompletion[identifier] = completion }
    }

    static func backgroundConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true // 背面のセッションでは無視され、常に接続を待つ（Appleの仕様）。待ち続けたままにならないよう、受信の途絶は restartStalled で検知する
        configuration.timeoutIntervalForResource = 6 * 3600 // 既定は7日。進まない取得を、いつまでも残さない
        return configuration
    }

    private let identifier: String
    private let jobsDirectory: URL
    private let stagingRoot: URL
    private let wifiOnly: @Sendable () -> Bool
    private var session: URLSession!
    private let lock = NSLock()
    private var written: [String: [Int: Int64]] = [:]
    private var totals: [String: Int64] = [:]
    private var resumes: [String: Int] = [:] // 通信の途中切れからの再開の回数（取得の単位ごと）
    private var cancelling: Set<String> = [] // アプリ自身が取り消したジョブ（それ以外の取り消し＝システムによる中断は、失敗として残す）
    private var removed: Set<String> = [] // 削除済みジョブ（遅れて届くデリゲート通知で .err を復活させない）
    private var activity: [String: Date] = [:] // 取得の単位（ジョブID#番号）ごとの、最後にデータを受け取った（または始めた）時刻
    private var restarting: Set<Int> = [] // 受信が途絶えたため、アプリ自身が取り直しているタスク（taskIdentifier 単位）
    /// 取得の状態が変わった（ジョブID）。
    var onChange: (@Sendable (String) -> Void)?
    /// 進み具合（ジョブID、0〜1）。
    var onProgress: (@Sendable (String, Double) -> Void)?

    init(configuration: URLSessionConfiguration, identifier: String = BackgroundTransfers.identifier, jobsDirectory: URL, stagingRoot: URL, wifiOnly: @escaping @Sendable () -> Bool = { false }) {
        self.identifier = identifier
        self.jobsDirectory = jobsDirectory
        self.stagingRoot = stagingRoot
        self.wifiOnly = wifiOnly
        super.init()
        let copy = configuration.copy() as? URLSessionConfiguration ?? configuration
        copy.httpCookieStorage = nil
        copy.httpShouldSetCookies = false
        session = URLSession(configuration: copy, delegate: self, delegateQueue: nil)
    }

    // MARK: 場所

    func staging(_ id: String) -> URL { stagingRoot.appendingPathComponent(".dl-\(id)", isDirectory: true) }
    private func jobFile(_ id: String) -> URL { jobsDirectory.appendingPathComponent("\(id).json") }
    private func streamFile(_ job: DownloadJob, _ index: Int) -> URL { staging(job.id).appendingPathComponent("stream-\(index).\(job.streams[index].ext)") }
    private func errorFile(_ id: String, _ index: Int) -> URL { staging(id).appendingPathComponent("stream-\(index).err") }

    // MARK: ジョブ

    func jobs() -> [DownloadJob] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: jobsDirectory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.compactMap { job(String($0.dropLast(5))) }.sorted { $0.createdAt < $1.createdAt }
    }

    func job(_ id: String) -> DownloadJob? {
        guard let data = try? Data(contentsOf: jobFile(id)), let job = try? JSONDecoder().decode(DownloadJob.self, from: data), job.id == id else { return nil }
        return job
    }

    private func write(_ job: DownloadJob) throws {
        try FileManager.default.createDirectory(at: jobsDirectory, withIntermediateDirectories: true)
        var folder = jobsDirectory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true // 署名つきの配信URLを含むため、バックアップに入れない
        try? folder.setResourceValues(values)
        try JSONEncoder().encode(job).write(to: jobFile(job.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// 取得を始める。取得先が1つもない（許可されていないホストだけ）ときは、何も始めずに失敗する。
    func start(_ job: DownloadJob) throws {
        if job.streams.isEmpty || job.streams.contains(where: { stream in !stream.urls.contains { URL(string: $0).map(MediaHostPolicy.isAllowed) == true } }) {
            throw DownloadError.message("保存可能な配信先がありません。")
        }
        try FileManager.default.createDirectory(at: staging(job.id), withIntermediateDirectories: true)
        lock.withLock {
            removed.remove(job.id)
            cancelling.remove(job.id)
            totals[job.id] = Int64(job.streams.reduce(0) { $0 + $1.size })
        }
        // 許可されたホストの候補だけを残して、1回で書き込んでから始める
        var next = job
        for index in next.streams.indices { next.streams[index].urls = next.streams[index].urls.filter { URL(string: $0).map(MediaHostPolicy.isAllowed) == true } }
        try lock.withLock { try write(next) }
        for index in next.streams.indices { try enqueue(next, index) }
    }

    private func enqueue(_ job: DownloadJob, _ index: Int) throws {
        let stream = job.streams[index]
        guard stream.urlIndex < stream.urls.count, let url = URL(string: stream.urls[stream.urlIndex]), MediaHostPolicy.isAllowed(url) else { throw DownloadError.message("保存可能な配信先がありません。") }
        var request = URLRequest(url: url)
        request.setValue(MediaHeaders.referer, forHTTPHeaderField: "Referer")
        request.setValue(MediaHeaders.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        request.allowsCellularAccess = !wifiOnly()
        let task = session.downloadTask(with: request)
        task.taskDescription = "\(job.id)#\(index)"
        lock.lock(); activity["\(job.id)#\(index)"] = Date(); lock.unlock()
        task.resume()
    }

    func status(of job: DownloadJob) -> [StreamStatus] {
        job.streams.indices.map { index in
            let file = streamFile(job, index)
            if FileManager.default.fileExists(atPath: file.path) { return .done(file) }
            if let text = try? String(contentsOf: errorFile(job.id, index), encoding: .utf8) {
                if text.hasPrefix("refused:") { return .failed(String(text.dropFirst(8)), refused: true) }
                return .failed(text.hasPrefix("error:") ? String(text.dropFirst(6)) : text, refused: false)
            }
            return .pending
        }
    }

    /// いま通信中（または待機中）のジョブ。
    func liveJobIds() async -> Set<String> {
        Set(await session.allTasks.compactMap { Self.parse($0.taskDescription)?.id })
    }

    /// 前面へ戻ったとき：背面の間は進み具合の通知が届かず、時刻が古いままなので、いまから数え直す（順調な取得を、止まったと誤判定しない）。
    func markForeground() {
        lock.lock()
        for key in activity.keys { activity[key] = Date() }
        lock.unlock()
    }

    /// 受信が一定時間まったく進まないジョブの、未完了の取得を取り直す：次の候補のURLがあればそちらで、なければ失敗として残す
    /// （背面のセッションは接続を待ち続けるため、止まったままの取得を検知する）。URLは記録しない。戻り値：取り直した・失敗にした取得の数。
    @discardableResult
    func restartStalled(_ id: String, idleFor: TimeInterval) async -> Int {
        guard let initial = self.job(id) else { return 0 }
        let pending = initial.streams.indices.filter { index in
            !FileManager.default.fileExists(atPath: streamFile(initial, index).path) && !FileManager.default.fileExists(atPath: errorFile(id, index).path)
        }
        guard !pending.isEmpty else { return 0 }
        // ジョブのどの取得にも動きがなければ、止まっているとみなす（再起動直後など、時刻が分からないときは、いまから数える）
        lock.lock()
        let times = initial.streams.indices.compactMap { activity["\(id)#\($0)"] }
        if times.isEmpty { for index in initial.streams.indices { activity["\(id)#\(index)"] = Date() } }
        let last = times.max() ?? Date()
        let idle = Date().timeIntervalSince(last)
        lock.unlock()
        guard idle >= idleFor else { return 0 }
        let tasks = await session.allTasks.filter { Self.parse($0.taskDescription)?.id == id }
        guard var latest = self.job(id) else { return 0 }
        var handled = 0
        for index in pending {
            guard latest.streams.indices.contains(index), !FileManager.default.fileExists(atPath: streamFile(latest, index).path), !FileManager.default.fileExists(atPath: errorFile(id, index).path) else { continue }
            let description = "\(id)#\(index)"
            lock.lock()
            let bytes = written[id]?[index] ?? 0
            for task in tasks where task.taskDescription == description { restarting.insert(task.taskIdentifier) }
            written[id]?[index] = 0
            lock.unlock()
            for task in tasks where task.taskDescription == description { task.cancel() }
            let stream = latest.streams[index]
            if stream.urlIndex + 1 < stream.urls.count {
                latest.streams[index].urlIndex += 1
                if (try? lock.withLock { try write(latest) }) != nil, (try? enqueue(latest, index)) != nil { handled += 1; continue }
            }
            let wifi = wifiOnly() ? "・Wi-Fi接続時のみ保存がオン" : ""
            // 原因の切り分け用：どの配信先の候補で止まったか（ホスト名のみ。パス・検索条件・認証に関わる部分は出さない）と、何本目の取得か
            let hosts = stream.urls.compactMap { URL(string: $0)?.host }.joined(separator: " → ")
            let detail = "受信 \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))・候補 \(stream.urlIndex + 1)/\(max(stream.urls.count, 1))・\(Int(idle / 60))分 受信なし・\(index + 1)/\(latest.streams.count)本目\(hosts.isEmpty ? "" : "・配信先 " + hosts)\(wifi)"
            fail(id, index, "取得が進みません（\(detail)）。時間を置いて、もう一度保存してください。", refused: false)
            handled += 1
        }
        return handled
    }

    func cancel(_ id: String) async {
        lock.lock(); cancelling.insert(id); lock.unlock()
        for task in await session.allTasks where Self.parse(task.taskDescription)?.id == id { task.cancel() }
    }

    /// ジョブの記録と作業フォルダを消す（取得中のものは、先に cancel する）。
    func remove(_ id: String) {
        lock.withLock {
            removed.insert(id)
            try? FileManager.default.removeItem(at: jobFile(id))
            try? FileManager.default.removeItem(at: staging(id))
            written[id] = nil
            totals[id] = nil
            cancelling.remove(id)
            resumes = resumes.filter { !$0.key.hasPrefix(id + "#") }
            activity = activity.filter { !$0.key.hasPrefix(id + "#") }
        }
    }

    private static func parse(_ description: String?) -> (id: String, index: Int)? {
        guard let description, let split = description.lastIndex(of: "#"), let index = Int(description[description.index(after: split)...]) else { return nil }
        return (String(description[..<split]), index)
    }

    private func fail(_ id: String, _ index: Int, _ text: String, refused: Bool) {
        let shouldNotify: Bool = lock.withLock {
            guard !removed.contains(id), job(id) != nil else { return false }
            try? FileManager.default.createDirectory(at: staging(id), withIntermediateDirectories: true)
            try? ((refused ? "refused:" : "error:") + text).write(to: errorFile(id, index), atomically: true, encoding: .utf8)
            return true
        }
        if shouldNotify { onChange?(id) }
    }

    // MARK: URLSession

    /// 取得できなかった：拒否（401・403・412・429）以外は、次の候補のURLがあれば、そちらで試す。なければ失敗として残す。
    private func reject(_ id: String, _ index: Int, _ text: String, refused: Bool) {
        let nextJob: DownloadJob? = lock.withLock {
            guard !refused, !removed.contains(id), var job = job(id), index < job.streams.count, job.streams[index].urlIndex + 1 < job.streams[index].urls.count else { return nil }
            job.streams[index].urlIndex += 1
            guard (try? write(job)) != nil else { return nil }
            return job
        }
        if let nextJob, (try? enqueue(nextJob, index)) != nil { return }
        fail(id, index, text, refused: refused)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let (id, index) = Self.parse(downloadTask.taskDescription) else { return }
        let (total, sum): (Int64, Int64) = lock.withLock {
            written[id, default: [:]][index] = totalBytesWritten
            activity["\(id)#\(index)"] = Date()
            if totals[id] == nil, let j = job(id) {
                let expected = Int64(j.streams.reduce(0) { $0 + $1.size })
                if expected > 0 { totals[id] = expected }
            }
            let total = totals[id] ?? 0
            let sum = written[id]?.values.reduce(0, +) ?? 0
            return (total, sum)
        }
        if total > 0 { onProgress?(id, min(1, Double(sum) / Double(total))) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // このメソッドを抜けると一時ファイルが消えるため、確認と移動をここで終える。
        guard let (id, index) = Self.parse(downloadTask.taskDescription) else { return }
        let activeJob: DownloadJob? = lock.withLock {
            guard !removed.contains(id) else { return nil }
            return job(id)
        }
        guard let job = activeJob, job.streams.indices.contains(index) else { return }
        guard let response = downloadTask.response as? HTTPURLResponse else { reject(id, index, "配信先の応答を確認できません。", refused: false); return }
        guard response.statusCode == 200 || response.statusCode == 206 else {
            let host = downloadTask.originalRequest?.url?.host.map { "・配信先 " + $0 } ?? ""
            let text = "配信先から取得できません（HTTP \(response.statusCode)\(host)）。時間を置いて再実行してください。"
            reject(id, index, text, refused: [401, 403, 412, 429].contains(response.statusCode))
            return
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.int64Value ?? -1
        if size <= 0 { reject(id, index, "取得したデータが空です。", refused: false); return }
        if job.streams[index].size > 0, size != Int64(job.streams[index].size) { reject(id, index, "取得したサイズが想定と一致しません。", refused: false); return }
        let destination = streamFile(job, index)
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            lock.withLock {
                if removed.contains(id) { try? FileManager.default.removeItem(at: staging(id)) }
            }
            fail(id, index, "取得したファイルを保存できません。", refused: false)
            return
        }
        let shouldNotify = lock.withLock {
            guard !removed.contains(id) else {
                try? FileManager.default.removeItem(at: destination)
                try? FileManager.default.removeItem(at: staging(id))
                return false
            }
            return true
        }
        guard shouldNotify else { return }
        onChange?(id)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let (id, index) = Self.parse(task.taskDescription) else { return }
        if (error as? URLError)?.code == .cancelled {
            let own: Bool = lock.withLock { cancelling.contains(id) || removed.contains(id) || restarting.remove(task.taskIdentifier) != nil }
            if !own { fail(id, index, "中断されました。もう一度保存してください。", refused: false) } // システムによる取り消し（終了など）。既に削除済みのジョブは復活させない
            return
        }
        // 通信の途中切れ：OSが持つ再開用のデータがあれば、続きから取得し直す（同じURL。2回まで。Wi-Fiのみ設定時は最新制約を保つため使わない）。
        if !wifiOnly(), let description = task.taskDescription, let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            let canRetry: Bool = lock.withLock {
                guard !removed.contains(id) else { return false }
                let attempts = resumes[description, default: 0]
                if attempts < 2 { resumes[description] = attempts + 1; return true }
                return false
            }
            if canRetry {
                let retry = session.downloadTask(withResumeData: data)
                retry.taskDescription = description
                lock.withLock { activity[description] = Date() }
                retry.resume()
                return
            }
        }
        // 通信の失敗（拒否ではない）：次の候補があれば、そちらで試す。なければ失敗として残す。
        let nextJob: DownloadJob? = lock.withLock {
            guard !removed.contains(id), var job = job(id), index < job.streams.count, job.streams[index].urlIndex + 1 < job.streams[index].urls.count else { return nil }
            job.streams[index].urlIndex += 1
            guard (try? write(job)) != nil else { return nil }
            return job
        }
        if let nextJob, (try? enqueue(nextJob, index)) != nil { return }
        let code = (error as? URLError)?.code.rawValue ?? (error as NSError).code
        fail(id, index, "通信に失敗しました（コード \(code)）。", refused: false)
    }

    /// リダイレクト先も、許可したホストだけ。
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        if let url = request.url, MediaHostPolicy.isAllowed(url) { completionHandler(request) } else { completionHandler(nil) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let identifier = identifier
        DispatchQueue.main.async {
            if let completion = BackgroundTransfers.pendingCompletion.removeValue(forKey: identifier) { completion() } else { BackgroundTransfers.eventsFinished.insert(identifier) }
        }
    }
}
