import XCTest
@testable import FavecusPlayer

/// お気に入り（v0.7.4 G）。規則は、PC版の test/favorites.test.cjs と同じ。
@MainActor
final class FavoritesTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "favecus-favorites-\(UUID().uuidString)")! }
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-fav-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    func testKeysSurviveARestartAndBadKeysAreRejected() {
        let suite = defaults()
        let store = FavoritesStore(defaults: suite, directory: directory)
        XCTAssertTrue(store.set("bili:BV1aaaaaaaaa:p1", true))
        XCTAssertTrue(store.set("local:song.mp3", true))
        XCTAssertEqual(FavoritesStore(defaults: suite, directory: directory).keys, ["bili:BV1aaaaaaaaa:p1", "local:song.mp3"])
        XCTAssertTrue(store.set("local:song.mp3", false))
        XCTAssertFalse(FavoritesStore(defaults: suite, directory: directory).contains("local:song.mp3"))
        for bad in ["", "a b", String(repeating: "x", count: 201), "../etc"] { XCTAssertFalse(store.set(bad, true), bad) }
        XCTAssertFalse(store.set(nil, true))
        XCTAssertFalse(store.contains(nil))
    }

    func testTheOldUserDefaultsSaveMovesToAFileOnceAndIsThenRemoved() {
        let suite = defaults()
        suite.set(["ok:1", "bad key", "local:a.mp3"], forKey: "favoriteKeys")
        XCTAssertEqual(FavoritesStore(defaults: suite, directory: directory).keys, ["ok:1", "local:a.mp3"])
        XCTAssertNil(suite.array(forKey: "favoriteKeys"), "移行したあと、古い保存は消える")
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("favorites.json").path))
        XCTAssertEqual(FavoritesStore(defaults: suite, directory: directory).keys, ["ok:1", "local:a.mp3"], "ファイルから読める")
    }

    func testABrokenFileIsKeptUnderAnotherNameAndTheStoreStartsEmpty() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{ broken".utf8).write(to: directory.appendingPathComponent("favorites.json"))
        let store = FavoritesStore(defaults: defaults(), directory: directory)
        XCTAssertTrue(store.keys.isEmpty)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(names.contains { $0.hasPrefix("favorites.broken-") }, "壊れたファイルは消さずに残す")
        XCTAssertTrue(store.set("ok:2", true))
        XCTAssertEqual(FavoritesStore(defaults: defaults(), directory: directory).keys, ["ok:2"])
    }

    func testMalformedStorageIsIgnored() {
        let suite = defaults()
        suite.set(["ok:1", "bad key", String(repeating: "x", count: 300)], forKey: "favoriteKeys")
        XCTAssertEqual(FavoritesStore(defaults: suite, directory: directory).keys, ["ok:1"])
        let other = directory.appendingPathComponent("second") // 保存のファイルがまだない場所では、古い保存の形式が不正なら、空
        suite.set("not an array", forKey: "favoriteKeys")
        XCTAssertTrue(FavoritesStore(defaults: suite, directory: other).keys.isEmpty)
    }

    /// 重みの倍率は、共通JS（PC版と同じ1.5倍）。お気に入りだけに掛かる。
    func testTheSharedWeightBoostsOnlyFavorites() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-fav-weights-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let counts = PlayCountStore(core: try SharedCore(bundle: Bundle(for: SharedCore.self)), directory: directory, defaults: defaults())
        let plain = await counts.weights(for: ["local:a.mp3", "local:b.mp3"])
        XCTAssertEqual(plain["local:a.mp3"], 1)
        let boosted = await counts.weights(for: ["local:a.mp3", "local:b.mp3"], favorites: ["local:a.mp3"])
        XCTAssertEqual(boosted["local:a.mp3"], 1.5)
        XCTAssertEqual(boosted["local:b.mp3"], 1)
    }
}
