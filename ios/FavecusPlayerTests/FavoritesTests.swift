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

    func testLegacyKeysMigrateAtTimestampOneSyncLwwAndExcludeLocal() async throws {
        let localFavs = ["bili:BV1aaaaaaaaa:p1", "local:only.mp3"]
        let legacyData = try JSONSerialization.data(withJSONObject: ["version": 1, "keys": localFavs])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try legacyData.write(to: directory.appendingPathComponent("favorites.json"))
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let store = FavoritesStore(defaults: defaults(), directory: directory, core: core)
        XCTAssertEqual(store.keys, Set(localFavs))
        // 初回の syncRead には local:only.mp3 が含まれず、at=1 の Bilibili 曲のみが返る
        let readText = await store.syncRead(deviceId: "ios-test")
        let readObj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(readText).utf8)) as? [String: Any])
        let rows = try XCTUnwrap(readObj["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?["key"] as? String, "bili:BV1aaaaaaaaa:p1")
        XCTAssertEqual((rows.first?["at"] as? NSNumber)?.int64Value, 1)
        // 同値 at=1 で fav=false が来ても true が優先される。新しい fav=true の別曲は追加され、ローカル曲は残る
        let incoming: [String: Any] = [
            "cursor": 5,
            "rows": [
                ["key": "bili:BV1aaaaaaaaa:p1", "fav": false, "at": 1],
                ["key": "bili:BV1bbbbbbbbb:p1", "fav": true, "at": 1000]
            ]
        ]
        await store.syncApply(String(decoding: try JSONSerialization.data(withJSONObject: incoming), as: UTF8.self))
        XCTAssertTrue(store.contains("bili:BV1aaaaaaaaa:p1"), "同時刻競合はお気に入り優先")
        XCTAssertTrue(store.contains("bili:BV1bbbbbbbbb:p1"))
        XCTAssertTrue(store.contains("local:only.mp3"))
        store.syncPushed()
        // 再送では変化がなければ 0 行
        let readAgain = await store.syncRead(deviceId: "ios-test")
        let againObj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(readAgain).utf8)) as? [String: Any])
        XCTAssertEqual((againObj["rows"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(againObj["cursor"] as? Int, 5)
        // resetSync で cursor=0 に戻る
        store.resetSync()
        let resetText = await store.syncRead(deviceId: "ios-test")
        let resetObj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(resetText).utf8)) as? [String: Any])
        XCTAssertEqual(resetObj["cursor"] as? Int, 0)
        XCTAssertEqual((resetObj["rows"] as? [[String: Any]])?.count, 2)
    }
}
