import AVFoundation
import Foundation
import UIKit

/// 曲のサムネイル（表示用の小さな画像）。
/// 基本は、動画の特定の場面（60秒付近。PC版と同じ規則）の1コマ：保存済みの動画・映像のあるローカルファイルはファイルから、オンラインのBilibiliは公式のプレビュー画像（videoshot）から切り出す。
/// 場面が得られない動画だけ、表紙の画像で代用する（それもなければ、代わりの画像）。
/// 通信は、hdslb.com の https だけ・Cookieなし・大きさの上限つき。保存は縮小したJPEG・バックアップ対象外。一覧の曲ごとの通信はしない。
@MainActor
final class ArtworkStore: ObservableObject {
    /// 画像が増えたときに増える（画面の再描画用）。
    @Published private(set) var revision = 0
    private let covers: URL      // 表紙の画像（場面が得られないときの代用）
    private let frames: URL      // 動画の場面の画像（優先）
    private let configuration: URLSessionConfiguration
    private var inFlight: Set<String> = []
    private let cache = NSCache<NSString, UIImage>()
    nonisolated private static let limit = 2 * 1024 * 1024
    nonisolated private static let sheetLimit = 8 * 1024 * 1024

    /// directory：表紙の保存先（従来の場所）。場面の画像は、その隣の frames に保存する。
    init(directory: URL, configuration: URLSessionConfiguration = .ephemeral) {
        covers = directory
        frames = directory.deletingLastPathComponent().appendingPathComponent("frames", isDirectory: true)
        let copy = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
        copy.httpCookieStorage = nil
        copy.httpShouldSetCookies = false
        copy.urlCache = nil
        copy.timeoutIntervalForRequest = 15
        self.configuration = copy
    }

    /// 配信先（サムネイル）として許可するURL。
    nonisolated static func isAllowed(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil, let host = url.host?.lowercased() else { return false }
        return host == "hdslb.com" || host.hasSuffix(".hdslb.com")
    }

    private static func name(_ key: String) -> String { key.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined() }
    private func coverFile(_ key: String) -> URL { covers.appendingPathComponent(Self.name(key) + ".jpg") }
    private func frameFile(_ key: String) -> URL { frames.appendingPathComponent(Self.name(key) + ".jpg") }
    private func noFrameMarker(_ key: String) -> URL { frames.appendingPathComponent(Self.name(key) + ".none") }

    func hasFrame(for key: String?) -> Bool {
        guard let key else { return false }
        return FileManager.default.fileExists(atPath: frameFile(key).path)
    }

    /// 映像がないことが分かっているもの（音声だけのファイル）。何度も調べ直さない。
    func knownWithoutFrame(_ key: String) -> Bool { FileManager.default.fileExists(atPath: noFrameMarker(key).path) }

    func hasImage(for key: String?) -> Bool {
        guard let key else { return false }
        return hasFrame(for: key) || FileManager.default.fileExists(atPath: coverFile(key).path)
    }

    func image(for key: String?) -> UIImage? {
        guard let key else { return nil }
        if let cached = cache.object(forKey: key as NSString) { return cached }
        guard let image = UIImage(contentsOfFile: frameFile(key).path) ?? UIImage(contentsOfFile: coverFile(key).path) else { return nil }
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    // MARK: 動画の場面

    /// 保存済みの動画（またはローカルの動画ファイル）から、目標の場面の1コマを作って残す。force：すでにある画像（プレビュー画像から作ったもの）を、高画質なものに置き換える。
    /// 映像がないファイルは、記録して、2回目から調べない。戻り値：作れたか。
    @discardableResult
    func makeFrame(fromFile file: URL, key: String, duration: Double = 0, force: Bool = false) async -> Bool {
        if !force, hasFrame(for: key) { return true }
        if !force, knownWithoutFrame(key) { return false }
        guard let image = await Self.frame(from: file, duration: duration) else {
            // 映像のないファイルなら、記録する（映像がありそうでも、取り出せなかっただけなら、記録しない）
            // 読み込みそのものに失敗したとき（一時的な失敗）は、記録しない。読み込めて、映像のトラックがないときだけ記録する
            if let tracks = try? await AVURLAsset(url: file).loadTracks(withMediaType: .video), tracks.isEmpty { markNoFrame(key) }
            return false
        }
        return store(frame: image, key: key)
    }

    /// 公式のプレビュー画像（videoshot）の1コマを切り出して残す。cell：共通JSが選んだ場所。
    @discardableResult
    func makeFrame(fromSheet cell: SheetCell, key: String) async -> Bool {
        guard !hasFrame(for: key) else { return true }
        guard let url = URL(string: cell.sheet), Self.isAllowed(url) else { return false }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        guard let data = await Self.download(request, configuration: configuration, limit: Self.sheetLimit), let sheet = UIImage(data: data)?.cgImage else { return false }
        let rect = CGRect(x: cell.x, y: cell.y, width: cell.width, height: cell.height)
        guard rect.maxX <= CGFloat(sheet.width), rect.maxY <= CGFloat(sheet.height), let cropped = sheet.cropping(to: rect) else { return false }
        let image = UIImage(cgImage: cropped)
        guard !Self.isFlat(image) else { return false }
        return store(frame: image, key: key)
    }

    private func markNoFrame(_ key: String) {
        try? FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: noFrameMarker(key).path, contents: Data())
    }

    private func store(frame image: UIImage, key: String) -> Bool {
        guard let jpeg = Self.shrink(image, side: 480).jpegData(compressionQuality: 0.8) else { return false }
        do {
            try FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
            var folder = frames
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            try jpeg.write(to: frameFile(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            cache.removeObject(forKey: key as NSString)
            revision += 1
            return true
        } catch { return false }
    }

    /// 目標の場面：60秒付近（長さが分かる短い動画は、長さの30%。1秒以上）。PC版と同じ規則。
    nonisolated static func targetSeconds(duration: Double) -> Double { duration > 0 ? min(60, max(1, duration * 0.3)) : 60 }

    /// ファイルから、目標の場面の1コマ。一色に近い場面は避けて、別の時刻（10秒・2秒）も試す。
    nonisolated static func frame(from file: URL, duration: Double) async -> UIImage? {
        let asset = AVURLAsset(url: file)
        guard let tracks = try? await asset.loadTracks(withMediaType: .video), !tracks.isEmpty else { return nil }
        let measured = (try? await asset.load(.duration).seconds) ?? 0
        let length = duration > 0 ? duration : (measured.isFinite ? measured : 0)
        let target = targetSeconds(duration: length)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 2, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 2, preferredTimescale: 600)
        for seconds in [target, min(target, 10), 2] {
            if length > 0, seconds >= length { continue }
            if let result = try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)) {
                let image = UIImage(cgImage: result.image)
                if !isFlat(image) { return image }
            }
        }
        return nil
    }

    /// 一色に近い画像か（真っ黒・真っ白など。何の動画か分からない場面を避ける）。
    nonisolated static func isFlat(_ image: UIImage) -> Bool {
        guard let cg = image.cgImage else { return true }
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return true }
        let mean = Double(pixels.reduce(0) { $0 + Int($1) }) / Double(pixels.count)
        let variance = pixels.reduce(0.0) { $0 + ($1.asDouble - mean) * ($1.asDouble - mean) } / Double(pixels.count)
        return variance.squareRoot() < 8
    }

    // MARK: 表紙（場面が得られないときの代用）

    /// 取得して保存する（すでにあれば何もしない）。失敗しても、曲の保存・再生には影響しない。
    func fetch(key: String, urlString: String?) async {
        guard let urlString, let url = URL(string: urlString), Self.isAllowed(url), !hasImage(for: key), !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        guard let data = await Self.download(request, configuration: configuration, limit: Self.limit), let image = UIImage(data: data) else { return }
        guard let jpeg = Self.shrink(image, side: 400).jpegData(compressionQuality: 0.8) else { return }
        do {
            try FileManager.default.createDirectory(at: covers, withIntermediateDirectories: true)
            var folder = covers
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            try jpeg.write(to: coverFile(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            cache.removeObject(forKey: key as NSString)
            revision += 1
        } catch {}
    }

    /// メインスレッドの外で読み込む。大きすぎるものは、全部を読み込まずに打ち切って通信も止める。
    nonisolated private static func download(_ request: URLRequest, configuration: URLSessionConfiguration, limit: Int) async -> Data? {
        let session = URLSession(configuration: configuration, delegate: RefuseOtherHosts(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        guard let (bytes, response) = try? await session.bytes(for: request), let http = response as? HTTPURLResponse, http.statusCode == 200, http.expectedContentLength <= Int64(limit) else { return nil }
        var data = Data()
        do { for try await byte in bytes { data.append(byte); if data.count > limit { return nil } } } catch { return nil }
        return data.isEmpty ? nil : data
    }

    private static func shrink(_ image: UIImage, side: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > side else { return image }
        let scale = side / longest
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// リダイレクト先も、許可したホスト（https）だけ。
    private final class RefuseOtherHosts: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if let url = request.url, ArtworkStore.isAllowed(url) { completionHandler(request) } else { completionHandler(nil) }
        }
    }
}

private extension UInt8 {
    var asDouble: Double { Double(self) }
}

/// 公式のプレビュー画像（videoshot）の中の、1コマの場所（共通JSが選ぶ）。
struct SheetCell: Decodable, Equatable {
    var sheet: String
    var x: Int
    var y: Int
    var width: Int
    var height: Int
}
