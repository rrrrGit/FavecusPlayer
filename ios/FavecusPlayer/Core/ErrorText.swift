import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// 画面・記録に出すエラーの文字。署名つきの配信URL・ファイルの場所のような、不要で機密性のある内容を含めない
/// （OSのエラーの説明には、失敗したURL全体が入ることがある）。エラーのコードは残す（コピーして報告できるように）。
enum ErrorText {
    static func safe(_ error: Error) -> String {
        if let url = error as? URLError { return "通信に失敗しました（コード \(url.code.rawValue)：\(label(url.code))）。" }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return "通信に失敗しました（コード \(ns.code)）。" }
        if error is CocoaError || type(of: error) == NSError.self {
            return clean(ns.localizedDescription) + "（\(ns.domain) \(ns.code)）"
        }
        if let custom = error as? CustomStringConvertible { return clean(custom.description) }
        return clean(ns.localizedDescription) + "（\(ns.domain) \(ns.code)）"
    }

    /// 文字の中のURLを省略する。
    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: #"https?://[^\s,)"'}\]]+"#, with: "（URLは省略）", options: .regularExpression)
    }

    private static func label(_ code: URLError.Code) -> String {
        switch code {
        case .networkConnectionLost: return "接続が途中で切れました"
        case .timedOut: return "時間切れ"
        case .notConnectedToInternet: return "オフライン"
        case .cannotConnectToHost, .cannotFindHost: return "接続できません"
        case .secureConnectionFailed, .serverCertificateUntrusted: return "安全な接続に失敗"
        case .cancelled: return "取り消し"
        default: return "通信エラー"
        }
    }
}

/// お知らせのエラーを、クリップボードへコピーする（報告用）。
enum Clipboard {
    static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}

/// 動画配信先へ送る共通の見出し。Windows版（ブラウザの User-Agent と Referer を付けて取得）と同じ考えで、iPhoneのSafariの標準的な表記（OSの版は固定の値）で名乗る。
/// 最初の要求から固定で送り、拒否されたあとに表記を変えない。保護・制限の回避ではなく、通常のWebと同じ方法で取得するための表記（Cookieは付けない）。
enum MediaHeaders {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    static let referer = "https://www.bilibili.com/"
}
