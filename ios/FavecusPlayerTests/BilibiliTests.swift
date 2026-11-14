import XCTest
@testable import FavecusPlayer

/// URLSessionの代わりに、決まった応答（合成データ）を返す。実際のBilibiliには接続しない（CIのネットワーク・地域に左右されないため、許可する配信先の検査もそのまま確認できる）。
final class StubProtocol: URLProtocol {
    typealias Handler = (URLRequest) -> (status: Int, body: Data)
    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seen: [URLRequest] = []
    private static let lock = NSLock()

    static func install(_ handler: @escaping Handler) {
        lock.lock(); self.handler = handler; seen = []; lock.unlock()
    }

    static var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubProtocol.lock.lock()
        StubProtocol.seen.append(request)
        let handler = StubProtocol.handler
        StubProtocol.lock.unlock()
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)) // 準備のない要求は、失敗にする（黙って通さない）
            return
        }
        let (status, body) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Bilibiliのログイン情報の扱い、情報取得（共通JS）、通信先の制限。応答はすべて合成データ。
final class BilibiliTests: XCTestCase {
    private func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }

    private func make(logIn: Bool = true) throws -> (BilibiliHost, BilibiliCookieVault, BiliCore) {
        let cookies = BilibiliCookieVault(vault: MemoryVault())
        if logIn { try cookies.store(["SESSDATA": "test-session", "bili_jct": "test-csrf", "unrelated": "dropped"]) }
        let host = BilibiliHost(cookies: cookies, session: StubProtocol.session())
        return (host, cookies, try BiliCore(bundle: Bundle(for: SharedCore.self), host: host))
    }

    private let audio: [String: Any] = ["id": 30280, "bandwidth": 192000, "codecs": "mp4a.40.2", "baseUrl": "https://upos.bilivideo.com/a/30280.m4s", "size": 1000]

    private func playHandler() -> StubProtocol.Handler {
        let view: [String: Any] = ["code": 0, "data": ["bvid": "BV1aaaaaaaaa", "aid": 1, "duration": 100, "pic": "https://i0.hdslb.com/pic.jpg", "pages": [["page": 1, "cid": 7, "duration": 100]]]]
        let play: [String: Any] = ["code": 0, "data": ["dash": ["audio": [audio], "video": []], "timelength": 100000]]
        return { [self] request in
            switch request.url?.path {
            case "/x/web-interface/view": return (200, json(view))
            case "/x/player/playurl": return (200, json(play))
            default: return (404, Data())
            }
        }
    }

    func testTheCookieVaultKeepsOnlyWhatIsNeededAndNeverBuildsAnUnsafeHeader() throws {
        let vault = BilibiliCookieVault(vault: MemoryVault())
        XCTAssertNil(vault.header())
        XCTAssertThrowsError(try vault.store(["bili_jct": "x"]), "SESSDATAがなければ保存しない")
        try vault.store(["SESSDATA": "a", "bili_jct": "b", "buvid3": "should-not-be-stored"])
        let header = try XCTUnwrap(vault.header())
        XCTAssertTrue(header.contains("SESSDATA=a") && header.contains("bili_jct=b"))
        XCTAssertFalse(header.contains("buvid3"))
        try vault.store(["SESSDATA": "good", "bili_jct": "bad;value"])
        XCTAssertEqual(vault.header(), "SESSDATA=good", "区切りを含む値は使わない")
        vault.clear()
        XCTAssertFalse(vault.isLoggedIn)
    }

    func testTheHostTalksOnlyToTheApiHostOverHttpsAndAddsCookiesOnlyThere() async throws {
        StubProtocol.install { _ in (200, Data("{\"code\":0}".utf8)) }
        let (host, _, _) = try make()
        for bad in ["https://evil.example.com/x/web-interface/nav", "http://api.bilibili.com/x/web-interface/nav", "https://api.bilibili.com:8443/x", "https://user@api.bilibili.com/x", "https://upos.bilivideo.com/a.m4s"] {
            do { _ = try await host.request(method: "GET", url: bad, json: "{\"headers\":{},\"body\":null}"); XCTFail("拒否されるはず: \(bad)") } catch {}
        }
        XCTAssertTrue(StubProtocol.requests.isEmpty, "許可されない宛先へは通信しない")
        _ = try await host.request(method: "GET", url: "https://api.bilibili.com/x/web-interface/nav?a=1", json: "{\"headers\":{\"Referer\":\"https://www.bilibili.com/\",\"Cookie\":\"injected=1\",\"X-Evil\":\"1\"},\"body\":null}")
        let sent = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Referer"), "https://www.bilibili.com/")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Cookie"), "SESSDATA=test-session; bili_jct=test-csrf")
        XCTAssertNil(sent.value(forHTTPHeaderField: "X-Evil"), "許可した項目以外のヘッダーは付けない")
    }

    @MainActor
    func testTheProfileCheckReportsTheLoginAndClearsAnExpiredLogin() async throws {
        StubProtocol.install { [self] _ in (200, json(["code": 0, "data": ["isLogin": true, "mid": 4242, "uname": "テスト"]])) }
        let (_, cookies, core) = try make()
        let account = BilibiliAccount(cookies: cookies, core: core)
        XCTAssertTrue(account.profile.loggedIn)
        await account.refresh()
        XCTAssertEqual(account.profile, BilibiliAccount.Profile(loggedIn: true, name: "テスト"))
        StubProtocol.install { [self] _ in (200, json(["code": -101])) }
        await account.refresh()
        XCTAssertFalse(account.profile.loggedIn)
        XCTAssertFalse(cookies.isLoggedIn, "期限切れのログイン情報は消す")
        XCTAssertFalse(account.message.isEmpty)
    }

    func testResolveGivesTheAudioStreamThroughTheSharedJavaScript() async throws {
        StubProtocol.install(playHandler())
        let (_, _, core) = try make(logIn: false)
        let media = try await BilibiliService(core: core).resolve(url: "https://www.bilibili.com/video/BV1aaaaaaaaa/", kind: "audio")
        XCTAssertEqual(media.streams.first?.urls.first, "https://upos.bilivideo.com/a/30280.m4s")
        XCTAssertEqual(media.duration, 100)
        XCTAssertTrue(StubProtocol.requests.allSatisfy { $0.url?.host == "api.bilibili.com" && $0.value(forHTTPHeaderField: "Cookie") == nil }, "ログインしていなければCookieは付けない")
    }

    func testRateLimitAndRiskControlStopWithoutRetryingAndAProtectedStreamIsRefused() async throws {
        let (_, _, core) = try make()
        let service = BilibiliService(core: core)
        StubProtocol.install { _ in (412, Data()) }
        do { _ = try await service.resolve(url: "https://www.bilibili.com/video/BV1aaaaaaaaa/", kind: "audio"); XCTFail("止まるはず") }
        catch let error as BilibiliError { XCTAssertTrue(error.stopBatch) }
        XCTAssertEqual(StubProtocol.requests.count, 1, "方法を変えて再試行しない")
        StubProtocol.install { [self] request in
            request.url?.path == "/x/web-interface/view" ? (200, json(["code": 0, "data": ["bvid": "BV1aaaaaaaaa", "aid": 1, "duration": 100, "pages": [["page": 1, "cid": 7, "duration": 100]]]])) : (200, json(["code": 0, "data": ["dash": ["audio": [audio], "video": []], "is_drm": 1]]))
        }
        do { _ = try await service.resolve(url: "https://www.bilibili.com/video/BV1aaaaaaaaa/", kind: "audio"); XCTFail("拒否されるはず") }
        catch { XCTAssertTrue(String(describing: error).contains("保護された動画")) }
    }
}
