import Foundation

/// iPhone版のローカル保存（Windows版と同じv3のlibrary.json）。読み込みの判定と編集の規則はすべて共通JS（FavecusCore.LibraryOpen / LibraryApply）。
/// ここは「ファイルの読み書き」「新しいIDと時刻を渡す」「失敗したら保存しない・壊れた/未対応のファイルを上書きしない」だけを担う。
@MainActor
final class LibraryStore: ObservableObject {
    enum State: Equatable {
        case loading
        case ready
        /// 読み込めない／この版では扱えない。保存データは変更せず、書き込みも止める。
        case blocked(String)
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var document: LibraryDocument?
    @Published var notice: String?

    private let core: SharedCore?
    private let directory: URL
    private var text = ""
    private var chain: Task<Void, Never>?
    private var loading = false

    var fileURL: URL { directory.appendingPathComponent("library.json") }
    var backupURL: URL { directory.appendingPathComponent("library.json.bak") }

    init(core: SharedCore?, directory: URL, startupError: String? = nil) {
        self.core = core
        self.directory = directory
        if let startupError { state = .blocked(startupError) }
    }

    /// Application Support/FavecusPlayer（Documentsではなく、利用者が直接触る場所にしない）。
    static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return base.appendingPathComponent("FavecusPlayer", isDirectory: true)
    }

    // MARK: 読み込み

    func load() async {
        guard let core, case .loading = state, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let fileText = try readFile(fileURL)
            var result = try await open(core, fileText)
            var restored = false
            // 本体がない場合も、直前のバックアップがあれば先にそれを試す（Windows版のStore.Readと同じ順序）。
            if result.status == "new", fileText == nil, let backup = try readFile(backupURL) {
                let fromBackup = try await open(core, backup)
                if fromBackup.status == "ok" {
                    result = fromBackup
                    restored = true
                    notice = "保存データが見つからなかったため、バックアップから復元しました。"
                }
            }
            switch result.status {
            case "new", "ok":
                break
            case "invalid":
                // 壊れている：直前のバックアップを試す。元のファイルは別名で残す（削除・上書きしない）。
                if fileText != nil, let backup = try readFile(backupURL) {
                    let fromBackup = try await open(core, backup)
                    if fromBackup.status == "ok" {
                        try keepDamaged(fileURL)
                        result = fromBackup
                        restored = true
                        notice = "保存データを読み込めなかったため、バックアップから復元しました。"
                        break
                    }
                }
                state = .blocked(result.message ?? "保存データを読み込めません。")
                return
            default:
                state = .blocked(result.message ?? "この版では扱えない保存データです。")
                return
            }
            guard let loaded = result.text else {
                state = .blocked("保存データを読み込めません。")
                return
            }
            // ファイルがない（新規）か、バックアップから復元したときだけ書く。正常に読めたファイルは書き換えない。
            if result.status == "new" || restored { try persist(loaded) }
            try show(loaded)
            state = .ready
        } catch {
            state = .blocked("保存データを読み込めません：\(error)")
        }
    }

    // MARK: 編集

    /// 編集操作（共通JSの操作の辞書）を1つ適用して保存する。操作は積んだ順に処理する。
    func perform(_ action: [String: Any]) {
        let previous = chain
        chain = Task { [weak self] in
            await previous?.value
            await self?.run(action)
        }
    }

    /// 直前に積んだ操作がすべて終わるまで待つ（テスト・終了処理用）。
    func waitUntilIdle() async { await chain?.value }

    private func run(_ action: [String: Any]) async {
        guard let core, state == .ready else { return }
        do {
            let request: [String: Any] = ["text": text, "action": action, "ids": Self.freshIds(), "now": Self.now()]
            let response = try await core.callAsync("LibraryApply", try Self.json(request))
            let result = try JSONDecoder().decode(ApplyResult.self, from: Data(response.utf8))
            if let message = result.error {
                notice = message
                return
            }
            guard let updated = result.text else {
                notice = "編集結果を取得できません。"
                return
            }
            try persist(updated) // 保存できなければ、画面も更新しない
            try show(updated)
        } catch {
            notice = "保存できません：\(error)"
        }
    }

    // MARK: 共通JSの入出力

    private struct OpenResult: Decodable {
        var status: String
        var text: String?
        var message: String?
    }

    private struct ApplyResult: Decodable {
        var text: String?
        var error: String?
    }

    private func open(_ core: SharedCore, _ fileText: String?) async throws -> OpenResult {
        var request: [String: Any] = ["ids": Self.freshIds(), "now": Self.now()]
        if let fileText { request["text"] = fileText }
        let response = try await core.callAsync("LibraryOpen", try Self.json(request))
        return try JSONDecoder().decode(OpenResult.self, from: Data(response.utf8))
    }

    private func show(_ newText: String) throws {
        let decoded = try JSONDecoder().decode(LibraryDocument.self, from: Data(newText.utf8))
        text = newText
        document = decoded
    }

    /// 新しいID（小文字。共通JSのID規則は小文字のみ）。操作1回に必要な数より十分多く渡す。
    static func freshIds() -> [String] { (0..<16).map { _ in UUID().uuidString.lowercased() } }

    static func now() -> String { ISO8601DateFormatter().string(from: Date()) }

    static func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let value = String(data: data, encoding: .utf8) else { throw SharedCoreError.invalidResult("json") }
        return value
    }

    // MARK: ファイル

    private func readFile(_ url: URL) throws -> String? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard let value = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
        return value
    }

    /// 置換前の正常な内容を .bak に残してから、一時ファイル経由で原子的に置き換える。
    /// バックグラウンドの音声・ダウンロード（後の工程）から端末のロック中も読めるよう、初回ロック解除までの保護にする。
    private func persist(_ newText: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        if fm.fileExists(atPath: fileURL.path), !text.isEmpty {
            // 新しい複製を作ってから置き換える（複製に失敗しても、これまでの.bakを失わない）。
            let temporary = directory.appendingPathComponent("library.json.bak.tmp")
            try? fm.removeItem(at: temporary)
            try fm.copyItem(at: fileURL, to: temporary)
            if fm.fileExists(atPath: backupURL.path) { _ = try fm.replaceItemAt(backupURL, withItemAt: temporary) }
            else { try fm.moveItem(at: temporary, to: backupURL) }
        }
        try Data(newText.utf8).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// 壊れたファイルは別名で複製して残す（元の位置には、復元後に原子的に置き換えるまで残す）。名前は衝突しない。
    private func keepDamaged(_ url: URL) throws {
        let target = directory.appendingPathComponent("library.json.damaged-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8))")
        try FileManager.default.copyItem(at: url, to: target)
    }
}
