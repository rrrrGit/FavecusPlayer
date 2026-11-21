import Foundation

/// 曲のつなぎ目のクロスフェード（v0.7.4。iPhone版。保存済み・ローカルの曲どうしだけ）。既定はオフ（0秒）。
/// 曲の終わりの数秒前に、次の曲を重ねて始め、前の曲を小さくしながら終える。オンラインで取得する曲・動画の表示中・1曲リピートでは使わない。
enum Crossfade {
    static let choices = [0, 2, 4, 6, 8, 10]
    static let defaultsKey = "crossfadeSeconds"

    /// 保存された値を、選べる値のうち、いちばん近いものにする（知らない値は 0＝オフ）。
    static func seconds(stored: Int) -> Int {
        guard stored > 0 else { return 0 }
        return choices.min { abs($0 - stored) < abs($1 - stored) } ?? 0
    }

    /// 次の曲を、いま重ねて始めるか。曲が短すぎるとき（つなぎ目の2倍＋2秒より短い）は使わない。
    static func shouldStart(seconds: Int, position: Double, duration: Double, isPlaying: Bool, repeatOne: Bool, nextIsReady: Bool, alreadyStarted: Bool) -> Bool {
        guard seconds > 0, isPlaying, !repeatOne, nextIsReady, !alreadyStarted, duration.isFinite, position.isFinite else { return false }
        let fade = Double(seconds)
        guard duration > fade * 2 + 2 else { return false }
        let remaining = duration - position
        return remaining <= fade + 0.3 && remaining > 0.2
    }
}
