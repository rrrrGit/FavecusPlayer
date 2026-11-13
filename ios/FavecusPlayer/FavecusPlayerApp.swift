import SwiftUI

@main
struct FavecusPlayerApp: App {
    @StateObject private var environment = AppEnvironment()

    var body: some Scene {
        WindowGroup {
            LibraryRootView(store: environment.store, importer: environment.importer, exporter: environment.exporter, player: environment.player, sync: environment.sync)
        }
    }
}

/// アプリ全体の部品（保存・取り込み）を1か所で作る。
@MainActor
final class AppEnvironment: ObservableObject {
    let store: LibraryStore
    let importer: ImportCoordinator?
    let exporter: ExportCoordinator?
    let player: PlaybackEngine?
    let sync: SyncCoordinator?

    init() {
        do {
            let directory = try LibraryStore.defaultDirectory()
            let core = try SharedCore(bundle: .main)
            let store = LibraryStore(core: core, directory: directory)
            self.store = store
            importer = ImportCoordinator(service: TransferService(core: core), store: store)
            exporter = ExportCoordinator(service: ExportService(core: core), store: store)
            player = PlaybackEngine(core: core, store: store, backend: AVPlayerBackend(), makeSystem: { SystemAudio(controls: $0) })
            // 同期は、再生などとは別のJavaScriptCoreで動かす。Keychainが使えない環境でも、起動は妨げない（同期の画面にエラーとして出る）。
            let vault = KeychainVault()
            let host = StoreSyncHost(store: store, directory: store.syncDirectory, vault: vault)
            sync = (try? SyncCore(bundle: .main, host: host)).map { SyncCoordinator(store: store, core: $0, host: host, vault: vault) }
        } catch {
            // 起動に必要な部品がない：保存データには触らず、画面に理由を出す。
            let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("FavecusPlayer-unavailable")
            store = LibraryStore(core: nil, directory: fallback, startupError: "起動に必要な部品を読み込めません：\(error)")
            importer = nil
            exporter = nil
            player = nil
            sync = nil
        }
    }
}
