import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// 取り込みの進行（候補の読み取り → 選択 → 取り込み）。画面はこの状態を表示するだけ。
@MainActor
final class ImportCoordinator: ObservableObject {
    enum Phase {
        case idle
        case preparing
        case choosing(ImportPlan)
        case importing
        case done(ImportOutcome)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle

    private let service: TransferService
    private let store: LibraryStore
    private var scopedURL: URL?

    init(service: TransferService, store: LibraryStore) {
        self.service = service
        self.store = store
    }

    /// ファイルアプリ等から選んだ（またはOpen-inで渡された）ZIPを読み取る。選択中はセキュリティスコープを保持する。
    func begin(url: URL) {
        endAccess()
        guard store.isReady else {
            phase = .failed("保存データを開けないため、取り込めません。")
            return
        }
        if url.startAccessingSecurityScopedResource() { scopedURL = url }
        phase = .preparing
        Task {
            do {
                phase = .choosing(try await service.prepare(url: url))
            } catch {
                phase = .failed(String(describing: error))
                endAccess()
            }
        }
    }

    func commit(ids: [String]) async {
        guard case .choosing(let plan) = phase else { return }
        phase = .importing
        #if canImport(UIKit)
        let background = UIApplication.shared.beginBackgroundTask(withName: "favecus-import")
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        #endif
        await store.waitUntilIdle()
        do {
            try store.prepareMediaDirectory()
            let base = store.currentText
            let built = try await service.build(plan: plan, ids: ids, parentId: nil, libraryText: base, mediaDirectory: store.mediaDirectory)
            do { try store.replaceLibrary(expecting: base, with: built.newText) }
            catch { service.rollback(built.published); throw error }
            phase = .done(built.outcome)
        } catch {
            phase = .failed(String(describing: error))
        }
        endAccess()
    }

    func cancel() {
        endAccess()
        phase = .idle
    }

    private func endAccess() {
        scopedURL?.stopAccessingSecurityScopedResource()
        scopedURL = nil
    }
}
