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
    private var generation = 0

    /// 読み取り中・取り込み中は、新しい操作や中断を受け付けない。
    var isBusy: Bool {
        switch phase {
        case .preparing, .importing: return true
        default: return false
        }
    }

    init(service: TransferService, store: LibraryStore) {
        self.service = service
        self.store = store
    }

    /// ファイルアプリ等から選んだ（またはOpen-inで渡された）ZIPを読み取る。選択中はセキュリティスコープを保持する。
    func begin(url: URL) {
        guard !isBusy else { return } // 処理中に別のZIPが渡されても、進行中の状態・アクセス権を壊さない
        endAccess()
        generation += 1
        let mine = generation
        guard store.isReady else {
            phase = .failed("保存データを開けないため、取り込めません。")
            return
        }
        if url.startAccessingSecurityScopedResource() { scopedURL = url }
        phase = .preparing
        Task {
            do {
                let plan = try await service.prepare(url: url)
                guard mine == generation else { return } // 閉じられた・取って代わられた
                phase = .choosing(plan)
            } catch {
                guard mine == generation else { return }
                phase = .failed(String(describing: error))
                endAccess()
            }
        }
    }

    func commit(ids: [String]) async {
        guard case .choosing(let plan) = phase else { return }
        phase = .importing
        #if canImport(UIKit)
        var background = UIBackgroundTaskIdentifier.invalid
        background = UIApplication.shared.beginBackgroundTask(withName: "favecus-import") {
            // 期限切れ：OSに終了される前にタスクを終える（取り込みは失敗扱いになり、公開済みの分は戻される）。
            UIApplication.shared.endBackgroundTask(background)
            background = .invalid
        }
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        #endif
        await store.waitUntilIdle()
        do {
            try store.prepareMediaDirectory()
            let base = store.currentText
            let built = try await service.build(plan: plan, ids: ids, parentId: nil, libraryText: base, mediaDirectory: store.mediaDirectory)
            do { try await store.replaceLibrary(expecting: base, with: built.newText) }
            catch { service.rollback(built.published); throw error }
            phase = .done(built.outcome)
        } catch {
            phase = .failed(String(describing: error))
        }
        endAccess()
    }

    func cancel() {
        if case .importing = phase { return } // 取り込み中は中断しない
        generation += 1
        endAccess()
        phase = .idle
    }

    private func endAccess() {
        scopedURL?.stopAccessingSecurityScopedResource()
        scopedURL = nil
    }
}
