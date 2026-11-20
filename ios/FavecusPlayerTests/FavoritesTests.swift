import XCTest
@testable import FavecusPlayer

/// お気に入り（v0.7.4 G）。規則は、PC版の test/favorites.test.cjs と同じ。
@MainActor
final class FavoritesTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "favecus-favorites-\(UUID().uuidString)")! }

    func testKeysSurviveARestartAndBadKeysAreRejected() {
        let suite = defaults()
        let store = FavoritesStore(defaults: suite)
        XCTAssertTrue(store.set("bili:BV1aaaaaaaaa:p1", true))
        XCTAssertTrue(store.set("local:song.mp3", true))
        XCTAssertEqual(FavoritesStore(defaults: suite).keys, ["bili:BV1aaaaaaaaa:p1", "local:song.mp3"])
        XCTAssertTrue(store.set("local:song.mp3", false))
        XCTAssertFalse(FavoritesStore(defaults: suite).contains("local:song.mp3"))
        for bad in ["", "a b", String(repeating: "x", count: 201), "../etc"] { XCTAssertFalse(store.set(bad, true), bad) }
        XCTAssertFalse(store.set(nil, true))
        XCTAssertFalse(store.contains(nil))
    }

    func testMalformedStorageIsIgnored() {
        let suite = defaults()
        suite.set(["ok:1", "bad key", String(repeating: "x", count: 300)], forKey: "favoriteKeys")
        XCTAssertEqual(FavoritesStore(defaults: suite).keys, ["ok:1"])
        suite.set("not an array", forKey: "favoriteKeys")
        XCTAssertTrue(FavoritesStore(defaults: suite).keys.isEmpty)
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
