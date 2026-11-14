import Foundation

/// 動画の情報（曲を追加するときの曲名・長さ）。
struct VideoInfo: Equatable {
    var title: String
    var duration: Double
    var thumbnailURL: String?
}

/// 共通JS（BiliResolve）が決めた、保存・再生用の配信先。URLは署名つきで短時間だけ有効（ログ・保存データには出さない）。
struct ResolvedStream: Decodable, Equatable {
    var urls: [String]
    var bandwidth: Int
    var size: Int
}

struct ResolvedMedia: Decodable, Equatable {
    var layout: String
    var streams: [ResolvedStream]
    var height: Int?
    var kind: String
    var url: String
    var duration: Double
    var thumbnailURL: String?
}

enum BilibiliError: Error, CustomStringConvertible {
    /// stopBatch：続けて別の動画を試さず、止めて知らせる（ログイン要・リスク制御・混雑）。
    case failed(String, stopBatch: Bool)

    var description: String {
        switch self { case .failed(let message, _): return message }
    }

    var stopBatch: Bool {
        switch self { case .failed(_, let stop): return stop }
    }
}

final class BilibiliService: @unchecked Sendable {
    private let core: BiliCore

    init(core: BiliCore) { self.core = core }

    private struct Response: Decodable {
        var resolved: ResolvedMedia?
        var error: String?
        var stopBatch: Bool?
    }

    /// 動画の情報だけを取得する（view API）。拒否・制限は、そのまま知らせる。
    func info(url: String) async throws -> VideoInfo {
        struct Reply: Decodable { var title: String?; var duration: Double?; var thumbnailURL: String?; var error: String?; var stopBatch: Bool? }
        let request = String(decoding: try JSONSerialization.data(withJSONObject: ["url": url]), as: UTF8.self)
        let reply = try JSONDecoder().decode(Reply.self, from: Data(try await core.call("BiliInfo", request).utf8))
        if let message = reply.error { throw BilibiliError.failed(message, stopBatch: reply.stopBatch == true) }
        return VideoInfo(title: reply.title ?? "", duration: reply.duration ?? 0, thumbnailURL: reply.thumbnailURL)
    }

    /// 動画の特定の場面（60秒付近）の1コマの場所（公式のプレビュー画像 videoshot の中）。拒否・制限は、そのまま知らせる。
    func shotCell(url: String) async throws -> SheetCell {
        struct Reply: Decodable { var cell: SheetCell?; var error: String?; var stopBatch: Bool? }
        let request = String(decoding: try JSONSerialization.data(withJSONObject: ["url": url]), as: UTF8.self)
        let reply = try JSONDecoder().decode(Reply.self, from: Data(try await core.call("BiliShots", request).utf8))
        if let message = reply.error { throw BilibiliError.failed(message, stopBatch: reply.stopBatch == true) }
        guard let cell = reply.cell else { throw BilibiliError.failed("動画の場面を取得できません。", stopBatch: false) }
        return cell
    }

    /// kind：audio または video。height：video のときの希望の高さ。拒否・制限の応答は、方法を変えて再試行せず、そのまま知らせる。
    func resolve(url: String, kind: String, height: Int = 720) async throws -> ResolvedMedia {
        let request = String(decoding: try JSONSerialization.data(withJSONObject: ["url": url, "kind": kind, "height": height]), as: UTF8.self)
        let response = try JSONDecoder().decode(Response.self, from: Data(try await core.call("BiliResolve", request).utf8))
        if let message = response.error { throw BilibiliError.failed(message, stopBatch: response.stopBatch == true) }
        guard let resolved = response.resolved else { throw BilibiliError.failed("配信先を取得できません。", stopBatch: false) }
        return resolved
    }
}
