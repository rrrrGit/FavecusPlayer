import Foundation

/// アラームの音の「ランダム」（v0.7.4 H）：保存済みの曲から、完全にランダムに選ぶ。お気に入りの曲は、抽選の確率を少しだけ上げる
/// （倍率は、シャッフルと同じ1.5倍：src/core/play-ledger.cjs の FAVORITE_BOOST）。音は、選ばれた曲の最初の30秒に固定。
/// 鳴る時刻に、アプリは曲を選べない（音は、鳴る前に、ファイルとして決めて予約する）ため、予約するときと、鳴ったあとにアプリを開いたときに、抽選する。
enum AlarmRandom {
    static let favoriteBoost = 1.5
    static let duration = AlarmSound.maxDuration

    /// 重みつきの抽選。rng は 0以上1未満の乱数。曲がなければ nil。
    static func pick(_ songs: [AlarmSong], favorites: Set<String>, rng: () -> Double) -> AlarmSong? {
        guard !songs.isEmpty else { return nil }
        let weights = songs.map { favorites.contains($0.key) ? favoriteBoost : 1.0 }
        var target = min(max(rng(), 0), 0.999_999_999) * weights.reduce(0, +)
        for (song, weight) in zip(songs, weights) {
            if target < weight { return song }
            target -= weight
        }
        return songs.last
    }

    /// 選ばれた曲の、最初の30秒。
    static func sound(for song: AlarmSong) -> AlarmSound {
        AlarmSound(mediaKey: song.key, startSeconds: 0, durationSeconds: duration)
    }
}
