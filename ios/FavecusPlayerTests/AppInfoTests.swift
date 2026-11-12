import XCTest
@testable import FavecusPlayer

final class AppInfoTests: XCTestCase {
    func testNameIsFixed() {
        XCTAssertEqual(AppInfo.name, "FavecusPlayer")
    }

    func testVersionTextContainsName() {
        XCTAssertTrue(AppInfo.versionText.hasPrefix(AppInfo.name))
    }
}
