import XCTest
@testable import FavecusPlayer

/// Windows版（Node）と同じ共通テストデータ shared/fixtures/cases.json を、JavaScriptCoreで実行する。
final class SharedCoreTests: XCTestCase {
    private struct Failure: Decodable { let name: String; let expected: String; let actual: String }
    private struct Outcome: Decodable { let total: Int; let failures: [Failure] }
    private struct Bench: Decodable {
        let lists: Int; let entries: Int; let validatedLists: Int; let searchTotal: Int
        let validateMs: Int; let shareMs: Int; let searchIndexMs: Int; let searchPageMs: Int; let importMs: Int
    }

    private func core() throws -> SharedCore {
        try SharedCore(bundle: Bundle(for: SharedCore.self))
    }

    func testSharedFixturesMatchWindowsExpectations() throws {
        let url = try XCTUnwrap(Bundle(for: SharedCoreTests.self).url(forResource: "cases", withExtension: "json"))
        let text = try String(contentsOf: url, encoding: .utf8)
        let count = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any]).count
        let outcome = try JSONDecoder().decode(Outcome.self, from: Data(try core().call("RunCases", text).utf8))
        XCTAssertEqual(outcome.total, count)
        for failure in outcome.failures {
            XCTFail("\(failure.name)\n期待: \(failure.expected)\n実際: \(failure.actual)")
        }
        print("FAVECUS_FIXTURES total=\(outcome.total) failures=\(outcome.failures.count)")
    }

    func testBenchmarkOf999ListsAnd10000Entries() throws {
        let bench = try JSONDecoder().decode(Bench.self, from: Data(try core().call("Bench", "{}").utf8))
        XCTAssertEqual(bench.lists, 999)
        XCTAssertEqual(bench.validatedLists, 999)
        XCTAssertGreaterThan(bench.searchTotal, 0)
        // シミュレーター（Macの速度）の値。実機の値とは異なる。
        print("FAVECUS_BENCH sim lists=\(bench.lists) entries=\(bench.entries) validateMs=\(bench.validateMs) shareMs=\(bench.shareMs) searchIndexMs=\(bench.searchIndexMs) searchPageMs=\(bench.searchPageMs) importMs=\(bench.importMs)")
    }
}
