import Foundation
import JavaScriptCore

/// Bilibili情報取得用のJavaScriptCore（再生・同期とは別のJSVirtualMachine）。通信はSwift側の BilibiliHost が行い、規則は共通JS（FavecusCore.BiliResolve / BiliProfile）。
protocol RequestHost: AnyObject, Sendable {
    func request(method: String, url: String, json: String) async throws -> String
}

final class BiliCore: @unchecked Sendable {
    private let machine = JSVirtualMachine()
    private let context: JSContext
    private let queue = DispatchQueue(label: "dev.favecus.bilicore")
    private var errors: [String] = []

    init(source: String, host: RequestHost) throws {
        guard let machine, let created = JSContext(virtualMachine: machine) else { throw SharedCoreError.contextUnavailable }
        context = created
        context.exceptionHandler = { [weak self] _, exception in self?.errors.append(exception?.toString() ?? "unknown") }
        let object = JSValue(newObjectIn: context)
        let request: @convention(block) (String, String, String) -> JSValue = { [unowned self] method, url, json in
            JSValue(newPromiseIn: context) { [queue] resolve, reject in
                Task {
                    do {
                        let value = try await host.request(method: method, url: url, json: json)
                        queue.async { _ = resolve?.call(withArguments: [value]) }
                    } catch {
                        let message = ErrorText.safe(error)
                        queue.async { _ = reject?.call(withArguments: [message]) }
                    }
                }
            }
        }
        object?.setObject(request, forKeyedSubscript: "request" as NSString)
        context.setObject(object, forKeyedSubscript: "__favecusHost" as NSString)
        context.evaluateScript(source, withSourceURL: URL(string: "favecus-core.js"))
        if !errors.isEmpty { throw SharedCoreError.script(errors.joined(separator: " / ")) }
    }

    convenience init(bundle: Bundle, host: RequestHost) throws {
        guard let url = bundle.url(forResource: "favecus-core", withExtension: "js") else { throw SharedCoreError.missingResource("favecus-core.js") }
        try self.init(source: String(contentsOf: url, encoding: .utf8), host: host)
    }

    /// FavecusCore.<function>(argument)（Promiseの解決を待つ）。JSON文字列を返す。
    func call(_ function: String, _ argument: String = "{}") async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.errors.removeAll()
                guard let core = self.context.objectForKeyedSubscript("FavecusCore"), let target = core.objectForKeyedSubscript(function), !target.isUndefined else {
                    continuation.resume(throwing: SharedCoreError.missingResource("FavecusCore.\(function)"))
                    return
                }
                let result = target.call(withArguments: [argument])
                if !self.errors.isEmpty { continuation.resume(throwing: SharedCoreError.script(self.errors.joined(separator: " / "))); return }
                guard let result, result.isObject, result.hasProperty("then") else { continuation.resume(throwing: SharedCoreError.invalidResult(function)); return }
                let fulfilled: @convention(block) (JSValue) -> Void = { value in
                    if value.isString, let text = value.toString() { continuation.resume(returning: text) }
                    else { continuation.resume(throwing: SharedCoreError.invalidResult(function)) }
                }
                let rejected: @convention(block) (JSValue) -> Void = { error in continuation.resume(throwing: SharedCoreError.script(error.toString() ?? "rejected")) }
                result.invokeMethod("then", withArguments: [fulfilled, rejected])
            }
        }
    }
}

/// api.bilibili.com への要求だけを行う。Cookie（ログイン情報）は、このホスト宛てにだけ付ける（動画の配信先・サムネイルには付けない）。
/// 通常のWebと同じ方法で取得できるものだけを扱い、拒否・制限の応答は、そのまま呼び出し元へ返す（回避しない）。
final class BilibiliHost: RequestHost, @unchecked Sendable {
    private let cookies: BilibiliCookieVault
    private let session: URLSession

    /// 既定の通信は、保存（キャッシュ・Cookie）をしない専用の設定。リダイレクトは、どこへも追従しない（Cookieを他のホストへ送らない）。
    init(cookies: BilibiliCookieVault, session: URLSession? = nil) {
        self.cookies = cookies
        if let session { self.session = session } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            self.session = URLSession(configuration: configuration)
        }
    }

    private final class RefuseRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    func request(method: String, url: String, json: String) async throws -> String {
        guard method == "GET", let target = URL(string: url), target.scheme == "https", target.host == "api.bilibili.com", target.user == nil, target.password == nil, target.port == nil else {
            throw TransferError.message("接続先が許可されていません。")
        }
        var request = URLRequest(url: target)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        if let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], let headers = object["headers"] as? [String: Any] {
            for (name, value) in headers where ["Referer", "Accept"].contains(name) { request.setValue("\(value)", forHTTPHeaderField: name) } // 許可した項目だけ
        }
        if let header = cookies.header() { request.setValue(header, forHTTPHeaderField: "Cookie") }
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request, delegate: RefuseRedirect())
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let parsed = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) ?? NSNull()
        let output = try JSONSerialization.data(withJSONObject: ["status": status, "json": parsed], options: [.fragmentsAllowed])
        return String(decoding: output, as: UTF8.self)
    }
}

/// ログイン情報（Cookie）の保管。必要なものだけをKeychainへ（SESSDATAなど）。設定・ライブラリ・同期・ZIP・ログには出さない。
final class BilibiliCookieVault: @unchecked Sendable {
    /// APIの利用に必要なCookie名だけを保存する。
    static let allowed: Set<String> = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]

    private let vault: SessionVault

    init(vault: SessionVault = KeychainVault(service: "dev.favecus.player.bilibili", account: "cookies")) { self.vault = vault }

    var isLoggedIn: Bool { header() != nil }

    /// "name=value; name=value"。Cookieがなければnil。値に制御文字・区切りが含まれるものは使わない。
    func header() -> String? {
        guard let text = vault.get(), let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: String] else { return nil }
        let parts = object.sorted { $0.key < $1.key }.filter { Self.allowed.contains($0.key) && !$0.value.contains(where: { $0 == ";" || $0 == "\r" || $0 == "\n" }) }.map { "\($0.key)=\($0.value)" }
        return object["SESSDATA"] == nil || parts.isEmpty ? nil : parts.joined(separator: "; ")
    }

    func store(_ cookies: [String: String]) throws {
        let filtered = cookies.filter { Self.allowed.contains($0.key) }
        guard filtered["SESSDATA"] != nil else { throw TransferError.message("ログイン情報を取得できませんでした。") }
        try vault.set(String(decoding: try JSONSerialization.data(withJSONObject: filtered), as: UTF8.self))
    }

    func clear() { vault.clear() }
}
