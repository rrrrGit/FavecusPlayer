import XCTest
@testable import FavecusPlayer

final class ErrorTextTests: XCTestCase {
    func testUrlsAreRemovedFromMessages() {
        let text = ErrorText.clean("failed https://upos-hz.example.net/up/1.m4s?e=abc&hdnts=exp~hmac, next")
        XCTAssertFalse(text.contains("https"))
        XCTAssertFalse(text.contains("hmac"))
        XCTAssertTrue(text.contains("next"))
    }

    func testNetworkErrorsKeepTheCodeButNotTheFailingUrl() {
        let underlying = NSError(domain: NSURLErrorDomain, code: -1005, userInfo: [NSURLErrorFailingURLStringKey: "https://upos.example.net/a.m4s?sig=secret", NSLocalizedDescriptionKey: "The network connection was lost."])
        let text = ErrorText.safe(underlying)
        XCTAssertTrue(text.contains("-1005"))
        XCTAssertFalse(text.contains("secret"))
        let url = ErrorText.safe(URLError(.timedOut))
        XCTAssertTrue(url.contains("-1001"))
    }

    func testFileErrorsDoNotExposeTheirFullUserInfo() {
        let error = NSError(domain: NSCocoaErrorDomain, code: 4, userInfo: [NSFilePathErrorKey: "/private/var/mobile/x.zip", NSLocalizedDescriptionKey: "The file doesn't exist."])
        let text = ErrorText.safe(error)
        XCTAssertTrue(text.contains("NSCocoaErrorDomain 4"))
        XCTAssertFalse(text.contains("UserInfo"))
    }
}
