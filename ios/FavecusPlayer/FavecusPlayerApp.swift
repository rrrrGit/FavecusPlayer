import SwiftUI

@main
struct FavecusPlayerApp: App {
    @StateObject private var store = FavecusPlayerApp.makeStore()

    var body: some Scene {
        WindowGroup {
            LibraryRootView(store: store)
        }
    }

    @MainActor
    private static func makeStore() -> LibraryStore {
        do {
            let directory = try LibraryStore.defaultDirectory()
            let core = try SharedCore(bundle: .main)
            return LibraryStore(core: core, directory: directory)
        } catch {
            // 起動に必要な部品がない：保存データには触らず、画面に理由を出す。
            let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("FavecusPlayer-unavailable")
            return LibraryStore(core: nil, directory: fallback, startupError: "起動に必要な部品を読み込めません：\(error)")
        }
    }
}
