import Foundation

/// 動画の配信先として許可するホスト（共通JSの MediaURL と同じ。二重に確認する）。Cookieは付けない（ログイン情報は api.bilibili.com 宛てだけ）。
enum MediaHostPolicy {
    private static let hosts = ["bilivideo.com", "bilivideo.cn", "bilivideo.net", "hdslb.com", "akamaized.net"]

    static func isAllowed(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil, let host = url.host?.lowercased() else { return false }
        return hosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }
}

enum DownloadError: Error, CustomStringConvertible {
    case message(String)
    /// 配信先の拒否・制限（401/403/412/429）。続けても同じ結果になるので、別の候補・次の曲へ進まず止める。
    case refused(String)
    case cancelled

    var isCancelled: Bool { if case .cancelled = self { return true } else { return false } }
    var isRefusal: Bool { if case .refused = self { return true } else { return false } }

    var description: String {
        switch self {
        case .message(let text), .refused(let text): return text
        case .cancelled: return "取り消しました。"
        }
    }
}

/// 配信先からのファイルの取得（前面）。進捗・取り消し・リダイレクト先の再検査・サイズの確認を行う。バックグラウンドでの継続は後の工程。
final class MediaDownloader: @unchecked Sendable {
    private let configuration: URLSessionConfiguration

    /// configuration：通信の設定（テストでは、決まった応答を返す設定に差し替える）。
    init(configuration: URLSessionConfiguration = .ephemeral) {
        let copy = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
        copy.httpCookieStorage = nil
        copy.httpShouldSetCookies = false
        self.configuration = copy
    }

    /// streams の各項目を、候補のURLを順に試して取得する。戻り値は、取得したファイルの場所（directory内、呼び出し側が後片付けする）。
    func download(streams: [ResolvedStream], into directory: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> [URL] {
        var files: [URL] = []
        do {
            for (index, stream) in streams.enumerated() {
                let destination = directory.appendingPathComponent("stream-\(index).\(streams.count == 2 && index == 1 ? "m4a" : "mp4")")
                try await fetch(stream, to: destination) { value in progress((Double(index) + value) / Double(streams.count)) }
                files.append(destination)
            }
            return files
        } catch {
            for file in files { try? FileManager.default.removeItem(at: file) }
            throw error
        }
    }

    private func fetch(_ stream: ResolvedStream, to destination: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        var lastError: Error = DownloadError.message("保存可能な配信先がありません。")
        for raw in stream.urls {
            try Task.checkCancellation()
            guard let url = URL(string: raw), MediaHostPolicy.isAllowed(url) else { continue }
            do {
                try await single(url, expected: stream.size, to: destination, progress: progress)
                return
            } catch is CancellationError {
                throw DownloadError.cancelled
            } catch let error as DownloadError {
                if case .cancelled = error { throw error }
                if error.isRefusal { throw error } // 配信先の拒否・制限（401/403/412/429）は、別の候補で試し直さない
                lastError = error
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private func single(_ url: URL, expected: Int, to destination: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let job = Job(progress: progress)
        let session = URLSession(configuration: configuration, delegate: job, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url)
        request.setValue(MediaHeaders.referer, forHTTPHeaderField: "Referer")
        request.setValue(MediaHeaders.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 30
        let task = session.downloadTask(with: request)
        let received: (URL, HTTPURLResponse) = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                job.begin(continuation)
                task.resume()
            }
        } onCancel: { task.cancel() }
        defer { try? FileManager.default.removeItem(at: received.0) }
        guard received.1.statusCode == 200 || received.1.statusCode == 206 else {
            let text = "配信先から取得できません（HTTP \(received.1.statusCode)）。時間を置いて再実行してください。"
            if [401, 403, 412, 429].contains(received.1.statusCode) { throw DownloadError.refused(text) }
            throw DownloadError.message("配信先から取得できません（HTTP \(received.1.statusCode)）。時間を置いて再実行してください。")
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: received.0.path)[.size] as? NSNumber)?.int64Value ?? -1
        if size <= 0 { throw DownloadError.message("取得したデータが空です。") }
        if expected > 0, size != Int64(expected) { throw DownloadError.message("取得したサイズが想定と一致しません。") }
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: received.0, to: destination)
    }

    private final class Job: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        private let progress: @Sendable (Double) -> Void
        private var continuation: CheckedContinuation<(URL, HTTPURLResponse), Error>?
        private let lock = NSLock()

        init(progress: @escaping @Sendable (Double) -> Void) { self.progress = progress }

        func begin(_ continuation: CheckedContinuation<(URL, HTTPURLResponse), Error>) {
            lock.lock(); self.continuation = continuation; lock.unlock()
        }

        private func finish(_ result: Result<(URL, HTTPURLResponse), Error>) {
            lock.lock()
            let current = continuation
            continuation = nil
            lock.unlock()
            current?.resume(with: result)
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            if totalBytesExpectedToWrite > 0 { progress(min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            // このメソッドを抜けると一時ファイルが消えるため、ここで自分の場所へ移す。
            let moved = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-dl-\(UUID().uuidString)")
            do {
                try FileManager.default.moveItem(at: location, to: moved)
                guard let response = downloadTask.response as? HTTPURLResponse else { finish(.failure(DownloadError.message("配信先の応答を確認できません。"))); return }
                finish(.success((moved, response)))
            } catch {
                finish(.failure(error))
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let error else { return }
            if (error as? URLError)?.code == .cancelled { finish(.failure(DownloadError.cancelled)) } else { finish(.failure(error)) }
        }

        /// リダイレクト先も、許可したホストだけ。
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if let url = request.url, MediaHostPolicy.isAllowed(url) { completionHandler(request) } else { completionHandler(nil) }
        }
    }
}
