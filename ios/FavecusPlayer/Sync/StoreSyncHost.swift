import Foundation

/// 同期用JSからの問い合わせに、保存データ・ファイル・通信で答える（JSは規則だけを持ち、実際の読み書きはここ）。
final class StoreSyncHost: SyncHost, @unchecked Sendable {
    private let store: LibraryStore
    private let directory: URL
    private let vault: SessionVault
    private let session: URLSession
    /// 再生回数の台帳（MainActorで使う）。なければ、再生回数の同期はしない。
    private let counts: PlayCountStore?
    private let favorites: FavoritesStore?
    private let history: PlayHistoryStore?
    private let fallbackDeviceId = "ios-\(String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12)))"
    private let sessionLock = NSLock()
    private var sessionRevision = 0
    private var activeSaveRevision: Int?

    init(store: LibraryStore, directory: URL, vault: SessionVault, session: URLSession = .shared, counts: PlayCountStore? = nil, favorites: FavoritesStore? = nil, history: PlayHistoryStore? = nil) {
        self.counts = counts
        self.favorites = favorites
        self.history = history
        self.store = store
        self.directory = directory
        self.vault = vault
        self.session = session
    }

    var stateURL: URL { directory.appendingPathComponent("state.json") }

    // MARK: ライブラリ

    func library() async -> String { await MainActor.run { store.currentText } }

    /// 同期の結果でライブラリを置き換える。読み取り後に編集が入っていたら拒否する（編集を上書きしない）。
    func write(_ json: String) async throws {
        struct Payload: Decodable { let base: String; let text: String }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(json.utf8))
        try await store.replaceLibrary(expecting: payload.base, with: payload.text, bySync: true)
    }

    func backup() async throws -> String { try await MainActor.run { try store.backupLibrary() } }

    func recovered() async -> Bool { await MainActor.run { store.restoredThisLaunch } }

    // MARK: 同期の状態ファイル（原子的に置き換える。ロック中のバックグラウンドからも読めるよう、初回ロック解除までの保護）

    func persist(_ text: String) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func readState() -> String? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 同期データを別名で残して、紐付けを外す（削除しない）。
    func setAsideState() {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return }
        let target = directory.appendingPathComponent("state.replaced-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).json")
        try? FileManager.default.moveItem(at: stateURL, to: target)
    }

    // MARK: 通信

    /// json：{ headers, body }。戻り：{ status, json } の文字列。接続先は共通JS（SupabaseConfig）が検証したURLだけ。ここでも https／ローカルの開発用だけに限る。
    func request(method: String, url: String, json: String) async throws -> String {
        guard let target = URL(string: url), let host = target.host, (target.scheme == "https") || (target.scheme == "http" && (host == "127.0.0.1" || host == "localhost")) else {
            throw TransferError.message("接続先のURLが正しくありません。")
        }
        guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw TransferError.message("通信の指定が正しくありません。") }
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.timeoutInterval = 30
        for (name, value) in (object["headers"] as? [String: Any]) ?? [:] { request.setValue("\(value)", forHTTPHeaderField: name) }
        if let body = object["body"], !(body is NSNull) { request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]) }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let parsed = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) ?? NSNull()
        let output = try JSONSerialization.data(withJSONObject: ["status": status, "json": parsed], options: [.fragmentsAllowed])
        return String(decoding: output, as: UTF8.self)
    }

    func invalidateSession() {
        sessionLock.lock()
        sessionRevision += 1
        activeSaveRevision = nil
        sessionLock.unlock()
    }

    func clearSession() {
        sessionLock.lock()
        sessionRevision += 1
        activeSaveRevision = nil
        vault.clear()
        sessionLock.unlock()
    }

    func setSession(_ json: String) throws {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        sessionRevision += 1
        activeSaveRevision = nil
        try vault.set(json)
    }

    func beginSessionSaveScope() -> Int {
        sessionLock.lock()
        let token = sessionRevision
        activeSaveRevision = token
        sessionLock.unlock()
        return token
    }

    func endSessionSaveScope(_ token: Int) {
        sessionLock.lock()
        if activeSaveRevision == token { activeSaveRevision = nil }
        sessionLock.unlock()
    }

    func saveSession(_ json: String) {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        guard activeSaveRevision == sessionRevision else { return }
        try? vault.set(json)
    }

    func isAborted() -> Bool {
        sessionLock.withLock {
            activeSaveRevision == nil || activeSaveRevision != sessionRevision
        }
    }

    // MARK: 再生回数・設定・お気に入り・再生履歴（共通JSの sync-counts.cjs が、これらを呼ぶ）

    private func sharedDeviceId() async -> String {
        let id = await MainActor.run { counts?.deviceId ?? "" }
        return id.isEmpty ? fallbackDeviceId : id
    }

    func countsRead() async -> String? { await counts?.syncRead() }
    func countsApply(_ json: String) async { await counts?.syncApply(json) }
    func countsPushed() async { await counts?.syncPushed() }

    func favoritesRead() async -> String? {
        guard let favorites else { return nil }
        return await favorites.syncRead(deviceId: await sharedDeviceId())
    }
    func favoritesApply(_ json: String) async { await favorites?.syncApply(json) }
    func favoritesPushed() async { await favorites?.syncPushed() }

    func historyRead() async -> String? {
        guard let history else { return nil }
        return await history.syncRead(deviceId: await sharedDeviceId())
    }
    func historyApply(_ json: String) async { await history?.syncApply(json) }
    func historyPushed() async { await history?.syncPushed() }
}
