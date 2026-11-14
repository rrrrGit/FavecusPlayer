import Foundation
import JavaScriptCore

/// 同期用のJavaScriptCore。再生順などの SharedCore とは別の JSVirtualMachine で動かす（同期の重い処理が、再生の曲送りを止めないため。
/// 同じVMのコンテキストはロックを共有し、並列に動けない）。同期の規則は共通JS（FavecusCore.Sync*）。
/// JSが必要とする保存・通信・ライブラリの読み書きは、Swift側の SyncHost が、Promiseで答える。
protocol SyncHost: AnyObject, Sendable {
    func library() async -> String
    func write(_ json: String) async throws
    func persist(_ text: String) async throws
    func backup() async throws -> String
    func recovered() async -> Bool
    func request(method: String, url: String, json: String) async throws -> String
    func saveSession(_ json: String)
    /// 再生回数・設定の同期（対応していないhostは nil / 何もしない）。
    func countsRead() async -> String?
    func countsApply(_ json: String) async
    func countsPushed() async
}

extension SyncHost {
    func countsRead() async -> String? { nil }
    func countsApply(_ json: String) async {}
    func countsPushed() async {}
}

final class SyncCore: @unchecked Sendable {
    private let machine = JSVirtualMachine()
    private let context: JSContext
    private let queue = DispatchQueue(label: "dev.favecus.synccore")
    private var errors: [String] = []

    init(source: String, host: SyncHost) throws {
        guard let machine, let created = JSContext(virtualMachine: machine) else { throw SharedCoreError.contextUnavailable }
        context = created
        context.exceptionHandler = { [weak self] _, exception in self?.errors.append(exception?.toString() ?? "unknown") }
        installHost(host)
        context.evaluateScript(source, withSourceURL: URL(string: "favecus-core.js"))
        if !errors.isEmpty { throw SharedCoreError.script(errors.joined(separator: " / ")) }
    }

    convenience init(bundle: Bundle, host: SyncHost) throws {
        guard let url = bundle.url(forResource: "favecus-core", withExtension: "js") else { throw SharedCoreError.missingResource("favecus-core.js") }
        try self.init(source: String(contentsOf: url, encoding: .utf8), host: host)
    }

    /// Swiftの非同期処理を、JSのPromiseとして返す（解決は、JSを動かすキュー上で行う）。
    private func promise(_ work: @escaping @Sendable () async throws -> Any?) -> JSValue {
        JSValue(newPromiseIn: context) { [queue] resolve, reject in
            Task {
                do {
                    let value = try await work()
                    queue.async { _ = resolve?.call(withArguments: [value ?? NSNull()]) }
                } catch {
                    let message = ErrorText.safe(error)
                    queue.async { _ = reject?.call(withArguments: [message]) }
                }
            }
        }
    }

    private func installHost(_ host: SyncHost) {
        let object = JSValue(newObjectIn: context)
        let library: @convention(block) () -> JSValue = { [unowned self] in promise { await host.library() } }
        let write: @convention(block) (String) -> JSValue = { [unowned self] json in promise { try await host.write(json); return nil } }
        let persist: @convention(block) (String) -> JSValue = { [unowned self] text in promise { try await host.persist(text); return nil } }
        let backup: @convention(block) () -> JSValue = { [unowned self] in promise { try await host.backup() } }
        let recovered: @convention(block) () -> JSValue = { [unowned self] in promise { await host.recovered() } }
        let request: @convention(block) (String, String, String) -> JSValue = { [unowned self] method, url, json in promise { try await host.request(method: method, url: url, json: json) } }
        let saveSession: @convention(block) (String) -> JSValue = { [unowned self] json in host.saveSession(json); return promise { nil } }
        let countsRead: @convention(block) () -> JSValue = { [unowned self] in promise { await host.countsRead() } }
        let countsApply: @convention(block) (String) -> JSValue = { [unowned self] json in promise { await host.countsApply(json); return nil } }
        let countsPushed: @convention(block) () -> JSValue = { [unowned self] in promise { await host.countsPushed(); return nil } }
        for (name, block) in [("library", library as Any), ("write", write), ("persist", persist), ("backup", backup), ("recovered", recovered), ("request", request), ("saveSession", saveSession),
                              ("countsRead", countsRead), ("countsApply", countsApply), ("countsPushed", countsPushed)] {
            object?.setObject(block, forKeyedSubscript: name as NSString)
        }
        context.setObject(object, forKeyedSubscript: "__favecusHost" as NSString)
    }

    /// FavecusCore.<function>(argument)。戻りがPromiseなら、解決を待つ。JSON文字列を返す。
    func call(_ function: String, _ argument: String = "{}") async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.errors.removeAll()
                guard let core = self.context.objectForKeyedSubscript("FavecusCore"), let target = core.objectForKeyedSubscript(function), !target.isUndefined else {
                    continuation.resume(throwing: SharedCoreError.missingResource("FavecusCore.\(function)"))
                    return
                }
                let result = target.call(withArguments: [argument])
                if !self.errors.isEmpty {
                    continuation.resume(throwing: SharedCoreError.script(self.errors.joined(separator: " / ")))
                    return
                }
                guard let result else {
                    continuation.resume(throwing: SharedCoreError.invalidResult(function))
                    return
                }
                if result.isObject, result.hasProperty("then") {
                    let fulfilled: @convention(block) (JSValue) -> Void = { value in
                        if value.isString, let text = value.toString() { continuation.resume(returning: text) }
                        else { continuation.resume(throwing: SharedCoreError.invalidResult(function)) }
                    }
                    let rejected: @convention(block) (JSValue) -> Void = { error in
                        continuation.resume(throwing: SharedCoreError.script(error.toString() ?? "rejected"))
                    }
                    result.invokeMethod("then", withArguments: [fulfilled, rejected])
                } else if result.isString, let text = result.toString() {
                    continuation.resume(returning: text)
                } else {
                    continuation.resume(throwing: SharedCoreError.invalidResult(function))
                }
            }
        }
    }
}
