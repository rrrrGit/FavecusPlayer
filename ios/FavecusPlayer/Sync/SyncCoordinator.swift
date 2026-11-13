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
}

/// iPhone版の同期の運用。規則（baseとの差分・受信は先にライブラリ・既定リストの扱い・空の状態の停止・整理）は共通JS（FavecusCore.Sync*）。
/// ここは設定・サインイン・タイマー・状態の表示と、Swiftだけで決まること（Keychain・ファイル・通信）。
/// 同期するのは、画面を開いている間（起動時・前面に戻ったとき・編集の後・5分ごと）。バックグラウンドでの同期はしない。
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
    private var chain: Task<Void, Never>?
    private var debounce: Task<Void, Never>?
    private var interval: Task<Void, Never>?
    private var observer: AnyCancellable?
    private var foreground: NSObjectProtocol?

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
        next.email = config.email
        next.url = config.url
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
        if cleanURL != config.url { vault.clear() } // 別の接続先へ古いトークンを送らない
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
        try vault.set(String(decoding: data, as: UTF8.self))
        config.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        try writeConfig()
        publish(state: status.state, message: status.message)
    }

    func signOut() {
        vault.clear()
        publish(state: status.state, message: status.message)
    }

    private var configObject: [String: Any] { ["url": config.url, "anonKey": config.anonKey] }

    // MARK: 開始・有効化・停止

    /// 起動時：同期が有効なら、状態を読み込んで、同期を始める。
    func start() async {
        observer = store.$document.dropFirst().sink { [weak self] _ in
            Task { @MainActor in self?.storeChanged() }
        }
        #if canImport(UIKit)
        foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.request() }
        }
        #endif
        guard config.enabled else { publish(state: .off); return }
        guard await open() else { return }
        publish(state: .idle)
        request()
        scheduleInterval()
    }

    private func scheduleInterval() {
        interval?.cancel()
        interval = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
                self?.request()
            }
        }
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
            publish(state: .idle, summary: result)
            return true
        } catch {
            publish(state: .error, message: "\(error)")
            return false
        }
    }

    func enable() async throws {
        guard let current = session() else { throw TransferError.message("先にサインインしてください。") }
        guard await open() else { throw TransferError.message(status.message.isEmpty ? "同期を開始できません。" : status.message) }
        let result = try await call("SyncEnable", ["origin": ["url": config.url, "userId": current.userId]])
        if let error = result["error"] as? String { throw TransferError.message(error) }
        config.enabled = true
        try writeConfig()
        publish(state: .idle, summary: result)
        scheduleInterval()
        _ = await syncNow()
    }

    func disable() {
        config.enabled = false
        try? writeConfig()
        interval?.cancel()
        debounce?.cancel()
        publish(state: .off)
    }

    /// 別のプロジェクト・アカウントへ切り替える：同期データは別名で残し、手元のライブラリから新しく始める。
    func resetLink() {
        disable()
        host.setAsideState()
        opened = false
        blockedReason = ""
        Task { _ = try? await call("SyncReset", [:]) }
        status = SyncStatus(state: .off, message: "", enabled: false, configured: status.configured, signedIn: status.signedIn, email: status.email, url: status.url)
    }

    // MARK: 同期

    private func storeChanged() {
        Task { _ = try? await call("SyncChanged", [:]) }
        guard config.enabled, !store.syncWriting, blockedReason.isEmpty else { return }
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
        let work = Task { () -> Bool in
            await previous?.value
            return await self.cycle()
        }
        chain = Task { _ = await work.value }
        return await work.value
    }

    private func cycle() async -> Bool {
        guard config.enabled, blockedReason.isEmpty else { return false }
        guard await open() else { return false }
        guard let current = session() else { publish(state: .error, message: "サインインが必要です。"); return false }
        publish(state: .syncing)
        do {
            let result = try await call("SyncCycle", [:])
            if let origin = result["origin"] as? [String: Any], let url = origin["url"] as? String, !url.isEmpty,
               url != config.url || (origin["userId"] as? String) != current.userId {
                publish(state: .error, message: "接続先またはアカウントが、この同期データの作成時と異なります。「接続を初期化」で切り替えてください（手元のプレイリストは変わりません）。", summary: result)
                return false
            }
            if let blocked = result["blocked"] as? String {
                blockedReason = blocked
                publish(state: .blocked, summary: result)
                return false
            }
            if result["ok"] as? Bool == true {
                publish(state: .idle, summary: result)
                return true
            }
            publish(state: .error, message: (result["error"] as? String) ?? "同期に失敗しました。", summary: result)
            return false
        } catch {
            publish(state: .error, message: "\(error)")
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
