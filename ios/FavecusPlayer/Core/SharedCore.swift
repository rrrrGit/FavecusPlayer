import Foundation
import JavaScriptCore

/// 端末共通のJS（shared/dist/favecus-core.js）をJavaScriptCoreで実行する。
/// 入出力はJSON文字列のみ。Swift側にデータ規則を持たない（規則の正本は共通JS）。
/// JSContextは同時に複数のスレッドから使わない：すべての呼び出しを専用の直列キューで行う。
enum SharedCoreError: Error, CustomStringConvertible {
    case missingResource(String)
    case contextUnavailable
    case script(String)
    case invalidResult(String)

    var description: String {
        switch self {
        case .missingResource(let name): return "リソースが見つかりません: \(name)"
        case .contextUnavailable: return "JSContextを作成できません"
        case .script(let message): return "JavaScriptの例外: \(message)"
        case .invalidResult(let name): return "戻り値が文字列ではありません: \(name)"
        }
    }
}

final class SharedCore: @unchecked Sendable {
    private let context: JSContext
    private let queue = DispatchQueue(label: "dev.favecus.sharedcore")
    private var errors: [String] = []

    init(source: String) throws {
        guard let created = JSContext() else { throw SharedCoreError.contextUnavailable }
        context = created
        context.exceptionHandler = { [weak self] _, exception in
            self?.errors.append(exception?.toString() ?? "unknown")
        }
        context.evaluateScript(source, withSourceURL: URL(string: "favecus-core.js"))
        try throwIfNeeded()
    }

    convenience init(bundle: Bundle) throws {
        guard let url = bundle.url(forResource: "favecus-core", withExtension: "js") else {
            throw SharedCoreError.missingResource("favecus-core.js")
        }
        try self.init(source: String(contentsOf: url, encoding: .utf8))
    }

    /// FavecusCore.<function>(argument) を呼び、JSON文字列を返す（呼び出し側のスレッドで待つ）。
    func call(_ function: String, _ argument: String) throws -> String {
        try queue.sync { try invoke(function, argument) }
    }

    /// 同じ呼び出しを、呼び出し側のスレッドを止めずに行う（アプリ本体はこちらを使う）。
    func callAsync(_ function: String, _ argument: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { continuation.resume(returning: try self.invoke(function, argument)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func invoke(_ function: String, _ argument: String) throws -> String {
        errors.removeAll()
        guard let core = context.objectForKeyedSubscript("FavecusCore"),
              let target = core.objectForKeyedSubscript(function), !target.isUndefined else {
            throw SharedCoreError.missingResource("FavecusCore.\(function)")
        }
        let result = target.call(withArguments: [argument])
        try throwIfNeeded()
        guard let result, result.isString, let text = result.toString() else {
            throw SharedCoreError.invalidResult(function)
        }
        return text
    }

    private func throwIfNeeded() throws {
        if !errors.isEmpty { throw SharedCoreError.script(errors.joined(separator: " / ")) }
    }
}
