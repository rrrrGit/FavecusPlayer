import Foundation

/// ZIPの取り込み。Swiftは「入れ物と実体」（ZIPの読み取り・復号・展開・公開）だけを行い、
/// 何を受け付け、どう合成するかは共通JS（TransferPrepare / TransferImport）が決める。
enum TransferError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self { case .message(let text): return text }
    }
}

struct ImportList: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let count: Int
    let childIds: [String]
}

struct ImportPlan {
    let url: URL
    let mode: String
    let lists: [ImportList]
    let rootPlaylistIds: [String]
    let plan: Any
}

struct ImportOutcome: Equatable {
    var imported: Int
    var missing: Int
    var omitted: Int
    var copied: Int
}

struct ImportBuilt {
    let newText: String
    let outcome: ImportOutcome
    let published: [URL]
}

final class TransferService: @unchecked Sendable {
    private let core: SharedCore
    private static let innerLimit = 32 * 1024 * 1024

    init(core: SharedCore) { self.core = core }

    private struct PrepareResponse: Decodable {
        var error: String?
        var mode: String?
        var lists: [ImportList]?
        var rootPlaylistIds: [String]?
    }

    private struct ImportFile: Decodable {
        var from: String
        var to: String
    }

    private struct ImportResponse: Decodable {
        var error: String?
        var text: String?
        var imported: Int?
        var missing: Int?
        var omitted: Int?
        var files: [ImportFile]?
    }

    private static func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else { throw TransferError.message("内部の形式エラーです。") }
        return text
    }

    // MARK: 取り込み候補の読み取り

    func prepare(url: URL) async throws -> ImportPlan {
        let core = self.core
        return try await Task.detached {
            let zip = try ZipArchive(source: try FileSource(url: url))
            guard zip.has("playlists.fvpa") else { throw FvpaError.notArchive }
            let plain = try Fvpa.decrypt(try zip.data("playlists.fvpa", limit: TransferService.innerLimit + 96))
            let inner = try ZipArchive(source: DataSource(plain))
            var identity: Any = NSNull()
            if inner.has("identity.json") {
                identity = String(decoding: try inner.data("identity.json", limit: TransferService.innerLimit), as: UTF8.self)
            }
            var records: [String] = []
            for name in inner.names where name != "identity.json" {
                records.append(String(decoding: try inner.data(name, limit: TransferService.innerLimit), as: UTF8.self))
            }
            let request: [String: Any] = ["identity": identity, "records": records, "innerNames": inner.names, "outerNames": zip.names]
            let response = try core.call("TransferPrepare", try TransferService.json(request))
            let decoded = try JSONDecoder().decode(PrepareResponse.self, from: Data(response.utf8))
            if let message = decoded.error { throw TransferError.message(message) }
            guard let mode = decoded.mode, let lists = decoded.lists, let roots = decoded.rootPlaylistIds,
                  let object = try JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any], let plan = object["plan"] else {
                throw TransferError.message("取り込み内容を読み取れません。")
            }
            return ImportPlan(url: url, mode: mode, lists: lists, rootPlaylistIds: roots, plan: plan)
        }.value
    }

    // MARK: 取り込みの組み立て（展開 → 公開）。ライブラリの書き換えは呼び出し側（LibraryStore）が最後に行う。

    func build(plan: ImportPlan, ids: [String], parentId: String?, libraryText: String, mediaDirectory: URL) async throws -> ImportBuilt {
        let core = self.core
        return try await Task.detached {
            let zip = try ZipArchive(source: try FileSource(url: plan.url))
            let available = zip.names.filter { $0.hasPrefix("media/") }.map { String($0.dropFirst(6)) }
            let idCount = plan.lists.reduce(0) { $0 + $1.count } * 3 + plan.lists.count * 3 + 64
            var request: [String: Any] = ["text": libraryText, "plan": plan.plan, "ids": ids, "available": available,
                                          "newIds": (0..<idCount).map { _ in UUID().uuidString.lowercased() }, "now": LibraryStore.now()]
            if let parentId { request["parentId"] = parentId }
            let response = try core.call("TransferImport", try TransferService.json(request))
            let decoded = try JSONDecoder().decode(ImportResponse.self, from: Data(response.utf8))
            if let message = decoded.error { throw TransferError.message(message) }
            guard let text = decoded.text, let files = decoded.files else { throw TransferError.message("取り込み結果を読み取れません。") }
            for file in files where file.to != URL(fileURLWithPath: file.to).lastPathComponent || file.to.hasPrefix(".") {
                throw TransferError.message("保存先の名前が正しくありません。")
            }
            let manager = FileManager.default
            try manager.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
            let staging = mediaDirectory.appendingPathComponent(".import-\(UUID().uuidString)", isDirectory: true)
            try manager.createDirectory(at: staging, withIntermediateDirectories: false)
            defer { try? manager.removeItem(at: staging) } // 自分で作ったステージングだけを消す
            var published: [URL] = []
            do {
                for file in files { try zip.extract("media/\(file.from)", to: staging.appendingPathComponent(file.to)) }
                for file in files {
                    let destination = mediaDirectory.appendingPathComponent(file.to)
                    guard !manager.fileExists(atPath: destination.path) else { throw TransferError.message("保存先に同じ名前のファイルがあります。") }
                    try manager.moveItem(at: staging.appendingPathComponent(file.to), to: destination)
                    published.append(destination)
                }
            } catch {
                for url in published { try? manager.removeItem(at: url) } // 公開済みの自分のファイルだけ戻す
                throw error
            }
            return ImportBuilt(newText: text, outcome: ImportOutcome(imported: decoded.imported ?? 0, missing: decoded.missing ?? 0, omitted: decoded.omitted ?? 0, copied: files.count), published: published)
        }.value
    }

    /// ライブラリの保存に失敗したとき、公開済みのメディアを戻す。
    func rollback(_ published: [URL]) {
        for url in published { try? FileManager.default.removeItem(at: url) }
    }
}
