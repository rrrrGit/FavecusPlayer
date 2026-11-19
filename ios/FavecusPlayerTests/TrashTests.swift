import XCTest
@testable import FavecusPlayer

/// 最近削除（v0.7.3 F4）。保管と復元の規則は共通JS（Nodeのテストで確認）。ここでは、保管ファイル・期限・Swiftからの受け渡しを確認する。
@MainActor
final class TrashTests: XCTestCase {
    private var directory: URL!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-trash-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func isoText(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func item(_ id: String, deleted: Date) -> String {
        let object: [String: Any] = ["id": id, "kind": "entry", "label": "曲「\(id)」", "deletedAt": isoText(deleted), "playlistId": "p", "index": 0]
        return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    func testKeepsItemsAcrossARestartAndDropsMalformedOnes() {
        let store = TrashStore(directory: directory, now: { [unowned self] in self.clock })
        XCTAssertTrue(store.add(json: item("a", deleted: clock)))
        XCTAssertFalse(store.add(json: "{ not json"))
        XCTAssertFalse(store.add(json: #"{"id":"x","kind":"weird","label":"x","deletedAt":"2026-01-01T00:00:00.000Z"}"#), "種類が正しくないものは入れない")
        XCTAssertEqual(store.items.map(\.id), ["a"])
        let again = TrashStore(directory: directory, now: { [unowned self] in self.clock })
        XCTAssertEqual(again.items.map(\.id), ["a"])
        XCTAssertEqual(again.items.first?.daysLeft(now: clock), 30)
        XCTAssertNotNil(again.item(id: "a"))
        // 壊れたファイルは、空から始める
        try? Data("{ broken".utf8).write(to: directory.appendingPathComponent("trash.json"))
        XCTAssertTrue(TrashStore(directory: directory, now: { [unowned self] in self.clock }).items.isEmpty)
    }

    func testItemsOlderThanThirtyDaysAreDroppedAndTheNewestTwoHundredKept() {
        let store = TrashStore(directory: directory, now: { [unowned self] in self.clock })
        store.add(json: item("old", deleted: clock.addingTimeInterval(-31 * 86400)))
        store.add(json: item("fresh", deleted: clock.addingTimeInterval(-3 * 86400)))
        XCTAssertEqual(store.items.map(\.id), ["fresh"], "30日を過ぎたものは入れない")
        for n in 0..<250 { store.add(json: item("n\(n)", deleted: clock.addingTimeInterval(TimeInterval(-n)))) }
        XCTAssertEqual(store.items.count, TrashStore.maxItems)
        store.remove(id: store.items[0].id)
        XCTAssertEqual(store.items.count, TrashStore.maxItems - 1)
        store.clear()
        XCTAssertTrue(TrashStore(directory: directory, now: { [unowned self] in self.clock }).items.isEmpty)
    }

    private func makeStore() throws -> LibraryStore {
        LibraryStore(core: try SharedCore(bundle: Bundle(for: SharedCore.self)), directory: directory)
    }

    func testDeletingAPlaylistKeepsItAndRestoringBringsItBackThroughTheSharedRule() async throws {
        let store = try makeStore()
        await store.load()
        store.perform(["type": "create", "name": "消すリスト", "select": false])
        await store.waitUntilIdle()
        let target = try XCTUnwrap(store.document?.playlists.first { $0.name == "消すリスト" })
        store.perform(["type": "delete", "playlistId": target.id])
        await store.waitUntilIdle()
        XCTAssertNil(store.document?.playlists.first { $0.id == target.id })
        XCTAssertEqual(store.trash.items.count, 1, "削除は、保存のあとに保管される")
        XCTAssertTrue(store.trash.items[0].label.contains("消すリスト"))
        // 再起動しても、保管は残る
        let reopened = try makeStore()
        await reopened.load()
        XCTAssertEqual(reopened.trash.items.count, 1)
        // 元に戻す（共通JSの規則）：同じIDで戻り、保管から外れる
        reopened.restoreFromTrash(id: reopened.trash.items[0].id)
        await reopened.waitUntilIdle()
        XCTAssertNotNil(reopened.document?.playlists.first { $0.id == target.id })
        XCTAssertTrue(reopened.trash.items.isEmpty)
        // 同じ項目を、もう一度戻そうとしても（保管にない）、何も変わらない
        XCTAssertEqual(reopened.document?.playlists.filter { $0.id == target.id }.count, 1)
    }

    func testAFailedRestoreKeepsTheTrashedItemAndExplainsWhy() async throws {
        let store = try makeStore()
        await store.load()
        store.perform(["type": "create", "name": "二重に戻すリスト", "select": false])
        await store.waitUntilIdle()
        let target = try XCTUnwrap(store.document?.playlists.first { $0.name == "二重に戻すリスト" })
        store.perform(["type": "delete", "playlistId": target.id])
        await store.waitUntilIdle()
        let kept = try XCTUnwrap(store.trash.items.first)
        // 別の経路（同期など）で、同じIDのリストがすでに戻っている状態を作る：保管の項目のコピーを、先に復元しておく
        let again = try XCTUnwrap(store.trash.item(id: kept.id))
        store.perform(["type": "restore", "item": again])
        await store.waitUntilIdle()
        XCTAssertNotNil(store.document?.playlists.first { $0.id == target.id })
        store.restoreFromTrash(id: kept.id) // すでにある → 失敗する
        await store.waitUntilIdle()
        XCTAssertEqual(store.trash.items.count, 1, "失敗したときは、保管を残す")
        XCTAssertTrue(store.notice?.contains("すでに戻っています") == true, store.notice ?? "（通知なし）")
        XCTAssertEqual(store.document?.playlists.filter { $0.id == target.id }.count, 1)
    }
}
