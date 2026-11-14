import CryptoKit
import Foundation

/// playlists.fvpa（プレイリスト情報の暗号化コンテナ）の入れ物の処理だけ。中身の規則は共通JS。
/// 自動形式 FVPA0002：マジック(8) + 鍵(32) + nonce(12) = ヘッダー52バイト、続けて認証タグ(16)、暗号文。AES-256-GCM、ヘッダー全体をAAD。
/// 鍵を同梱する形式のため、秘密保護ではなく破損検出が目的。パスワード形式（FVPA0001、scrypt）は、この版では扱わない。
enum FvpaError: Error, CustomStringConvertible {
    case notArchive
    case passwordProtected
    case corrupt

    var description: String {
        switch self {
        case .notArchive: return "FavecusPlayerのアーカイブではありません。"
        case .passwordProtected: return "パスワード付きのアーカイブは、iPhone版ではまだ取り込めません。Windows版でパスワードなしで出力し直してください。"
        case .corrupt: return "アーカイブが破損しています。"
        }
    }
}

enum Fvpa {
    private static let autoHeader = 52
    private static let tagLength = 16

    /// 自動形式で暗号化する（鍵とnonceはその都度ランダム。ヘッダー全体をAADにする）。
    static func encrypt(_ plain: Data) throws -> Data {
        let key = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        let header = Data("FVPA0002".utf8) + key.withUnsafeBytes { Data($0) } + Data(nonce)
        let sealed = try AES.GCM.seal(plain, using: key, nonce: nonce, authenticating: header)
        return header + sealed.tag + sealed.ciphertext
    }

    static func decrypt(_ bytes: Data) throws -> Data {
        let data = Data(bytes)
        guard data.count >= 8 else { throw FvpaError.notArchive }
        let magic = String(decoding: data.prefix(8), as: UTF8.self)
        if magic == "FVPA0001" { throw FvpaError.passwordProtected }
        guard magic == "FVPA0002", data.count > autoHeader + tagLength + 16 else { throw FvpaError.notArchive }
        let header = Data(data[0..<autoHeader])
        let key = SymmetricKey(data: Data(data[8..<40]))
        let nonceData = Data(data[40..<52])
        let tag = Data(data[autoHeader..<(autoHeader + tagLength)])
        let cipher = Data(data[(autoHeader + tagLength)...])
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonceData), ciphertext: cipher, tag: tag)
            return try AES.GCM.open(box, using: key, authenticating: header)
        } catch {
            throw FvpaError.corrupt
        }
    }
}
