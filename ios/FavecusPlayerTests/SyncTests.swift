import XCTest
@testable import FavecusPlayer

/// iPhone版の同期（共通JSをJavaScriptCoreで実行し、Swiftが保存・通信・Keychainを担う）。
/// CIでは、Node製の偽のSupabase（scripts/fake-supabase-server.cjs）へ実際にHTTPでつなぎ、Windows版（Node）との端末間同期も確認する。
/// 環境変数やファイルがない場合は、スキップではなく失敗にする。
@MainActor
final class SyncTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-sync-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private struct Environment {
        let url: String
        let key: String
        let folder: URL
    }

    private func environment() throws -> Environment {
        let env = ProcessInfo.processInfo.environment
        return Environment(url: try XCTUnwrap(env["FAVECUS_SYNC_SERVER"], "FAVECUS_SYNC_SERVER が渡されていません（CIの設定を確認）"),
                           key: try XCTUnwrap(env["FAVECUS_SYNC_KEY"], "FAVECUS_SYNC_KEY が渡されていません"),
                           folder: URL(fileURLWithPath: try XCTUnwrap(env["FAVECUS_CROSS_DIR"], "FAVECUS_CROSS_DIR が渡されていません")))
    }

    private func makeDevice(vault: SessionVault = MemoryVault(), directory: URL? = nil) async throws -> (LibraryStore, SyncCoordinator, StoreSyncHost) {
        let folder = directory ?? self.directory!
        let store = LibraryStore(core: try SharedCore(bundle: Bundle(for: SharedCore.self)), directory: folder)
        await store.load()
        let host = StoreSyncHost(store: store, directory: store.syncDirectory, vault: vault)
        let sync = SyncCoordinator(store: store, core: try SyncCore(bundle: Bundle(for: SharedCore.self), host: host), host: host, vault: vault)
        return (store, sync, host)
    }

    private func signIn(_ sync: SyncCoordinator, _ env: Environment) async throws {
        try await sync.configure(url: env.url, anonKey: env.key)
        try await sync.sendCode(email: "ios@example.com")
        try await sync.verifyCode(email: "ios@example.com", code: "123456")
    }

    /// 階層・名前・曲の並びだけの見た目（Node側の Canon と同じ形）。
    private func canon(_ store: LibraryStore) throws -> [[String: Any]] {
        let document = try XCTUnwrap(store.document)
        func walk(_ ids: [String]) -> [[String: Any]] {
            ids.compactMap { document.playlist($0) }.map { ["name": $0.name, "includeInAll": $0.includeInAll ?? true, "entries": $0.entries.map(\.title), "children": walk($0.childIds)] }
        }
        return walk(document.rootPlaylistIds)
    }

    private func read(_ env: Environment, _ name: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(contentsOf: env.folder.appendingPathComponent(name)))
    }

    private func wait(_ env: Environment, _ name: String, seconds: Double = 600) async throws {
        let url = env.folder.appendingPathComponent(name)
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if FileManager.default.fileExists(atPath: url.path) { return }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTFail("\(name) が作られませんでした（Windows側の手順が進んでいません）")
    }

    // MARK: 設定・サインイン・Keychain

    func testTheConfigurationRejectsAnUnsafeUrlAndSecretKeys() async throws {
        let (_, sync, _) = try await makeDevice()
        do { try await sync.configure(url: "http://evil.example.com", anonKey: "sb_publishable_abcdefghijklmnopqrst"); XCTFail("拒否されるはず") } catch { XCTAssertTrue(String(describing: error).contains("URL")) }
        do { try await sync.configure(url: "https://abcdefgh.supabase.co", anonKey: "sb_secret_abcdefghijklmnopqrstuvwxyz"); XCTFail("拒否されるはず") } catch { XCTAssertTrue(String(describing: error).contains("秘密")) }
    }

    func testTheKeychainVaultStoresReplacesAndClearsTheSession() throws {
        let vault = KeychainVault(service: "dev.favecus.player.sync.test", account: "test-\(UUID().uuidString)")
        defer { vault.clear() }
        XCTAssertNil(vault.get())
        try vault.set("{\"a\":1}")
        XCTAssertEqual(vault.get(), "{\"a\":1}")
        try vault.set("{\"a\":2}")
        XCTAssertEqual(vault.get(), "{\"a\":2}")
        vault.clear()
        XCTAssertNil(vault.get())
    }

    // MARK: 端末間

    func testAFreshDeviceAdoptsTheRemoteListsWithoutADuplicateDefault() async throws {
        let env = try environment()
        let (store, sync, _) = try await makeDevice()
        try await signIn(sync, env)
        XCTAssertEqual(store.document?.playlists.count, 1, "既定のリストだけの状態から始める")
        try await wait(env, "windows-1.done")
        try await sync.enable()
        XCTAssertEqual(sync.status.state, .idle, sync.status.message)
        XCTAssertTrue((store.document?.playlists.count ?? 0) > 1)
        XCTAssertFalse(store.document?.playlists.contains { $0.name == "お気に入り" } ?? true, "既定リストが重複していない")
        XCTAssertTrue(NSArray(array: try canon(store)).isEqual(try read(env, "windows-1.json")), "Windowsの階層（共有の子リストを含む）と一致する")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.syncDirectory.appendingPathComponent("state.json").path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: store.fileURL.deletingLastPathComponent().path).contains { $0.hasPrefix("library.pre-sync-") }, "有効化前のバックアップ")
        let persisted = try String(contentsOf: store.syncDirectory.appendingPathComponent("state.json"), encoding: .utf8)
        XCTAssertFalse(persisted.contains("accessToken") || persisted.contains("refreshToken"), "トークンは同期データに残さない")
    }

    /// Windows版と同時に編集し、オフラインから再接続して、両端末の見た目が一致する（Node側 cross-device-driver.cjs が最終的に比較する）。
    func testConcurrentEditsOfflineAndReconnectConvergeWithWindows() async throws {
        let env = try environment()
        let (store, sync, _) = try await makeDevice()
        try await signIn(sync, env)
        try await wait(env, "windows-1.done")
        try await sync.enable()
        XCTAssertEqual(sync.status.state, .idle, sync.status.message)
        // オフライン（同期を止めて）で編集する
        sync.disable()
        func list(_ name: String) throws -> PlaylistItem { try XCTUnwrap(store.document?.playlists.first { $0.name == name }, name) }
        store.perform(["type": "create", "name": "iOS新規", "parentId": try list("親B").id, "select": false])
        store.perform(["type": "rename", "playlistId": try list("共有子").id, "name": "共有子(iOS改名)"])
        await store.waitUntilIdle()
        let b = try list("親B")
        store.perform(["type": "title", "playlistId": b.id, "entryId": try XCTUnwrap(b.entries.first).id, "title": "曲B1(iOS)"])
        await store.waitUntilIdle()
        XCTAssertNil(store.notice)
        try Data().write(to: env.folder.appendingPathComponent("ios-A.done"))
        try await wait(env, "windows-2.done")
        // 再接続
        try await sync.enable()
        XCTAssertEqual(sync.status.state, .idle, sync.status.message)
        let synced = await sync.syncNow()
        XCTAssertTrue(synced)
        let final = try canon(store)
        try JSONSerialization.data(withJSONObject: final, options: [.prettyPrinted, .sortedKeys]).write(to: env.folder.appendingPathComponent("ios-final.json"))
        try Data().write(to: env.folder.appendingPathComponent("ios-B.done"))
        let text = String(decoding: try JSONSerialization.data(withJSONObject: final), as: UTF8.self)
        XCTAssertTrue(text.contains("曲W1") && text.contains("親B(W改名)") && text.contains("曲B1(iOS)"), "双方の編集が残っている")
        XCTAssertFalse(text.contains("曲S2"), "Windowsの削除が反映されている")
    }
}
