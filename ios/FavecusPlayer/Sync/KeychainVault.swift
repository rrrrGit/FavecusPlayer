import Foundation
import Security

/// サインイン情報（アクセス・更新トークン）の保管先。設定・ライブラリ・ログ・同期データには置かない。
protocol SessionVault: AnyObject, Sendable {
    func get() -> String?
    func set(_ json: String) throws
    func clear()
}

enum KeychainError: Error, CustomStringConvertible {
    case status(OSStatus)

    var description: String {
        switch self { case .status(let code): return "サインイン情報を保管できません（Keychain \(code)）。" }
    }
}

/// Keychain（この端末の初回ロック解除後だけ読める。他の端末・バックアップへは移さない）。
final class KeychainVault: SessionVault, @unchecked Sendable {
    private let service: String
    private let account: String

    init(service: String = "dev.favecus.player.sync", account: String = "supabase-session") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func get() -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ json: String) throws {
        let data = Data(json.utf8)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError.status(update) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// テスト・Keychainが使えない環境用（メモリだけ。永続しない）。
final class MemoryVault: SessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ json: String) throws { lock.lock(); value = json; lock.unlock() }
    func clear() { lock.lock(); value = nil; lock.unlock() }
}
