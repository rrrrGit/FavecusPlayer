import SwiftUI

/// 再生画面の「お気に入り」（♡／♥）。お気に入りの曲は、シャッフル再生で、少しだけ選ばれやすくなる。曲のメディア単位（同じ動画・パートは共通）。
struct FavoriteToggle: View {
    @ObservedObject var player: PlaybackEngine
    @State private var key: String?

    var body: some View {
        _ = player.favoriteRevision // 変わったら、表示を更新する
        let on = player.isFavorite(key: key)
        return Button { player.setFavorite(key: key, !on) } label: {
            HStack(spacing: 6) {
                Image(systemName: on ? "heart.fill" : "heart")
                Text(on ? "お気に入り" : "お気に入りにする")
            }
            .font(.system(size: 13))
            .foregroundStyle(on ? Theme.accent : Theme.muted)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(key == nil)
        .accessibilityLabel(on ? "お気に入りから外す" : "お気に入りにする")
        .task(id: player.current?.entryId) { key = await player.currentFavoriteKey() }
    }
}
