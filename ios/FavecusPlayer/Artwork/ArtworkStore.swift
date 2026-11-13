import Foundation
import UIKit

/// Bilibiliの曲のサムネイル（表示用の小さな画像）。曲の配信先を取得したとき（保存・オンライン再生）に1回だけ取得して、端末に残す。
/// 取得先は hdslb.com の https だけ。Cookieは付けない。大きさ（2MB以下）と画像であることを確認し、縮小して保存する。バックアップ対象外。
/// 一覧の曲ごとに通信はしない（取得済みの画像だけを表示し、なければ色つきの代わりの画像を出す）。
@MainActor
final class ArtworkStore: ObservableObject {
    /// 画像が増えたときに増える（画面の再描画用）。
    @Published private(set) var revision = 0
    private let directory: URL
    private let configuration: URLSessionConfiguration
    private var inFlight: Set<String> = []
    private let cache = NSCache<NSString, UIImage>()
    private static let limit = 2 * 1024 * 1024

    init(directory: URL, configuration: URLSessionConfiguration = .ephemeral) {
        self.directory = directory
        let copy = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
        copy.httpCookieStorage = nil
        copy.httpShouldSetCookies = false
        copy.urlCache = nil
        copy.timeoutIntervalForRequest = 15
        self.configuration = copy
    }

    /// 配信先（サムネイル）として許可するURL。
    static func isAllowed(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil, let host = url.host?.lowercased() else { return false }
        return host == "hdslb.com" || host.hasSuffix(".hdslb.com")
    }

    private func file(for key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
        return directory.appendingPathComponent(safe + ".jpg")
    }

    func hasImage(for key: String?) -> Bool {
        guard let key else { return false }
        return FileManager.default.fileExists(atPath: file(for: key).path)
    }

    func image(for key: String?) -> UIImage? {
        guard let key else { return nil }
        if let cached = cache.object(forKey: key as NSString) { return cached }
        guard let image = UIImage(contentsOfFile: file(for: key).path) else { return nil }
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    /// 取得して保存する（すでにあれば何もしない）。失敗しても、曲の保存・再生には影響しない。
    func fetch(key: String, urlString: String?) async {
        guard let urlString, let url = URL(string: urlString), Self.isAllowed(url), !hasImage(for: key), !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        let session = URLSession(configuration: configuration, delegate: RefuseOtherHosts(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        // 大きすぎるものは、全部を読み込まずに打ち切る
        guard let (bytes, response) = try? await session.bytes(for: request), let http = response as? HTTPURLResponse, http.statusCode == 200, http.expectedContentLength <= Int64(Self.limit) else { return }
        var data = Data()
        do { for try await byte in bytes { data.append(byte); if data.count > Self.limit { return } } } catch { return }
        guard !data.isEmpty, let image = UIImage(data: data) else { return }
        let small = Self.shrink(image, side: 400)
        guard let jpeg = small.jpegData(compressionQuality: 0.8) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var folder = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            try jpeg.write(to: file(for: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            cache.removeObject(forKey: key as NSString)
            revision += 1
        } catch {}
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
