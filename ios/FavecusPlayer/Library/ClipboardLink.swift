import Foundation
import UIKit

/// Bilibiliアプリの「リンクをコピー」で得たテキスト（「【題名】 https://b23.tv/…」のような形）から、動画のURLを取り出す。
/// 曲の追加の規則（URLの解釈・重複・保存）は共通JS。ここは、貼り付けたテキストを整える入口だけ（短縮リンクは、1回だけ転送先を確かめる。Cookieは送らない）。
enum ClipboardLink {
    static let shortHosts: Set<String> = ["b23.tv", "bili2233.cn"]
    static let videoHosts: Set<String> = ["www.bilibili.com", "bilibili.com", "m.bilibili.com"]

    /// テキストの中の、最初のhttps（またはhttp）のリンク。
    static func firstURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        for match in detector?.matches(in: text, options: [], range: range) ?? [] {
            if let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" { return url }
        }
        return nil
    }

    static func isShortLink(_ url: URL) -> Bool { url.host.map { shortHosts.contains($0.lowercased()) } ?? false }

    /// 動画ページのURLか（www.bilibili.com / m.bilibili.com / bilibili.com の /video/）。
    static func isVideoPage(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), videoHosts.contains(host) else { return false }
        return url.path.hasPrefix("/video/")
    }

    /// 短縮リンクの転送先（最初の1回だけ）。短縮の宛先（b23.tv など）以外へは通信せず、転送先が動画ページでなければ nil。
    static func resolve(_ url: URL, session: URLSession? = nil) async -> URL? {
        guard isShortLink(url), url.scheme?.lowercased() == "https" else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        let capture = RedirectCapture()
        let used = session ?? URLSession(configuration: configuration)
        defer { if session == nil { used.invalidateAndCancel() } }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        _ = try? await used.data(for: request, delegate: capture)
        guard let target = capture.first, isVideoPage(target) else { return nil }
        return target
    }

    /// 追加の欄へ入れる文字列：テキストの中のリンクを取り出し、短縮リンクなら動画ページへ置き換える。リンクがなければ、元のテキスト。
    static func normalized(_ text: String, session: URLSession? = nil) async -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let link = firstURL(in: trimmed) else { return trimmed }
        if isShortLink(link) { return await resolve(link, session: session)?.absoluteString ?? link.absoluteString }
        return link.absoluteString
    }

    /// クリップボードに、Webのリンクらしいものがあるか。内容を読まないため、「他のAppからペースト」の許可を求められない。
    @MainActor
    static func pasteboardHasLink() async -> Bool {
        await withCheckedContinuation { continuation in
            UIPasteboard.general.detectPatterns(for: [.probableWebURL]) { result in
                if case .success(let patterns) = result { continuation.resume(returning: patterns.contains(.probableWebURL)) } else { continuation.resume(returning: false) }
            }
        }
    }
}

/// 最初の転送（リダイレクト）先だけを記録して、それ以上は追わない。
final class RedirectCapture: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var found: URL?

    var first: URL? { lock.lock(); defer { lock.unlock() }; return found }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock()
        if found == nil { found = request.url }
        lock.unlock()
        completionHandler(nil)
    }
}
