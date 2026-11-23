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
    /// 今回の起動で、壊れた・なくなったライブラリをバックアップから復元した（同期は、空の状態を他の端末へ反映しないよう止まる）。
    private(set) var restoredThisLaunch = false
    /// ライブラリが変わった通知（引数：同期自身の書き込みか）。同期が、利用者の編集だけで再実行を予約するために使う。
    var onChange: (@MainActor (Bool) -> Void)?
    /// メディアの置き場にある実体のファイル名（再生できるローカル曲の判断に使う）。
    @Published private(set) var mediaFiles: Set<String> = []

    private let core: SharedCore?
    private let directory: URL
    private var text = ""
    private var chain: Task<Void, Never>?
    private var loading = false

    var fileURL: URL { directory.appendingPathComponent("library.json") }
    var backupURL: URL { directory.appendingPathComponent("library.json.bak") }
    var syncDirectory: URL { directory.appendingPathComponent("sync", isDirectory: true) }

    /// 同期を有効にする前の library.json を、別名で残す。
    func backupLibrary() throws -> String {
        let target = directory.appendingPathComponent("library.pre-sync-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).json")
        try FileManager.default.copyItem(at: fileURL, to: target)
        return target.lastPathComponent
    }

    /// 最近削除（削除したプレイリスト・曲を30日間保管する。端末内だけ）。
    let trash: TrashStore

    init(core: SharedCore?, directory: URL, startupError: String? = nil) {
        self.core = core
        self.directory = directory
        trash = TrashStore(directory: directory)
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
                    restoredThisLaunch = true
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
                    restoredThisLaunch = true
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
            cleanStaging()
        } catch {
            state = .blocked("保存データを読み込めません：\(ErrorText.safe(error))")
        }
    }

    // MARK: 取り込み・出力との連携

    /// 現在のライブラリ（共通JSが整えたJSON文字列）。取り込み・出力の入力に使う。
    var currentText: String { text }

    var isReady: Bool { if case .ready = state { return true } else { return false } }

    /// ローカル曲のメディアの置き場（Application Support配下）。バックアップ対象から外す（再取り込みできるため）。
    var mediaDirectory: URL { directory.appendingPathComponent("media", isDirectory: true) }

    func prepareMediaDirectory() throws {
        var url = mediaDirectory
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    /// 取り込みの結果で、ライブラリ全体を置き換える。取り込み準備中に保存データが変わっていたら、何も書かずに失敗する。
    /// 編集操作と同じ順番待ち（chain）に積む：実行中の編集の結果を、取り込みが上書きしたり、取り込みを編集が上書きしたりしない。
    func replaceLibrary(expecting base: String, with newText: String, bySync: Bool = false) async throws {
        let previous = chain
        let work = Task { () -> Result<Void, Error> in
            await previous?.value
            do { try self.replaceNow(expecting: base, with: newText, bySync: bySync); return .success(()) }
            catch { return .failure(error) }
        }
        chain = Task { _ = await work.value }
        try await work.value.get()
    }

    private func replaceNow(expecting base: String, with newText: String, bySync: Bool) throws {
        guard isReady else { throw ZipError.invalid("保存データを開けないため、取り込めません。") }
        guard text == base else { throw ZipError.invalid("読み取り後に保存データが変更されました。やり直します。") }
        // 先に表示用の読み取りを確認してから保存する（保存した後に失敗して、参照されるメディアを消すことがないように）。
        let decoded = try JSONDecoder().decode(LibraryDocument.self, from: Data(newText.utf8))
        try persist(newText)
        try show(newText, decoded: decoded, bySync: bySync)
    }

    /// 前回の取り込みが途中で終了して残った、自分のステージング（.import-*）を片付ける。
    func cleanStaging() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: mediaDirectory.path) else { return }
        for name in names where name.hasPrefix(".import-") { try? FileManager.default.removeItem(at: mediaDirectory.appendingPathComponent(name)) }
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

    /// 最近削除から元に戻す。成功したときだけ、保管から外す（失敗したときは、保管を残し、理由を知らせる）。
    func restoreFromTrash(id: String) {
        let previous = chain
        chain = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            guard let item = self.trash.item(id: id) else { self.notice = "この項目は、保管の期限が切れたか、なくなっています。"; return }
            if await self.run(["type": "restore", "item": item]) {
                self.trash.remove(id: id)
                self.notice = "元に戻しました。"
            }
        }
    }

    @discardableResult
    private func run(_ action: [String: Any]) async -> Bool {
        guard let core, state == .ready else { return false }
        do {
            let request: [String: Any] = ["text": text, "action": action, "ids": Self.freshIds(count: Self.idsNeeded(for: action)), "now": Self.now(), "keepTrash": true]
            let response = try await core.callAsync("LibraryApply", try Self.json(request))
            let result = try JSONDecoder().decode(ApplyResult.self, from: Data(response.utf8))
            if let message = result.error {
                notice = message
                return false
            }
            guard let updated = result.text else {
                notice = "編集結果を取得できません。"
                return false
            }
            try persist(updated) // 保存できなければ、画面も更新しない
            try show(updated)
            // 削除は、保存に成功したあとに、最近削除へ保管する（複数の曲を外したときは、曲ごと）
            if let items = result.trashItems { for kept in items { trash.add(json: kept) } } else if let kept = result.trash { trash.add(json: kept) }
            return true
        } catch {
            notice = "保存できません：\(ErrorText.safe(error))"
            return false
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
        /// 削除（プレイリスト・曲）のとき、最近削除へ保管する内容（JSON文字列）。`keepTrash` を渡したときだけ。
        var trash: String?
        /// 保管する内容のすべて（複数の曲を外したときは、曲ごと）。
        var trashItems: [String]?
    }

    private func open(_ core: SharedCore, _ fileText: String?) async throws -> OpenResult {
        var request: [String: Any] = ["ids": Self.freshIds(), "now": Self.now()]
        if let fileText { request["text"] = fileText }
        let response = try await core.callAsync("LibraryOpen", try Self.json(request))
        return try JSONDecoder().decode(OpenResult.self, from: Data(response.utf8))
    }

    private func show(_ newText: String, decoded: LibraryDocument? = nil, bySync: Bool = false) throws {
        let parsed = try decoded ?? JSONDecoder().decode(LibraryDocument.self, from: Data(newText.utf8))
        text = newText
        document = parsed
        mediaFiles = Self.listMedia(mediaDirectory)
        onChange?(bySync)
    }

    nonisolated static func listMedia(_ directory: URL) -> Set<String> {
        Set(((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).filter { !$0.hasPrefix(".") })
    }

    /// 新しいID（小文字。共通JSのID規則は小文字のみ）。操作1回に必要な数より十分多く渡す。
    nonisolated static func freshIds(count: Int = 16) -> [String] { (0..<max(1, count)).map { _ in UUID().uuidString.lowercased() } }

    /// 操作が使う、新しい識別番号の数（キューの保存・複数の曲の移動/追加は、曲の数に応じて増える）。
    nonisolated static func idsNeeded(for action: [String: Any]) -> Int {
        var needed = 16
        if let entries = action["entries"] as? [Any] { needed = max(needed, entries.count + 4) }
        if let ids = action["entryIds"] as? [Any], let destinations = action["destinationIds"] as? [Any] { needed = max(needed, ids.count * destinations.count + 4) }
        return min(needed, 20500)
    }

    nonisolated static func now() -> String { ISO8601DateFormatter().string(from: Date()) }

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
