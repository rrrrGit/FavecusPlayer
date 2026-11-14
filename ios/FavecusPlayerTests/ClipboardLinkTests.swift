import XCTest
@testable import FavecusPlayer

/// 短縮リンクの転送を返す、偽の通信（実際のb23.tvには接続しない）。
final class ShortLinkStub: URLProtocol {
    nonisolated(unsafe) static var target: String?
    nonisolated(unsafe) static var requested: [URL] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.requested.append(url)
        if url.host == "b23.tv", let target = Self.target, let destination = URL(string: target) {
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": target])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: destination), redirectResponse: response)
        } else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data())
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ShortLinkStub.self]
        return URLSession(configuration: configuration)
    }
}

/// Bilibiliアプリの「リンクをコピー」で得たテキストから、動画のリンクを取り出す（共有シートへの追加が難しい場合の代わりの入口）。
final class ClipboardLinkTests: XCTestCase {
    override func setUp() {
        ShortLinkStub.target = nil
        ShortLinkStub.requested = []
    }

    func testTheFirstLinkIsExtractedFromACopiedShareText() {
        let text = "【テスト】サンプル曲 https://b23.tv/AbCdEf1 その他のメモ"
        XCTAssertEqual(ClipboardLink.firstURL(in: text)?.absoluteString, "https://b23.tv/AbCdEf1")
        XCTAssertEqual(ClipboardLink.firstURL(in: "https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2")?.absoluteString, "https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2")
        XCTAssertNil(ClipboardLink.firstURL(in: "リンクのない文章"))
        XCTAssertNil(ClipboardLink.firstURL(in: "ftp://example.com/file"), "http／https以外は取り出さない")
    }

    func testOnlyShortLinkHostsAndVideoPagesAreRecognized() throws {
        XCTAssertTrue(ClipboardLink.isShortLink(try XCTUnwrap(URL(string: "https://b23.tv/x"))))
        XCTAssertFalse(ClipboardLink.isShortLink(try XCTUnwrap(URL(string: "https://evil.example.com/x"))))
        XCTAssertTrue(ClipboardLink.isVideoPage(try XCTUnwrap(URL(string: "https://www.bilibili.com/video/BV1aaaaaaaaa/"))))
        XCTAssertFalse(ClipboardLink.isVideoPage(try XCTUnwrap(URL(string: "https://www.bilibili.com/read/cv1"))))
        XCTAssertFalse(ClipboardLink.isVideoPage(try XCTUnwrap(URL(string: "https://evil.example.com/video/BV1aaaaaaaaa/"))))
    }

    func testAShortLinkIsResolvedOnceToTheVideoPage() async throws {
        ShortLinkStub.target = "https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2&share_source=copy"
        let value = await ClipboardLink.normalized("【題名】 https://b23.tv/AbCdEf1", session: ShortLinkStub.session())
        XCTAssertEqual(value, "https://www.bilibili.com/video/BV1aaaaaaaaa/?p=2&share_source=copy")
        XCTAssertEqual(ShortLinkStub.requested.map(\.host), ["b23.tv"], "転送先へは、それ以上通信しない")
    }

    func testAShortLinkThatLeadsElsewhereIsNotFollowedOrTrusted() async throws {
        ShortLinkStub.target = "https://evil.example.com/video/BV1aaaaaaaaa/"
        let resolved = await ClipboardLink.resolve(try XCTUnwrap(URL(string: "https://b23.tv/x")), session: ShortLinkStub.session())
        XCTAssertNil(resolved)
        XCTAssertEqual(ShortLinkStub.requested.map(\.host), ["b23.tv"])
        // 短縮リンクではないURLには、通信しない
        let none = await ClipboardLink.resolve(try XCTUnwrap(URL(string: "https://www.bilibili.com/video/BV1aaaaaaaaa/")), session: ShortLinkStub.session())
        XCTAssertNil(none)
        XCTAssertEqual(ShortLinkStub.requested.count, 1)
    }

    func testAnOrdinaryVideoLinkIsReturnedWithoutAnyRequest() async {
        let value = await ClipboardLink.normalized("  https://www.bilibili.com/video/BV1aaaaaaaaa/  ", session: ShortLinkStub.session())
        XCTAssertEqual(value, "https://www.bilibili.com/video/BV1aaaaaaaaa/")
        XCTAssertTrue(ShortLinkStub.requested.isEmpty)
        let plain = await ClipboardLink.normalized(" BV1aaaaaaaaa ")
        XCTAssertEqual(plain, "BV1aaaaaaaaa", "リンクでないテキスト（BV番号）は、そのまま")
    }
}
