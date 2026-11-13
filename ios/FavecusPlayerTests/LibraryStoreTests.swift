import XCTest
@testable import FavecusPlayer

/// iPhone版のローカル保存（LibraryStore）と、onMoveの変換（MoveMapper）。編集の規則そのものは共通JS側（共通テストデータ）で確認する。
@MainActor
final class LibraryStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore() throws -> LibraryStore {
        LibraryStore(core: try SharedCore(bundle: Bundle(for: SharedCore.self)), directory: directory)
    }

    private func read(_ name: String) throws -> String {
        try String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8)
    }

    func testNewLibraryIsCreatedWithALowercaseIdAndSaved() async throws {
        let store = try makeStore()
        await store.load()
        XCTAssertEqual(store.state, .ready)
        let lists = try XCTUnwrap(store.document?.playlists)
        XCTAssertEqual(lists.count, 1)
        XCTAssertEqual(lists[0].id, lists[0].id.lowercased())
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL.path))
    }

    func testEditsPersistAcrossReloadAndKeepABackup() async throws {
        let store = try makeStore()
        await store.load()
        store.perform(["type": "create", "name": "親", "select": false])
        store.perform(["type": "create", "name": "二つ目", "select": false])
        await store.waitUntilIdle()
        let first = try XCTUnwrap(store.document?.playlists.first { $0.name == "親" })
        store.perform(["type": "rename", "playlistId": first.id, "name": "改名"])
        await store.waitUntilIdle()
        XCTAssertNil(store.notice)

        let reloaded = try makeStore()
        await reloaded.load()
        XCTAssertEqual(reloaded.state, .ready)
        XCTAssertEqual(Set(reloaded.document?.playlists.map(\.name) ?? []), Set(["お気に入り", "改名", "二つ目"]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.backupURL.path))
    }

    func testReorderMovesListsAmongSiblings() async throws {
        let store = try makeStore()
        await store.load()
        store.perform(["type": "create", "name": "B", "select": false])
        store.perform(["type": "create", "name": "C", "select": false])
        await store.waitUntilIdle()
        let ids = try XCTUnwrap(store.document).rootPlaylistIds
        XCTAssertEqual(ids.count, 3)
        let move = try XCTUnwrap(MoveMapper.map(ids: ids, from: IndexSet(integer: 2), to: 0))
        store.perform(["type": "playlist-reorder", "playlistId": move.id, "targetId": move.targetId, "after": move.after])
        await store.waitUntilIdle()
        XCTAssertEqual(try XCTUnwrap(store.document).rootPlaylistIds, [ids[2], ids[0], ids[1]])
    }

    func testAFailedEditIsReportedAndNothingIsSaved() async throws {
        let store = try makeStore()
        await store.load()
        let before = try read("library.json")
        store.perform(["type": "delete", "playlistId": try XCTUnwrap(store.document?.playlists.first).id])
        await store.waitUntilIdle()
        XCTAssertNotNil(store.notice)
        XCTAssertEqual(try read("library.json"), before)
        XCTAssertEqual(store.document?.playlists.count, 1)
    }

    func testDamagedFileFallsBackToTheBackupAndKeepsTheDamagedFile() async throws {
        let store = try makeStore()
        await store.load()
        store.perform(["type": "create", "name": "残る", "select": false])
        await store.waitUntilIdle()
        store.perform(["type": "create", "name": "最後", "select": false])
        await store.waitUntilIdle()
        try "{broken".write(to: store.fileURL, atomically: true, encoding: .utf8)

        let reloaded = try makeStore()
        await reloaded.load()
        XCTAssertEqual(reloaded.state, .ready)
        XCTAssertNotNil(reloaded.notice)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasPrefix("library.json.damaged-") })
    }

    func testDamagedFileWithoutABackupBlocksAndIsNotOverwritten() async throws {
        let file = directory.appendingPathComponent("library.json")
        try "{broken".write(to: file, atomically: true, encoding: .utf8)
        let store = try makeStore()
        await store.load()
        guard case .blocked = store.state else { return XCTFail("blocked になるはず: \(store.state)") }
        store.perform(["type": "create", "name": "x"])
        await store.waitUntilIdle()
        XCTAssertEqual(try read("library.json"), "{broken")
    }

    func testAnUnsupportedIdentityVersionBlocksAndIsNotOverwritten() async throws {
        let text = "{\"version\":3,\"identityVersion\":3,\"rootPlaylistIds\":[],\"playlists\":[]}"
        try text.write(to: directory.appendingPathComponent("library.json"), atomically: true, encoding: .utf8)
        let store = try makeStore()
        await store.load()
        guard case .blocked = store.state else { return XCTFail("blocked になるはず: \(store.state)") }
        XCTAssertEqual(try read("library.json"), text)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.backupURL.path))
    }

    func testMoveMapperTranslatesOnMoveIntoBeforeAndAfter() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(MoveMapper.map(ids: ids, from: IndexSet(integer: 0), to: 3), MoveMapper.Result(id: "a", targetId: "c", after: true))
        XCTAssertEqual(MoveMapper.map(ids: ids, from: IndexSet(integer: 3), to: 0), MoveMapper.Result(id: "d", targetId: "a", after: false))
        XCTAssertEqual(MoveMapper.map(ids: ids, from: IndexSet(integer: 1), to: 4), MoveMapper.Result(id: "b", targetId: "d", after: true))
        XCTAssertNil(MoveMapper.map(ids: ids, from: IndexSet(integer: 1), to: 1))
        XCTAssertNil(MoveMapper.map(ids: ids, from: IndexSet(integer: 1), to: 2))
        XCTAssertNil(MoveMapper.map(ids: ids, from: IndexSet([0, 1]), to: 3))
    }
}
