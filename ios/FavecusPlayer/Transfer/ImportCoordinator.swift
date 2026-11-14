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
    /// 同梱の保存済みメディア（動画・音声）を取り込む処理（DownloadService）。nilなら取り込まない。
    var downloadImporter: ((_ zip: URL, _ records: [ImportDownload], _ entries: [EntryItem]) async -> (imported: Int, failed: Int))?
    private var scopedURL: URL?
    private var localCopy: URL?
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
                // ファイルアプリの外部の場所（Google Driveなど）のファイルは、まだ端末にないことがある。調整つきで読み（ここで取得される）、端末内へコピーしてから読む。
                let local = try await Self.makeLocalCopy(of: url)
                guard mine == generation else { try? FileManager.default.removeItem(at: local.deletingLastPathComponent()); return }
                localCopy = local
                let plan = try await service.prepare(url: local, libraryText: store.currentText)
                guard mine == generation else { return } // 閉じられた・取って代わられた
                phase = .choosing(plan)
            } catch {
                guard mine == generation else { return }
                phase = .failed(ErrorText.safe(error))
                endAccess()
            }
        }
    }

    /// リストは取り込まず、同梱の保存済みの動画・音声だけを、この端末のライブラリの曲の分、取り込む（同じ構成のリストがすでにあるときなど）。
    func importMediaOnly() async {
        guard case .choosing(let plan) = phase, let importer = downloadImporter, !plan.downloads.isEmpty else { return }
        phase = .importing
        let entries = store.document?.playlists.flatMap(\.entries) ?? []
        let result = await importer(plan.url, plan.downloads, entries)
        phase = .done(ImportOutcome(imported: 0, downloaded: result.imported, downloadsFailed: result.failed, missing: 0, omitted: 0, copied: 0))
        endAccess()
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
            var outcome = built.outcome
            // 保存済みの動画・音声：ライブラリへ入れたあとに、取り込んだ曲（と、すでにあって保存のない曲）の分だけを取り込む
            if !plan.downloads.isEmpty, let importer = downloadImporter {
                let entries = store.document?.playlists.flatMap(\.entries) ?? []
                let result = await importer(plan.url, plan.downloads, entries)
                outcome.downloaded = result.imported
                outcome.downloadsFailed = result.failed
            }
            phase = .done(outcome)
        } catch {
            phase = .failed(ErrorText.safe(error))
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
        if let localCopy { try? FileManager.default.removeItem(at: localCopy.deletingLastPathComponent()) }
        localCopy = nil
    }

    /// 選んだZIPを、端末内の一時フォルダーへコピーする（NSFileCoordinatorで、プロバイダーに取得させてから読む）。取り込みの終了・取り消しで消す。
    nonisolated private static func makeLocalCopy(of url: URL) async throws -> URL {
        try await Task.detached {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-import-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent("import.zip")
            var coordinationError: NSError?
            var copyError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [.withoutChanges], error: &coordinationError) { readable in
                do { try FileManager.default.copyItem(at: readable, to: destination) } catch { copyError = error }
            }
            if let failure = coordinationError ?? copyError {
                try? FileManager.default.removeItem(at: folder)
                throw failure
            }
            return destination
        }.value
    }
}
