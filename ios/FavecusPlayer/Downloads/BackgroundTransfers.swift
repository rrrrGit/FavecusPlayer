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
        configuration.waitsForConnectivity = true
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
    private var cancelling: Set<String> = [] // アプリ自身が取り消したジョブ（それ以外の取り消し＝システムによる中断は、失敗として残す）
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
        try write(job)
        lock.lock(); totals[job.id] = Int64(job.streams.reduce(0) { $0 + $1.size }); lock.unlock()
        // 許可されたホストの候補だけを残して、1回で書き込んでから始める
        var next = job
        for index in next.streams.indices { next.streams[index].urls = next.streams[index].urls.filter { URL(string: $0).map(MediaHostPolicy.isAllowed) == true } }
        if next != job { try write(next) }
        for index in next.streams.indices { try enqueue(next, index) }
    }

    private func enqueue(_ job: DownloadJob, _ index: Int) throws {
        let stream = job.streams[index]
        guard stream.urlIndex < stream.urls.count, let url = URL(string: stream.urls[stream.urlIndex]), MediaHostPolicy.isAllowed(url) else { throw DownloadError.message("保存可能な配信先がありません。") }
        var request = URLRequest(url: url)
        request.setValue("https://www.bilibili.com/", forHTTPHeaderField: "Referer")
        request.httpShouldHandleCookies = false
        request.allowsCellularAccess = !wifiOnly()
        let task = session.downloadTask(with: request)
        task.taskDescription = "\(job.id)#\(index)"
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

    func cancel(_ id: String) async {
        lock.lock(); cancelling.insert(id); lock.unlock()
        for task in await session.allTasks where Self.parse(task.taskDescription)?.id == id { task.cancel() }
    }

    /// ジョブの記録と作業フォルダを消す（取得中のものは、先に cancel する）。
    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: jobFile(id))
        try? FileManager.default.removeItem(at: staging(id))
        lock.lock(); written[id] = nil; totals[id] = nil; cancelling.remove(id); lock.unlock()
    }

    private static func parse(_ description: String?) -> (id: String, index: Int)? {
        guard let description, let split = description.lastIndex(of: "#"), let index = Int(description[description.index(after: split)...]) else { return nil }
        return (String(description[..<split]), index)
    }

    private func fail(_ id: String, _ index: Int, _ text: String, refused: Bool) {
        try? FileManager.default.createDirectory(at: staging(id), withIntermediateDirectories: true)
        try? ((refused ? "refused:" : "error:") + text).write(to: errorFile(id, index), atomically: true, encoding: .utf8)
        onChange?(id)
    }

    // MARK: URLSession

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let (id, index) = Self.parse(downloadTask.taskDescription) else { return }
        lock.lock()
        written[id, default: [:]][index] = totalBytesWritten
        let total = totals[id] ?? 0
        let sum = written[id]?.values.reduce(0, +) ?? 0
        lock.unlock()
        if total > 0 { onProgress?(id, min(1, Double(sum) / Double(total))) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // このメソッドを抜けると一時ファイルが消えるため、確認と移動をここで終える。
        guard let (id, index) = Self.parse(downloadTask.taskDescription), let job = job(id), index < job.streams.count else { return }
        guard let response = downloadTask.response as? HTTPURLResponse else { fail(id, index, "配信先の応答を確認できません。", refused: false); return }
        guard response.statusCode == 200 || response.statusCode == 206 else {
            let text = "配信先から取得できません（HTTP \(response.statusCode)）。時間を置いて再実行してください。"
            fail(id, index, text, refused: [401, 403, 412, 429].contains(response.statusCode))
            return
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.int64Value ?? -1
        if size <= 0 { fail(id, index, "取得したデータが空です。", refused: false); return }
        if job.streams[index].size > 0, size != Int64(job.streams[index].size) { fail(id, index, "取得したサイズが想定と一致しません。", refused: false); return }
        let destination = streamFile(job, index)
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            fail(id, index, "取得したファイルを保存できません。", refused: false)
            return
        }
        onChange?(id)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let (id, index) = Self.parse(task.taskDescription) else { return }
        if (error as? URLError)?.code == .cancelled {
            lock.lock(); let own = cancelling.contains(id); lock.unlock()
            if !own { fail(id, index, "中断されました。もう一度保存してください。", refused: false) } // システムによる取り消し（終了など）
            return
        }
        // 通信の失敗（拒否ではない）：次の候補があれば、そちらで試す。なければ失敗として残す。
        if var job = job(id), index < job.streams.count, job.streams[index].urlIndex + 1 < job.streams[index].urls.count {
            job.streams[index].urlIndex += 1
            if (try? write(job)) != nil, (try? enqueue(job, index)) != nil { return }
        }
        let code = (error as? URLError)?.code.rawValue ?? (error as NSError).code
        fail(id, index, "通信に失敗しました（\(code)）。", refused: false)
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
