import AVFoundation
import SwiftUI

/// 画面下のミニプレイヤー：画像・曲名・再生/一時停止・次へ。押すと再生画面が開く。曲がないときは何も出さない。
struct MiniPlayerBar: View {
    @ObservedObject var player: PlaybackEngine
    @ObservedObject private var artwork: ArtworkStore
    let services: Services
    @Binding var showPlayer: Bool

    init(player: PlaybackEngine, services: Services, showPlayer: Binding<Bool>) {
        self.player = player
        self.services = services
        _showPlayer = showPlayer
        _artwork = ObservedObject(wrappedValue: services.artwork)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let current = player.current {
                GeometryReader { proxy in
                    Rectangle().fill(Theme.accent)
                        .frame(width: proxy.size.width * CGFloat(min(1, player.position / max(player.duration, 1))), height: 2)
                }
                .frame(height: 2)
                HStack(spacing: 12) {
                    ArtworkTile(image: image(for: current), title: current.title, side: 64)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(current.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                        if player.isPreparing { Text("取得中…").font(.system(size: 10)).foregroundStyle(Theme.muted) }
                    }
                    Spacer(minLength: 0)
                    if player.isPreparing { ProgressView().controlSize(.small) }
                    Button { player.toggle() } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 16)).foregroundStyle(Theme.accentText)
                            .frame(width: 38, height: 38).background(Circle().fill(Theme.mainControl))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel(player.isPlaying ? "一時停止" : "再生")
                    Button { player.next() } label: { Image(systemName: "forward.fill").font(.title3).foregroundStyle(Theme.muted).frame(width: 44, height: 44) }
                        .accessibilityLabel("次の曲")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(Theme.transport)
                .overlay(alignment: .top) { Rectangle().fill(Color(hex: 0x323547)).frame(height: 1) }
                .contentShape(Rectangle())
                .onTapGesture { showPlayer = true }
            }
        }
        .alert("お知らせ", isPresented: Binding(get: { player.message != nil }, set: { if !$0 { player.message = nil } })) {
            Button("コピー") { Clipboard.copy(player.message ?? ""); player.message = nil }
            Button("閉じる", role: .cancel) { player.message = nil }
        } message: {
            Text(player.message ?? "")
        }
    }

    private func image(for current: PlaybackEngine.NowPlaying) -> UIImage? {
        _ = artwork.revision
        return artwork.image(for: services.downloads?.entryKeys[current.entryId])
    }
}

