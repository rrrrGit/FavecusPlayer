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

/// ZIPに同梱された、保存済みの動画・音声（Windows版の downloads/catalog.json の1件）。
struct ImportDownload: Equatable {
    let url: String
    let aliases: [String]
    let kind: String      // audio / video
    let media: String     // ZIP内の名前（downloads/media/…）
    let bytes: Int64
    let duration: Double
    let height: Int

    init(url: String, aliases: [String] = [], kind: String, media: String, bytes: Int64, duration: Double, height: Int) {
        self.url = url
        self.aliases = aliases
        self.kind = kind
        self.media = media
        self.bytes = bytes
        self.duration = duration
        self.height = height
    }
}

struct ImportPlan {
    let url: URL
    let mode: String
    let lists: [ImportList]
    let rootPlaylistIds: [String]
    let plan: Any
    /// 取り込まない部分（保存済みメディアの表紙画像など）の件数。
    let ignoredEntries: Int
    /// すでにこの端末に同じ構成のプレイリストがある候補のID。
    let identicalIds: Set<String>
    /// 同梱された保存済みメディア（動画・音声）。
    let downloads: [ImportDownload]
}

struct ImportOutcome: Equatable {
    var imported: Int
    var skippedIdentical = 0
    /// 取り込んだ保存済みメディア（動画・音声）の数と、取り込めなかった数。
    var downloaded = 0
    var downloadsFailed = 0
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
        var identicalIds: [String]?
    }

    private struct ImportFile: Decodable {
        var from: String
        var to: String
    }

    private struct ImportResponse: Decodable {
        var error: String?
        var text: String?
        var imported: Int?
        var skippedIdentical: Int?
        var missing: Int?
        var omitted: Int?
        var files: [ImportFile]?
    }

    /// 不正なUTF-8は置き換えずに拒否する（Windows版のReadJSONと同じ）。
    private static func text(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8) else { throw TransferError.message("文字コードを読み取れません。") }
        return value
    }

    private static func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else { throw TransferError.message("内部の形式エラーです。") }
        return text
    }

    // MARK: 取り込み候補の読み取り

    /// libraryText：いまの端末のライブラリ（すでに同じ構成のリストを見つけるために、共通JSへ渡す）。
    func prepare(url: URL, libraryText: String? = nil) async throws -> ImportPlan {
        let core = self.core
        return try await Task.detached {
            let zip = try ZipArchive(source: try FileSource(url: url))
            guard zip.has("playlists.fvpa") else { throw FvpaError.notArchive }
            let plain = try Fvpa.decrypt(try zip.data("playlists.fvpa", limit: TransferService.innerLimit + 96))
            let inner = try ZipArchive(source: DataSource(plain))
            // 読み込む前に件数と合計サイズを確認する（重なったエントリでメモリを使い切らせない。Windows版は検査してから読む）。
            guard inner.names.count <= 1001, inner.totalBytes <= UInt64(TransferService.innerLimit) else { throw TransferError.message("プレイリスト情報が大きすぎます。") }
            var identity: Any = NSNull()
            if inner.has("identity.json") { identity = try TransferService.text(try inner.data("identity.json", limit: TransferService.innerLimit)) }
            var records: [String] = []
            for name in inner.names where name != "identity.json" { records.append(try TransferService.text(try inner.data(name, limit: TransferService.innerLimit))) }
            var request: [String: Any] = ["identity": identity, "records": records, "innerNames": inner.names, "outerNames": zip.names]
            if let libraryText { request["text"] = libraryText }
            let response = try core.call("TransferPrepare", try TransferService.json(request))
            let decoded = try JSONDecoder().decode(PrepareResponse.self, from: Data(response.utf8))
            if let message = decoded.error { throw TransferError.message(message) }
            guard let mode = decoded.mode, let lists = decoded.lists, let roots = decoded.rootPlaylistIds,
                  let object = try JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any], let plan = object["plan"] else {
                throw TransferError.message("取り込み内容を読み取れません。")
            }
            let downloads = try TransferService.readDownloads(zip)
            let ignored = zip.names.filter { $0 != "playlists.fvpa" && !$0.hasPrefix("media/") && !($0.hasPrefix("downloads/media/") || $0 == "downloads/catalog.json") }.count
            return ImportPlan(url: url, mode: mode, lists: lists, rootPlaylistIds: roots, plan: plan, ignoredEntries: ignored, identicalIds: Set(decoded.identicalIds ?? []), downloads: downloads)
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
            return ImportBuilt(newText: text, outcome: ImportOutcome(imported: decoded.imported ?? 0, skippedIdentical: decoded.skippedIdentical ?? 0, missing: decoded.missing ?? 0, omitted: decoded.omitted ?? 0, copied: files.count), published: published)
        }.value
    }

    /// 同梱の保存済みメディアの一覧（downloads/catalog.json）。形式・ファイル名・大きさを確かめ、正しくないものは受け付けない（黙って読み込まない）。
    static func readDownloads(_ zip: ZipArchive) throws -> [ImportDownload] {
        guard zip.has("downloads/catalog.json") else { return [] }
        guard let object = try JSONSerialization.jsonObject(with: try zip.data("downloads/catalog.json", limit: 32 * 1024 * 1024)) as? [String: Any],
              object["version"] as? Int == 1, let files = object["files"] as? [[String: Any]], files.count <= 20000 else {
            throw TransferError.message("保存済みデータの一覧が正しくありません。")
        }
        var seen = Set<String>()
        return try files.map { file in
            guard let url = file["url"] as? String, let kind = file["kind"] as? String, ["audio", "video"].contains(kind),
                  let media = file["media"] as? String, let bytes = (file["bytes"] as? NSNumber)?.int64Value, bytes > 0,
                  media.range(of: #"^downloads/media/[A-Za-z0-9._-]{1,200}\.(mp4|m4a)$"#, options: .regularExpression) != nil,
                  zip.entries[media]?.bytes == UInt64(bytes), seen.insert(media).inserted else {
                throw TransferError.message("保存済みデータの参照が正しくありません。")
            }
            let aliases = (file["aliases"] as? [String] ?? []).filter { !$0.isEmpty }
            return ImportDownload(url: url, aliases: aliases, kind: kind, media: media, bytes: bytes, duration: (file["duration"] as? NSNumber)?.doubleValue ?? 0, height: (file["height"] as? NSNumber)?.intValue ?? 0)
        }
    }

    /// ライブラリの保存に失敗したとき、公開済みのメディアを戻す。
    func rollback(_ published: [URL]) {
        for url in published { try? FileManager.default.removeItem(at: url) }
    }
}
