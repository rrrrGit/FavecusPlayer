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
                    Rectangle().fill(Color.accentColor)
                        .frame(width: proxy.size.width * CGFloat(min(1, player.position / max(player.duration, 1))), height: 2)
                }
                .frame(height: 2)
                HStack(spacing: 12) {
                    ArtworkTile(image: image(for: current), title: current.title, side: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(current.title).font(.subheadline.weight(.medium)).lineLimit(1)
                        if player.isPreparing { Text("取得中…").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                    if player.isPreparing { ProgressView().controlSize(.small) }
                    Button { player.toggle() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title2).frame(width: 40, height: 44) }
                    Button { player.next() } label: { Image(systemName: "forward.fill").font(.title3).frame(width: 36, height: 44) }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(.bar)
                .contentShape(Rectangle())
                .onTapGesture { showPlayer = true }
            }
        }
        .alert("お知らせ", isPresented: Binding(get: { player.message != nil }, set: { if !$0 { player.message = nil } })) {
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

/// 再生画面：大きな画像、曲名、再生位置、操作（シャッフル・前へ・再生/一時停止・次へ・リピート）。
struct FullPlayerView: View {
    @ObservedObject var player: PlaybackEngine
    @ObservedObject private var artwork: ArtworkStore
    let services: Services
    @Binding var isPresented: Bool
    @State private var scrubbing: Double?

    init(player: PlaybackEngine, services: Services, isPresented: Binding<Bool>) {
        self.player = player
        self.services = services
        _isPresented = isPresented
        _artwork = ObservedObject(wrappedValue: services.artwork)
    }

    private var title: String { player.current?.title ?? "" }
    private var image: UIImage? {
        _ = artwork.revision
        return player.current.flatMap { artwork.image(for: services.downloads?.entryKeys[$0.entryId]) }
    }

    var body: some View {
        let side = min(UIScreen.main.bounds.width - 48, 380)
        VStack(spacing: 22) {
            HStack {
                Button { isPresented = false } label: { Image(systemName: "chevron.down").font(.title3.weight(.semibold)).frame(width: 44, height: 44) }
                Spacer()
                if player.isPreparing { Text("取得中…").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 8)
            ArtworkTile(image: image, title: title, side: side, corner: 12).shadow(radius: 16)
            VStack(alignment: .leading, spacing: 6) {
                Text(title.isEmpty ? "（再生していません）" : title).font(.title2.bold()).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            VStack(spacing: 4) {
                Slider(value: Binding(get: { scrubbing ?? min(player.position, max(player.duration, 1)) }, set: { scrubbing = $0 }), in: 0...max(player.duration, 1)) { editing in
                    if !editing, let value = scrubbing { player.seek(to: value); scrubbing = nil }
                }
                HStack {
                    Text(formatTime(scrubbing ?? player.position))
                    Spacer()
                    Text(formatTime(player.duration))
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 24)
            HStack(spacing: 28) {
                Button { player.shuffle.toggle() } label: { Image(systemName: "shuffle").foregroundStyle(player.shuffle ? Color.accentColor : Color.secondary) }
                Button { player.previous() } label: { Image(systemName: "backward.end.fill").font(.title) }
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 34)).foregroundStyle(.black)
                        .frame(width: 76, height: 76).background(Circle().fill(Color.white))
                }
                Button { player.next() } label: { Image(systemName: "forward.end.fill").font(.title) }
                Button { cycleRepeat() } label: {
                    Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat").foregroundStyle(player.repeatMode == .off ? Color.secondary : Color.accentColor)
                }
            }
            .font(.title3)
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
        .background(
            LinearGradient(colors: [ArtworkTile.color(title).opacity(0.5), Color.black], startPoint: .top, endPoint: .center).ignoresSafeArea()
        )
    }

    private func cycleRepeat() {
        switch player.repeatMode {
        case .off: player.repeatMode = .all
        case .all: player.repeatMode = .one
        case .one: player.repeatMode = .off
        }
    }
}
