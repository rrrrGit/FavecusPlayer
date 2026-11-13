import XCTest
@testable import FavecusPlayer

/// Windows版の実際の出力処理で作ったZIP（CIが scripts/make-test-archive.cjs で生成し、環境変数 FAVECUS_TRANSFER_DIR で渡す）を、iPhone版の取り込みで読む。
/// 環境変数やファイルがない場合は、スキップではなく失敗にする（何も確認していないのに成功扱いになるのを防ぐ）。
@MainActor
final class TransferTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-transfer-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func fixture(_ name: String) throws -> URL {
        let folder = try XCTUnwrap(ProcessInfo.processInfo.environment["FAVECUS_TRANSFER_DIR"], "FAVECUS_TRANSFER_DIR が渡されていません（CIの設定を確認）")
        let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "\(name) がありません")
        return url
    }

    private struct Expected: Decodable {
        struct Sizes: Decodable { let A: Int; let B: Int }
        let lists: [String]
        let localSizes: Sizes
    }

    private func expected() throws -> Expected {
        try JSONDecoder().decode(Expected.self, from: Data(contentsOf: fixture("expected.json")))
    }

    private func makeStore() async throws -> (LibraryStore, ImportCoordinator) {
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let store = LibraryStore(core: core, directory: directory)
        await store.load()
        XCTAssertTrue(store.isReady)
        return (store, ImportCoordinator(service: TransferService(core: core), store: store))
    }

    private func wait(_ coordinator: ImportCoordinator, _ predicate: (ImportCoordinator.Phase) -> Bool) async throws {
        let end = Date().addingTimeInterval(30)
        while Date() < end {
            if predicate(coordinator.phase) { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("状態が変わりませんでした: \(coordinator.phase)")
    }

    private func choose(_ coordinator: ImportCoordinator, _ name: String) async throws -> ImportPlan {
        coordinator.begin(url: try fixture(name))
        try await wait(coordinator) { if case .choosing = $0 { return true }; if case .failed = $0 { return true }; return false }
        guard case .choosing(let plan) = coordinator.phase else { XCTFail("取り込み候補を読めませんでした: \(coordinator.phase)"); throw TransferError.message("prepare") }
        return plan
    }

    private func mediaFiles(_ store: LibraryStore) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: store.mediaDirectory.path)) ?? []).sorted()
    }

    func testAWindowsMediaArchiveImportsStructureAndMedia() async throws {
        let (store, coordinator) = try await makeStore()
        let plan = try await choose(coordinator, "windows-media.zip")
        XCTAssertEqual(plan.mode, "media")
        XCTAssertEqual(Set(plan.lists.map(\.name)), Set(try expected().lists))
        await coordinator.commit(ids: plan.lists.map(\.id))
        guard case .done(let outcome) = coordinator.phase else { return XCTFail("取り込めませんでした: \(coordinator.phase)") }
        XCTAssertEqual(outcome.imported, 3)
        XCTAssertEqual(outcome.copied, 1)
        XCTAssertEqual(outcome.missing, 1)
        let names = Set(store.document?.playlists.map(\.name) ?? [])
        XCTAssertTrue(["親", "子", "独立"].allSatisfy(names.contains))
        // 同梱されていたローカル曲の実体が、元のIDではない新しい名前で保存されている
        let files = mediaFiles(store)
        XCTAssertEqual(files.count, 1)
        let size = try FileManager.default.attributesOfItem(atPath: store.mediaDirectory.appendingPathComponent(files[0]).path)[.size] as? Int
        XCTAssertEqual(size, try expected().localSizes.A)
        XCTAssertFalse(files[0].hasPrefix("00000004-"))
        // 再起動後も残る
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let reloaded = LibraryStore(core: core, directory: directory)
        await reloaded.load()
        XCTAssertEqual(Set(reloaded.document?.playlists.map(\.name) ?? []), names)
    }

    func testImportingTheSameArchiveAgainKeepsExistingDataAndNamesTheNewListsApart() async throws {
        let (store, coordinator) = try await makeStore()
        var plan = try await choose(coordinator, "windows-media.zip")
        await coordinator.commit(ids: plan.lists.map(\.id))
        let firstFiles = mediaFiles(store)
        let firstBytes = try Data(contentsOf: store.mediaDirectory.appendingPathComponent(firstFiles[0]))
        coordinator.cancel()
        plan = try await choose(coordinator, "windows-media.zip")
        await coordinator.commit(ids: plan.lists.map(\.id))
        guard case .done = coordinator.phase else { return XCTFail("2回目の取り込みに失敗: \(coordinator.phase)") }
        let names = store.document?.playlists.map(\.name) ?? []
        XCTAssertTrue(names.contains("親"))
        XCTAssertTrue(names.contains { $0.hasPrefix("親（取り込み") })
        let files = mediaFiles(store)
        XCTAssertEqual(files.count, 2)
        XCTAssertTrue(files.contains(firstFiles[0]))
        XCTAssertEqual(try Data(contentsOf: store.mediaDirectory.appendingPathComponent(firstFiles[0])), firstBytes, "既存のメディアは変更しない")
    }

    func testAnInformationArchiveImportsOnlyTheStructure() async throws {
        let (store, coordinator) = try await makeStore()
        let plan = try await choose(coordinator, "windows-info.zip")
        XCTAssertEqual(plan.mode, "information")
        await coordinator.commit(ids: plan.lists.map(\.id))
        guard case .done(let outcome) = coordinator.phase else { return XCTFail("取り込めませんでした: \(coordinator.phase)") }
        XCTAssertEqual(outcome.copied, 0)
        XCTAssertEqual(outcome.omitted, 2)
        XCTAssertTrue(mediaFiles(store).isEmpty)
    }

    func testACorruptMediaEntryFailsAndLeavesNothingBehind() async throws {
        let (store, coordinator) = try await makeStore()
        let before = store.currentText
        let plan = try await choose(coordinator, "corrupt-media.zip")
        await coordinator.commit(ids: plan.lists.map(\.id))
        guard case .failed(let message) = coordinator.phase else { return XCTFail("失敗するはず: \(coordinator.phase)") }
        XCTAssertTrue(message.contains("壊れています"), message)
        XCTAssertEqual(store.currentText, before, "ライブラリは変更しない")
        XCTAssertTrue(mediaFiles(store).isEmpty, "公開済み・ステージングのファイルが残らない: \(mediaFiles(store))")
    }

    func testSelectingOnlyAChildBringsItsAncestorAsAContainer() async throws {
        let (store, coordinator) = try await makeStore()
        let plan = try await choose(coordinator, "windows-info.zip")
        let child = try XCTUnwrap(plan.lists.first { $0.name == "子" })
        await coordinator.commit(ids: [child.id])
        guard case .done(let outcome) = coordinator.phase else { return XCTFail("取り込めませんでした: \(coordinator.phase)") }
        XCTAssertEqual(outcome.imported, 2)
        let names = Set(store.document?.playlists.map(\.name) ?? [])
        XCTAssertTrue(names.contains("親"))
        XCTAssertTrue(names.contains("子"))
        XCTAssertFalse(names.contains("独立"))
        let parent = try XCTUnwrap(store.document?.playlists.first { $0.name == "親" })
        XCTAssertTrue(parent.entries.isEmpty, "選ばなかった祖先の曲は取り込まない")
    }

    func testANonArchiveIsRejectedWithoutChangingTheLibrary() async throws {
        let (store, coordinator) = try await makeStore()
        let before = store.currentText
        let junk = directory.appendingPathComponent("junk.zip")
        try Data(repeating: 7, count: 4096).write(to: junk)
        coordinator.begin(url: junk)
        try await wait(coordinator) { if case .failed = $0 { return true }; return false }
        XCTAssertEqual(store.currentText, before)
    }

    func testTheZipReaderRejectsTruncatedAndInvalidData() throws {
        let data = try Data(contentsOf: fixture("windows-info.zip"))
        XCTAssertNoThrow(try ZipArchive(source: DataSource(data)))
        XCTAssertThrowsError(try ZipArchive(source: DataSource(data.prefix(data.count - 10))))
        XCTAssertThrowsError(try ZipArchive(source: DataSource(Data(repeating: 0, count: 100))))
        XCTAssertThrowsError(try ZipArchive(source: DataSource(Data())))
    }

    func testAPasswordProtectedContainerIsReportedClearly() {
        var bytes = Data("FVPA0001".utf8)
        bytes.append(Data(repeating: 1, count: 80))
        XCTAssertThrowsError(try Fvpa.decrypt(bytes)) { XCTAssertTrue(String(describing: $0).contains("パスワード")) }
        XCTAssertThrowsError(try Fvpa.decrypt(Data("garbage".utf8)))
    }
}
