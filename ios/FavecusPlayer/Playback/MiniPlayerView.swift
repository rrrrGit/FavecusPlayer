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

/// 動画の映像（AVPlayerのプレイヤー層）。
struct VideoSurface: UIViewRepresentable {
    let player: AVPlayer?

    final class LayerView: UIView {
        var observers: [NSObjectProtocol] = []
        deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer } // swiftlint:disable:this force_cast
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.backgroundColor = .black
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        // 画面が見えなくなる間（ロック・ホームへ戻る）は、映像の層をプレイヤーから外す。つないだままだと、iOSが映像の再生を止めるため。
        let center = NotificationCenter.default
        view.observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak view] _ in view?.playerLayer.player = nil },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak view] _ in view?.playerLayer.player = player }
        ]
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

/// 再生画面：サムネイルと動画を切り替えられる黒い枠（動画は上下に黒い余白が出る）、曲名、再生位置、操作（シャッフル・前へ・再生/一時停止・次へ・リピート）。
/// 動画に切り替えられるのは、保存済みのBilibili動画、または映像のあるローカルファイル。
struct FullPlayerView: View {
    @ObservedObject var player: PlaybackEngine
    @ObservedObject private var artwork: ArtworkStore
    let services: Services
    @Binding var isPresented: Bool
    @State private var scrubbing: Double?
    @State private var hint: String?

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
        let width = UIScreen.main.bounds.width
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 10)
            media(width: width)
            Spacer(minLength: 14)
            VStack(spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title.isEmpty ? "（再生していません）" : title).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.text).lineLimit(2)
                    if let hint { Text(hint).font(.system(size: 12)).foregroundStyle(Theme.warning) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 4) {
                    Slider(value: Binding(get: { scrubbing ?? min(player.position, max(player.duration, 1)) }, set: { scrubbing = $0 }), in: 0...max(player.duration, 1)) { editing in
                        if !editing, let value = scrubbing { player.seek(to: value); scrubbing = nil }
                    }
                    .tint(Theme.accent)
                    HStack {
                        Text(formatTime(scrubbing ?? player.position))
                        Spacer()
                        Text(formatTime(player.duration))
                    }
                    .font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                controls
            }
            .padding(.horizontal, 24)
            Spacer(minLength: 28)
        }
        .background(
            LinearGradient(colors: [Color(hex: 0x241F3D), Theme.background], startPoint: .top, endPoint: .center).ignoresSafeArea()
        )
        .alert("お知らせ", isPresented: Binding(get: { player.message != nil }, set: { if !$0 { player.message = nil } })) {
            Button("コピー") { Clipboard.copy(player.message ?? ""); player.message = nil }
            Button("閉じる", role: .cancel) { player.message = nil }
        } message: {
            Text(player.message ?? "")
        }
    }

    private var topBar: some View {
        HStack {
            Button { isPresented = false } label: { Image(systemName: "chevron.down").font(.title3.weight(.semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("閉じる")
            Spacer()
            modeSwitch
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 8)
    }

    /// サムネイル／動画の切り替え（PC版と同じ）。動画がない曲では、動画の側を薄くして、理由を出す。
    private var modeSwitch: some View {
        HStack(spacing: 0) {
            segment(icon: "photo", label: "サムネイル", selected: !player.videoMode, enabled: true) { player.setVideoMode(false); hint = nil }
            segment(icon: "play.rectangle.fill", label: "動画", selected: player.videoMode, enabled: player.videoAvailable) {
                if player.videoAvailable { player.setVideoMode(true); hint = nil } else { hint = "この曲は動画を保存していません。曲の「…」から「動画を保存」すると、動画を表示できます。" }
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.control))
        .overlay(Capsule().stroke(Theme.controlLine, lineWidth: 1))
    }

    private func segment(icon: String, label: String, selected: Bool, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 12))
                Text(label).font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(selected ? Theme.accentText : (enabled ? Theme.text : Theme.faint))
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(selected ? Theme.accent : Color.clear))
        }
        .buttonStyle(.plain)
    }

    /// 黒い枠（サムネイルも動画も、枠の中に収める。上下・左右に黒い余白が出てよい）。
    private func media(width: CGFloat) -> some View {
        ZStack {
            Color.black
            if player.videoMode {
                VideoSurface(player: player.videoPlayer)
            } else if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "music.note").font(.system(size: 54)).foregroundStyle(Color(hex: 0x50586F))
            }
        }
        .frame(width: width, height: min(width * 0.72, 320))
        .clipped()
    }

    private var controls: some View {
        HStack(spacing: 28) {
            Button { player.shuffle.toggle() } label: { Image(systemName: "shuffle").foregroundStyle(player.shuffle ? Theme.accent : Theme.muted).frame(width: 44, height: 44) }
                .accessibilityLabel(player.shuffle ? "シャッフル（オン）" : "シャッフル（オフ）")
            Button { player.previous() } label: { Image(systemName: "backward.end.fill").font(.title).frame(width: 44, height: 44) }
                .accessibilityLabel("前の曲")
            Button { player.toggle() } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 30)).foregroundStyle(Theme.accentText)
                    .frame(width: 72, height: 72).background(Circle().fill(Theme.mainControl))
            }
            Button { player.next() } label: { Image(systemName: "forward.end.fill").font(.title).frame(width: 44, height: 44) }
                .accessibilityLabel("次の曲")
            Button { cycleRepeat() } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat").foregroundStyle(player.repeatMode == .off ? Theme.muted : Theme.accent).frame(width: 44, height: 44)
            }
            .accessibilityLabel(player.repeatMode == .off ? "リピート（オフ）" : player.repeatMode == .all ? "リピート（全曲）" : "リピート（1曲）")
        }
        .font(.title3)
        .foregroundStyle(Theme.text)
        .buttonStyle(.plain)
    }

    private func cycleRepeat() {
        switch player.repeatMode {
        case .off: player.repeatMode = .all
        case .all: player.repeatMode = .one
        case .one: player.repeatMode = .off
        }
    }
}
