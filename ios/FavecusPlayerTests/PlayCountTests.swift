import XCTest
@testable import FavecusPlayer

/// 再生回数の台帳（PlayCountStore）。数え方・合計・世代・重みの規則は共通JS（Nodeの共通テストで確認済み）。ここでは、Swiftの保存・同期の受け渡しを確認する。
/// 「実再生3秒で1回」の判定は、経過時間と位置の増分を照合するため、実時間が必要で、ここでは扱わない（Nodeのテスト）。
@MainActor
final class PlayCountTests: XCTestCase {
    private var directory: URL!
    private var defaults: UserDefaults!
    private let song = "bili:BV1aaaaaaaaa:p1", other = "bili:BV1bbbbbbbbb:p1", local = "local:0a0b0c0d-0000-4000-8000-000000000001.mp3"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-count-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "favecus-count-test-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore() throws -> PlayCountStore {
        PlayCountStore(core: try SharedCore(bundle: Bundle(for: SharedCore.self)), directory: directory, defaults: defaults)
    }

    private func readState(_ store: PlayCountStore) async throws -> [String: Any] {
        let text = await store.syncRead()
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(text).utf8)) as? [String: Any])
    }

    func testCountsRaiseTheWeightAndSurviveARestart() async throws {
        let store = try makeStore()
        var weights = await store.weights(for: [song, other])
        XCTAssertEqual(weights[song], 1)
        await store.increment(key: song)
        await store.increment(key: song)
        await store.increment(key: other)
        weights = await store.weights(for: [song, other])
        XCTAssertEqual(weights[song] ?? 0, 1.0 / 3.0, accuracy: 0.0001)
        XCTAssertEqual(weights[other], 0.5)
        let count = await store.count(for: song)
        XCTAssertEqual(count, 2)
        let reopened = try makeStore()
        let again = await reopened.weights(for: [song])
        XCTAssertEqual(again[song] ?? 0, 1.0 / 3.0, accuracy: 0.0001, "再起動しても、回数が残る")
    }

    func testResetStartsANewEpochAndZeroesTheWeights() async throws {
        let store = try makeStore()
        await store.increment(key: song)
        await store.reset()
        let weights = await store.weights(for: [song])
        XCTAssertEqual(weights[song], 1)
        await store.increment(key: song)
        let count = await store.count(for: song)
        XCTAssertEqual(count, 1, "リセット後の再生は、また数える")
    }

    func testOnlyBilibiliRowsAreSyncedAndOnlyChangedRowsAfterTheFirstSync() async throws {
        let store = try makeStore()
        await store.increment(key: song)
        await store.increment(key: local) // ローカルの曲は、同期へ送らない
        var state = try await readState(store)
        var rows = try XCTUnwrap(state["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?["key"] as? String, song)
        XCTAssertEqual((state["prefs"] as? [String: Any])?["weighted"] as? Bool, true)
        store.syncPushed()
        state = try await readState(store)
        rows = try XCTUnwrap(state["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 0, "送ったあとは、変わった行だけ")
        await store.increment(key: song)
        state = try await readState(store)
        XCTAssertEqual((state["rows"] as? [[String: Any]])?.count, 1)
    }

    func testRemoteRowsEpochAndPreferenceAreApplied() async throws {
        let store = try makeStore()
        await store.increment(key: song)
        let remote: [String: Any] = ["rows": [["device": "pc1", "epoch": 0, "month": "2027-01", "key": song, "n": 4]], "cursor": 7, "epoch": 0,
                                     "prefs": ["weighted": false, "at": 1234.0]]
        await store.syncApply(String(decoding: try JSONSerialization.data(withJSONObject: remote), as: UTF8.self))
        let count = await store.count(for: song)
        XCTAssertEqual(count, 5, "他の端末の回数が加わる")
        XCTAssertFalse(store.weighted)
        XCTAssertEqual(store.weightedAt, 1234)
        let state = try await readState(store)
        XCTAssertEqual(state["cursor"] as? Int, 7)
        // 世代が進んだ通知は、前の世代の回数を合計から外す
        let reset: [String: Any] = ["rows": [], "cursor": 8, "epoch": 1, "prefs": NSNull()]
        await store.syncApply(String(decoding: try JSONSerialization.data(withJSONObject: reset), as: UTF8.self))
        let afterReset = await store.count(for: song)
        XCTAssertEqual(afterReset, 0)
    }

    func testAChangedPreferenceIsStampedWithATime() throws {
        let store = try makeStore()
        XCTAssertTrue(store.weighted, "既定はオン")
        let before = Date().timeIntervalSince1970 * 1000
        store.setWeighted(false)
        XCTAssertFalse(store.weighted)
        XCTAssertGreaterThanOrEqual(store.weightedAt, before - 1)
    }

    func testADamagedLedgerIsKeptAsideAndCountingStartsOver() async throws {
        try Data("{ broken".utf8).write(to: directory.appendingPathComponent("play-ledger.json"))
        let store = try makeStore()
        XCTAssertNotNil(store.notice)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(names.contains { $0.hasPrefix("play-ledger.damaged-") }, "元の記録は残す")
        await store.increment(key: song)
        let count = await store.count(for: song)
        XCTAssertEqual(count, 1)
    }

    func testPlayHistorySyncsAndRemoteClearKeepsLocalSongs() async throws {
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let hist = PlayHistoryStore(core: core, directory: directory)
        await hist.add(key: song)
        await hist.add(key: local)
        let readText = await hist.syncRead(deviceId: "ios-hist")
        let readObj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(readText).utf8)) as? [String: Any])
        let rows = try XCTUnwrap(readObj["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.map { $0["key"] as? String }, [song], "ローカル曲は送らない")
        hist.syncPushed()
        // リモートの履歴と新しいクリア時刻を取り込む：クリア前の Bilibili 曲は消えるが、ローカル曲は残る
        let futureAt = Int64((Date().timeIntervalSince1970 * 1000).rounded()) + 10_000
        let incoming: [String: Any] = [
            "cursor": 12,
            "clearedAt": futureAt,
            "rows": [
                ["key": other, "at": futureAt + 5000]
            ]
        ]
        await hist.syncApply(String(decoding: try JSONSerialization.data(withJSONObject: incoming), as: UTF8.self))
        let keys = await hist.keys(limit: 10)
        XCTAssertEqual(keys, [other, local], "クリア以前だった song は消え、クリア後の other と端末内 local が残る")
        await hist.clearAndWait()
        let empty = await hist.keys(limit: 10)
        XCTAssertEqual(empty, [], "自分のクリア操作はすべて消す")
        hist.resetSync()
        let resetText = await hist.syncRead(deviceId: "ios-hist")
        let resetObj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(resetText).utf8)) as? [String: Any])
        XCTAssertEqual(resetObj["cursor"] as? Int, 0)
    }
}
