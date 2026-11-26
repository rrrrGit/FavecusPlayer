import Combine
import Foundation
#if canImport(UIKit)
import UIKit
#endif

struct SyncConfig: Codable, Equatable {
    var url = ""
    var anonKey = ""
    var email = ""
    var enabled = false
}

struct SyncStatus: Equatable {
    enum State: String {
        case off
        case idle
        case syncing
        case error
        case blocked
    }

    var state: State = .off
    var message = ""
    var enabled = false
    var configured = false
    var signedIn = false
    var email = ""
    var url = ""
    var lastSyncAt: Double = 0
    var pending = 0
    var conflicts = 0
    /// 停止の理由が保存されていて、利用者が「復元」か「この端末を正とする」を選べる状態。
    var canUnblock = false
    /// 再生回数・お気に入り・再生履歴の同期だけ失敗しているときの知らせ（テーブル未作成など）。
    var extrasNotice = ""
}

/// iPhone版の同期の運用。規則（baseとの差分・受信は先にライブラリ・既定リストの扱い・空の状態の停止・整理）は共通JS（FavecusCore.Sync*）。
/// ここは設定・サインイン・タイマー・状態の表示と、Swiftだけで決まること（Keychain・ファイル・通信）。
/// 同期するのは、画面を開いている間（起動時・前面に戻ったとき・編集の後・設定画面の手動同期。定期同期はしない）。バックグラウンドでの同期はしない。
@MainActor
final class SyncCoordinator: ObservableObject {
    @Published private(set) var status = SyncStatus()

    private let store: LibraryStore
    private let core: SyncCore
    private let host: StoreSyncHost
    private let vault: SessionVault
    private var config = SyncConfig()
    private var opened = false
    private var blockedReason = ""
    private var unblockable = false
    private var extrasNotice = ""
    private var chain: Task<Void, Never>?
    private var pendingReset: Task<Void, Never>?
    private var debounce: Task<Void, Never>?
    private var observer: AnyCancellable?
    private var foreground: NSObjectProtocol?
    var onResetExtras: (() -> Void)?

    deinit {
        if let foreground { NotificationCenter.default.removeObserver(foreground) }
    }

    var configURL: URL { store.syncDirectory.appendingPathComponent("config.json") }

    init(store: LibraryStore, core: SyncCore, host: StoreSyncHost, vault: SessionVault) {
        self.store = store
        self.core = core
        self.host = host
        self.vault = vault
        config = Self.readConfig(configURL)
        publish(state: config.enabled ? .idle : .off)
    }

    // MARK: 設定

    private static func readConfig(_ url: URL) -> SyncConfig {
        guard let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(SyncConfig.self, from: data) else { return SyncConfig() }
        return value
    }

    private func writeConfig() throws {
        try FileManager.default.createDirectory(at: store.syncDirectory, withIntermediateDirectories: true)
        try JSONEncoder().encode(config).write(to: configURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func session() -> (json: [String: Any], userId: String)? {
        guard let text = vault.get(), let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let userId = object["userId"] as? String else { return nil }
        return (object, userId)
    }

    private func publish(state: SyncStatus.State, message: String = "", summary: [String: Any] = [:]) {
        var next = status
        next.state = blockedReason.isEmpty ? state : .blocked
        next.message = blockedReason.isEmpty ? message : blockedReason
        next.enabled = config.enabled
        next.configured = !config.url.isEmpty && !config.anonKey.isEmpty
        next.signedIn = vault.get() != nil
        next.canUnblock = unblockable && !blockedReason.isEmpty
        next.email = config.email
        next.url = config.url
        next.extrasNotice = extrasNotice
        if let pending = summary["pending"] as? Int { next.pending = pending }
        if let conflicts = summary["conflicts"] as? Int { next.conflicts = conflicts }
        if let last = summary["lastSyncAt"] as? Double { next.lastSyncAt = last }
        status = next
    }

    func configure(url: String, anonKey: String) async throws {
        guard !config.enabled else { throw TransferError.message("同期を止めてから接続先を変更してください。") }
        // 形式の検査（https の *.supabase.co、anon／publishable のみ、service_role・secret は拒否）は共通JS。正規化した値を保存する。
        let result = try await call("SyncValidate", ["config": ["url": url, "anonKey": anonKey]])
        if let error = result["error"] as? String { throw TransferError.message(error) }
        guard let normalized = result["config"] as? [String: Any], let cleanURL = normalized["url"] as? String, let key = normalized["anonKey"] as? String else { throw TransferError.message("接続先を確認できません。") }
        if cleanURL != config.url {
            host.clearSession()
        } // 別の接続先へ古いトークンを送らない
        opened = false // 設定が変わったら、同期のJSを開き直す（古い設定・トークンを使い続けない）
        config.url = cleanURL
        config.anonKey = key
        try writeConfig()
        publish(state: status.state, message: status.message)
    }

    // MARK: サインイン

    func sendCode(email: String) async throws {
        let result = try await call("SyncSendCode", ["config": configObject, "email": email])
        if let error = result["error"] as? String { throw TransferError.message(error) }
    }

    func verifyCode(email: String, code: String) async throws {
        let result = try await call("SyncVerifyCode", ["config": configObject, "email": email, "code": code])
        if let error = result["error"] as? String { throw TransferError.message(error) }
        guard let session = result["session"], let data = try? JSONSerialization.data(withJSONObject: session) else { throw TransferError.message("サインインできませんでした。") }
        try host.setSession(String(decoding: data, as: UTF8.self))
        opened = false // アカウントが変わり得るので、同期のJSを開き直す
        config.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        try writeConfig()
        publish(state: status.state, message: status.message)
    }

    func signOut() {
        host.clearSession()
        opened = false
        if config.enabled {
            disable()
        } else {
            publish(state: (status.state == .syncing || status.state == .error) ? .off : status.state, message: "")
        }
    }

    private var configObject: [String: Any] { ["url": config.url, "anonKey": config.anonKey] }

    // MARK: 開始・有効化・停止

    /// 起動時：同期が有効なら、状態を読み込んで、同期を始める。
    func start() async {
        // ライブラリが変わった瞬間に同期で受ける（同期自身の書き込みか、利用者の編集かを、その場で区別するため）。
        store.onChange = { [weak self] bySync in self?.storeChanged(bySync: bySync) }
        #if canImport(UIKit)
        if foreground == nil {
            foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.request() }
            }
        }
        #endif
        guard config.enabled else { publish(state: .off); return }
        guard await open() else { return }
        publish(state: .idle)
        request()
    }

    /// 同期のJSを開く（保存された状態の検証。未知の版・壊れた状態は、上書きせず停止）。
    private func open() async -> Bool {
        if opened { return true }
        guard let current = session() else { publish(state: .error, message: "サインインが必要です。"); return false }
        var options: [String: Any] = ["config": configObject, "session": current.json, "deviceId": "ios-\(UUID().uuidString.lowercased().prefix(8))"]
        if let state = host.readState() { options["stateText"] = state }
        do {
            let result = try await call("SyncOpen", options)
            if let error = result["error"] as? String { publish(state: .error, message: error); return false }
            if result["status"] as? String == "blocked" {
                blockedReason = result["reason"] as? String ?? "同期データを読み込めません。"
                publish(state: .blocked)
                return false
            }
            opened = true
            if let reason = result["blocked"] as? String, !reason.isEmpty { // 前回の停止が保存されている（再起動しても、利用者が選ぶまで解除しない）
                blockedReason = reason
                unblockable = true
                publish(state: .blocked, summary: result)
                return true
            }
            publish(state: .idle, summary: result)
            return true
        } catch {
            publish(state: .error, message: ErrorText.safe(error))
            return false
        }
    }

    func enable() async throws {
        let previous = chain
        let reset = pendingReset
        var enableError: Error?
        let task = Task<Bool, Never> {
            await previous?.value
            await reset?.value
            do {
                guard let current = session() else { throw TransferError.message("先にサインインしてください。") }
                guard await open() else { throw TransferError.message(status.message.isEmpty ? "同期を開始できません。" : status.message) }
                let result = try await call("SyncEnable", ["origin": ["url": config.url, "userId": current.userId]])
                if let error = result["error"] as? String { throw TransferError.message(error) }
                config.enabled = true
                try writeConfig()
                publish(state: .idle, summary: result)
                return true
            } catch {
                enableError = error
                return false
            }
        }
        chain = task
        let ok = await task.value
        if let enableError { throw enableError }
        if ok { _ = await syncNow() }
    }

    func disable() {
        config.enabled = false
        host.invalidateSession()
        try? writeConfig()
        debounce?.cancel()
        publish(state: .off)
    }

    /// 別のプロジェクト・アカウントへ切り替える：同期データは別名で残し、手元のライブラリから新しく始める。
    /// 停止の解除（利用者の選択）。mode：restore＝同期した内容でこの端末を復元／keep＝この端末の内容を正として同期する（削除も送る）。
    func unblock(mode: String) async throws {
        let previous = chain
        let reset = pendingReset
        var unblockError: Error?
        let task = Task<Bool, Never> {
            await previous?.value
            await reset?.value
            do {
                guard await open() else { throw TransferError.message("同期を開始できません。") }
                let result = try await call("SyncUnblock", ["mode": mode])
                if let error = result["error"] as? String { throw TransferError.message(error) }
                blockedReason = ""
                unblockable = false
                publish(state: .idle, summary: result)
                return true
            } catch {
                unblockError = error
                return false
            }
        }
        chain = task
        let ok = await task.value
        if let unblockError { throw unblockError }
        if ok { _ = await syncNow() }
    }

    func resetLink() {
        disable()
        host.invalidateSession()
        let host = self.host
        let onReset = onResetExtras
        opened = false
        blockedReason = ""
        unblockable = false
        extrasNotice = ""
        status = SyncStatus(state: .off, message: "", enabled: false, configured: status.configured, signedIn: status.signedIn, email: status.email, url: status.url)
        // 実行中の同期（chain）が、退避した後の状態ファイルを書き戻さないよう、完了を待ってから JS の状態を戻して退避する
        let previous = chain
        let previousReset = pendingReset
        pendingReset = Task { [weak self] in
            await previous?.value
            await previousReset?.value
            _ = try? await self?.call("SyncReset", [:])
            host.setAsideState()
            onReset?()
        }
    }

    // MARK: 同期

    private func storeChanged(bySync: Bool) {
        let reset = pendingReset
        Task { [weak self] in
            await reset?.value
            _ = try? await self?.call("SyncChanged", [:])
        }
        guard config.enabled, !bySync, blockedReason.isEmpty else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { self?.request() }
        }
    }

    func scheduleExtras() {
        guard config.enabled, blockedReason.isEmpty else { return }
        #if canImport(UIKit)
        guard UIApplication.shared.applicationState == .active else { return }
        #endif
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { self?.request() }
        }
    }

    func request() {
        guard config.enabled, blockedReason.isEmpty else { return }
        Task { _ = await syncNow() }
    }

    /// 同時に1つだけ実行する。戻り値：成功したか。
    @discardableResult
    func syncNow() async -> Bool {
        let previous = chain
        let reset = pendingReset
        let work = Task { () -> Bool in
            await previous?.value
            await reset?.value
            return await self.cycle()
        }
        chain = Task { _ = await work.value }
        return await work.value
    }

    private func cycle() async -> Bool {
        guard config.enabled, blockedReason.isEmpty else { return false }
        guard await open() else { return false }
        guard config.enabled else { return false }
        guard let current = session() else { publish(state: .error, message: "サインインが必要です。"); return false }
        publish(state: .syncing)
        let saveScope = host.beginSessionSaveScope()
        defer { host.endSessionSaveScope(saveScope) }
        do {
            // いまの接続先・アカウントを渡す。同期データの作成時と違えば、JSが通信せずに止める。
            let result = try await call("SyncCycle", ["origin": ["url": config.url, "userId": current.userId]])
            guard config.enabled, opened else { return false }
            if result["mismatch"] as? Bool == true {
                publish(state: .error, message: (result["error"] as? String) ?? "接続先またはアカウントが異なります。", summary: result)
                return false
            }
            if let blocked = result["blocked"] as? String, !blocked.isEmpty {
                blockedReason = blocked
                unblockable = true
                publish(state: .blocked, summary: result)
                return false
            }
            if let extras = result["extras"] as? [String: Any] {
                extrasNotice = (extras["ok"] as? Bool == false) ? (extras["error"] as? String ?? "") : ""
            }
            if result["ok"] as? Bool == true {
                publish(state: .idle, summary: result)
                return true
            }
            publish(state: .error, message: (result["error"] as? String) ?? "同期に失敗しました。", summary: result)
            return false
        } catch {
            guard config.enabled, opened else { return false }
            publish(state: .error, message: ErrorText.safe(error))
            return false
        }
    }

    // MARK: JS呼び出し

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func call(_ function: String, _ arguments: [String: Any]) async throws -> [String: Any] {
        let text = try await core.call(function, Self.json(arguments))
        return (try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
    }
}
