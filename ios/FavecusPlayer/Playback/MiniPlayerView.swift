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

/// 画面の向きの制限（動画の最大化の間だけ横を許す）。AppDelegate が、この値を返す。
enum OrientationLock {
    nonisolated(unsafe) static var mask: UIInterfaceOrientationMask = .portrait

    /// 向きを切り替える（landscape＝最大化、portrait＝元に戻す）。許す向きを更新してから、その向きへ回す。
    @MainActor
    static func set(_ next: UIInterfaceOrientationMask) {
        mask = next
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        var top = scene.keyWindow?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        top?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: next)) { _ in }
    }
}

/// 動画の最大化（横画面）：映像だけを大きく映す。タップで操作の表示を切り替え、画面を上から下へスワイプする（または左上の ✕）と、元の大きさへ戻る。
/// 向きは、出ている間だけ横。ステータスバーとホームバーは隠す。
struct FullscreenVideoView: View {
    @ObservedObject var player: PlaybackEngine
    @Binding var isPresented: Bool
    @State private var controlsVisible = true
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VideoSurface(player: player.videoPlayer).ignoresSafeArea()
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { withAnimation { controlsVisible.toggle() } }
            if controlsVisible {
                VStack {
                    HStack {
                        Button { close() } label: {
                            Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 44, height: 44).background(Circle().fill(Color.black.opacity(0.55)))
                        }
                        .accessibilityLabel("最大化を終わる")
                        Spacer()
                    }
                    Spacer()
                    HStack(spacing: 36) {
                        Button { player.previous() } label: {
                            Image(systemName: "backward.end.fill").font(.system(size: 24)).foregroundStyle(.white)
                                .frame(width: 56, height: 56).background(Circle().fill(Color.black.opacity(0.55)))
                        }
                        .accessibilityLabel("前の曲")
                        Button { player.toggle() } label: {
                            Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 28)).foregroundStyle(.white)
                                .frame(width: 64, height: 64).background(Circle().fill(Color.black.opacity(0.55)))
                        }
                        .accessibilityLabel(player.isPlaying ? "一時停止" : "再生")
                        Button { player.next() } label: {
                            Image(systemName: "forward.end.fill").font(.system(size: 24)).foregroundStyle(.white)
                                .frame(width: 56, height: 56).background(Circle().fill(Color.black.opacity(0.55)))
                        }
                        .accessibilityLabel("次の曲")
                    }
                    Spacer()
                    Text("画面を上から下へスワイプすると、元に戻ります").font(.system(size: 11)).foregroundStyle(.white.opacity(0.7))
                }
                .padding(16)
                .transition(.opacity)
            }
        }
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    // 縦の動きが主のときだけ、下へ引く動きに追従する
                    if abs(value.translation.height) > abs(value.translation.width) { dragOffset = max(0, value.translation.height) }
                }
                .onEnded { value in
                    let vertical = abs(value.translation.height) > abs(value.translation.width)
                    if vertical && value.translation.height > 100 { close() } else { withAnimation { dragOffset = 0 } }
                }
        )
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear { OrientationLock.set(.landscape) }
        .onDisappear { OrientationLock.set(.portrait) }
    }

    /// 元の大きさへ戻す（ゆっくり消える）。
    private func close() {
        withAnimation(.easeInOut(duration: 0.25)) { isPresented = false }
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
    @State private var location: [PlaybackEngine.LocationItem] = []
    @State private var maximized = false
    @State private var queueOpen = false
    /// シャッフル・リピートを切り替えた直後だけ、状態の文字を出す。
    @State private var toggleNote: String?
    @State private var toggleNoteTask: Task<Void, Never>?
    /// 所在の名前・曲名を押したとき：プレイリストの階層（ホームから）と、曲のID（曲の位置まで移動するとき）。再生画面を閉じて、ライブラリで表示する。
    let reveal: (_ chain: [String], _ entryId: String?) -> Void

    init(player: PlaybackEngine, services: Services, isPresented: Binding<Bool>, reveal: @escaping (_ chain: [String], _ entryId: String?) -> Void = { _, _ in }) {
        self.player = player
        self.services = services
        self.reveal = reveal
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
            if queueOpen {
                compactHeader
            } else {
                Spacer(minLength: 10)
                media(width: width)
                // 曲名・所在は、映像のすぐ下へ。操作（再生位置・ボタン）は、下へ寄せる
                titleBlock
                    .padding(.horizontal, 24)
                    .padding(.top, 16)
                Spacer(minLength: 20)
            }
            VStack(spacing: 18) {
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
            .padding(.top, queueOpen ? 12 : 0)
            if queueOpen {
                QueuePanel(player: player, close: { withAnimation(.easeInOut(duration: 0.3)) { queueOpen = false } })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                queueHandle
            }
        }
        .background(
            LinearGradient(colors: [Color(hex: 0x1B1E2A), Theme.background], startPoint: .top, endPoint: .center).ignoresSafeArea()
        )
        // 最大化は、再生画面の上に重ねて、ゆっくり現れる（画面を入れ替える下からの表示では、横向きへの切り替えとあわせて急に見えるため）
        .overlay {
            if maximized {
                FullscreenVideoView(player: player, isPresented: $maximized).preferredColorScheme(.dark)
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .onChange(of: player.videoMode) { on in
            hint = nil // 切り替えたら、「動画を保存していません」の表示は消す
            if !on { withAnimation(.easeInOut(duration: 0.25)) { maximized = false } } // 動画でなくなったら（曲が変わった・失敗した）、最大化を閉じる
        }
        .onChange(of: player.current?.entryId) { _ in hint = nil } // 曲が変わったら、前の曲の表示は消す
        .alert("お知らせ", isPresented: Binding(get: { player.message != nil }, set: { if !$0 { player.message = nil } })) {
            Button("コピー") { Clipboard.copy(player.message ?? ""); player.message = nil }
            Button("閉じる", role: .cancel) { player.message = nil }
        } message: {
            Text(player.message ?? "")
        }
    }

    /// 曲名（少し大きく）と、その下に所在（ホーム ＞ 親 ＞ 子…）を小さく。名前を押すと、そのプレイリストを、曲名を押すと、曲の位置を、ライブラリで表示する。
    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { if !location.isEmpty { reveal(location.map(\.id), player.current?.entryId) } } label: {
                Text(title.isEmpty ? "（再生していません）" : title).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .accessibilityHint("ライブラリで、この曲の位置を表示します")
            if !location.isEmpty { locationLine }
            if let hint { Text(hint).font(.system(size: 12)).foregroundStyle(Theme.warning) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: (player.current?.entryId ?? "") + "/" + (player.current?.playlistId ?? "")) { location = await player.location() }
    }

    private var locationLine: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Text("ホーム").font(.system(size: 12)).foregroundStyle(Theme.faint)
                ForEach(Array(location.enumerated()), id: \.element.id) { index, item in
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
                    Button { reveal(Array(location.prefix(index + 1)).map(\.id), nil) } label: {
                        Text(item.name).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("ライブラリで、このプレイリストを表示します")
                }
            }
        }
    }

    /// 再生キューを開いている間の、上の小さな曲の表示（画像・曲名・所在）。
    private var compactHeader: some View {
        HStack(spacing: 12) {
            ZStack {
                Color.black
                if player.videoMode { VideoSurface(player: player.videoPlayer) }
                else if let image { Image(uiImage: image).resizable().scaledToFit() }
                else { Image(systemName: "music.note").foregroundStyle(Color(hex: 0x50586F)) }
            }
            .frame(width: 96, height: 54).clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
                Text(title.isEmpty ? "（再生していません）" : title).font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.text).lineLimit(2)
                if let last = location.last { Text(last.name).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24).padding(.top, 8)
        .transition(.opacity)
    }

    /// 下の「再生キュー」の取っ手：押す、または上へ引くと、キューが開く。次の曲の名前も、ここに出す。
    private var queueHandle: some View {
        Button { withAnimation(.easeInOut(duration: 0.3)) { queueOpen = true } } label: {
            VStack(spacing: 6) {
                Capsule().fill(Theme.faint).frame(width: 36, height: 4)
                HStack(spacing: 6) {
                    Image(systemName: "chevron.up").font(.system(size: 11, weight: .bold))
                    Text(player.upcoming.first.map { "次：" + ($0.title.isEmpty ? "（無題）" : $0.title) } ?? "再生キュー").font(.system(size: 13, weight: .semibold)).lineLimit(1)
                }
                .foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity).padding(.top, 14).padding(.bottom, 10).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("再生キューを開く")
        .gesture(DragGesture(minimumDistance: 20).onEnded { value in
            if value.translation.height < -30 { withAnimation(.easeInOut(duration: 0.3)) { queueOpen = true } }
        })
        .padding(.bottom, 6)
    }

    private var topBar: some View {
        HStack {
            Button { isPresented = false } label: { Image(systemName: "chevron.down").font(.title3.weight(.semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("閉じる")
            Spacer()
            modeSwitch
            Spacer()
            // 三点リーダーは、サムネイル／動画の切り替えと同じ高さ（同じ行の中央）の右端
            if let entry = player.currentEntry, let downloads = services.downloads {
                CurrentSongMenu(entry: entry, downloads: downloads, canReveal: !location.isEmpty) { reveal(location.map(\.id), entry.id) }
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .frame(height: 44)
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
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button { withAnimation(.easeInOut(duration: 0.25)) { maximized = true } } label: {
                            Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 44, height: 44).background(Circle().fill(Color.black.opacity(0.55)))
                        }
                        .accessibilityLabel("動画を最大化")
                    }
                }
                .padding(6)
            } else if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "music.note").font(.system(size: 54)).foregroundStyle(Color(hex: 0x50586F))
            }
        }
        .frame(width: width, height: min(width * 0.72, 320))
        .clipped()
    }

    /// 有効なシャッフル・リピートは、丸く塗る（無効は、塗らず、灰色）。色が見えにくくても、塗りの有無で分かる。
    private func toggleIcon(_ name: String, on: Bool) -> some View {
        Image(systemName: name)
            .foregroundStyle(on ? Theme.accentText : Theme.muted)
            .frame(width: 44, height: 44)
            .background(Circle().fill(on ? Theme.accent : Color.clear))
    }

    private func flash(_ text: String) {
        toggleNote = text
        toggleNoteTask?.cancel()
        toggleNoteTask = Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if !Task.isCancelled { toggleNote = nil }
        }
    }

    private var controls: some View {
        VStack(spacing: 4) {
            controlRow
            Text(toggleNote ?? " ").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.accent).frame(height: 14)
            HStack(spacing: 24) {
                FavoriteToggle(player: player)
                SleepTimerMenu(timer: player.sleepTimer)
            }
        }
    }

    private var controlRow: some View {
        HStack(spacing: 28) {
            Button { player.setShuffle(!player.shuffle); flash(player.shuffle ? "シャッフル：オン" : "シャッフル：オフ") } label: { toggleIcon("shuffle", on: player.shuffle) }
                .accessibilityLabel(player.shuffle ? "シャッフル（オン）" : "シャッフル（オフ）")
            Button { player.previous() } label: { Image(systemName: "backward.end.fill").font(.title).frame(width: 44, height: 44) }
                .accessibilityLabel("前の曲")
            Button { player.toggle() } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 30)).foregroundStyle(Theme.accentText)
                    .frame(width: 72, height: 72).background(Circle().fill(Theme.mainControl))
            }
            Button { player.next() } label: { Image(systemName: "forward.end.fill").font(.title).frame(width: 44, height: 44) }
                .accessibilityLabel("次の曲")
            Button { cycleRepeat(); flash(player.repeatMode == .off ? "リピート：オフ" : player.repeatMode == .all ? "リピート：全曲" : "リピート：1曲") } label: {
                toggleIcon(player.repeatMode == .one ? "repeat.1" : "repeat", on: player.repeatMode != .off)
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

/// 再生画面の右上の「…」：曲の選択時（ライブラリの曲の行）と同じ、保存・削除の操作と、ライブラリでの位置の表示。
private struct CurrentSongMenu: View {
    let entry: EntryItem
    @ObservedObject var downloads: DownloadService
    let canReveal: Bool
    let reveal: () -> Void

    private var key: String? { downloads.entryKeys[entry.id] }

    var body: some View {
        Menu {
            if canReveal { Button(action: reveal) { Label("ライブラリで位置を表示", systemImage: "scope") } }
            if entry.type == "bilibili", let key {
                ForEach(["audio", "video"], id: \.self) { kind in
                    let label = kind == "video" ? "動画" : "音声"
                    let state = downloads.record(key: key, kind: kind)?.state
                    if state?.inProgress == true {
                        Button(role: .destructive) { downloads.cancel(key: key, kind: kind) } label: { Label(label + "の保存を取り消す", systemImage: "xmark.circle") }
                    } else if state == .completed {
                        Button(role: .destructive) { Task { await downloads.remove(key: key, kind: kind) } } label: { Label(label + "の保存を削除", systemImage: "trash") }
                    } else {
                        Button { downloads.save(entry: entry, kind: kind) } label: {
                            Label(kind == "video" ? "動画を保存（" + String(DownloadService.preferredHeight) + "p）" : label + "を保存", systemImage: kind == "video" ? "film" : "arrow.down.circle")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis").font(.title3.weight(.semibold)).foregroundStyle(Theme.text).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("曲のメニュー")
    }
}

/// 再生キュー：再生中の曲と、これから再生する曲。右端の「≡」をドラッグして並べ替え、曲を押すとその曲へ移る。下へ引く（または見出しを押す）と閉じる。
private struct QueuePanel: View {
    @ObservedObject var player: PlaybackEngine
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: close) {
                VStack(spacing: 6) {
                    Capsule().fill(Theme.faint).frame(width: 36, height: 4)
                    HStack {
                        Text("再生キュー").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 24)
                }
                .padding(.top, 10).padding(.bottom, 8).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("再生キューを閉じる")
            .gesture(DragGesture(minimumDistance: 20).onEnded { value in
                if value.translation.height > 30 { close() }
            })
            List {
                if let current = player.current {
                    HStack(spacing: 8) {
                        Image(systemName: player.isPlaying ? "speaker.wave.2.fill" : "speaker.fill").foregroundStyle(Theme.accent)
                        Text(current.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent).lineLimit(1)
                        Spacer()
                        Text("再生中").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    .listRowBackground(Color.clear)
                    .moveDisabled(true)
                }
                ForEach(player.upcoming) { entry in
                    Button { Task { await player.playQueued(entry.id) } } label: {
                        Text(entry.title.isEmpty ? "（無題）" : entry.title).font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                }
                .onMove { source, destination in
                    guard let from = source.first else { return }
                    let to = destination > from ? destination - 1 : destination
                    guard from != to else { return }
                    Task { await player.moveQueued(from: from, to: to) }
                }
                if player.upcoming.isEmpty {
                    Text(player.repeatMode == .off ? "このあとの曲はありません" : "この周の最後です。このあと、最初から続きます").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.editMode, .constant(.active)) // 右端に「≡」（並べ替え）を出す
        }
        .task { await player.refreshQueue() }
    }
}

/// おやすみタイマーの入口（再生画面の操作の下）。時間か「この曲の終わりまで」を選ぶ。設定中は、残り時間を表示する。
struct SleepTimerMenu: View {
    @ObservedObject var timer: SleepTimer

    var body: some View {
        Menu {
            ForEach(SleepTimerRules.minutes, id: \.self) { minutes in
                Button("\(minutes)分") { timer.start(minutes: minutes) }
            }
            Button("この曲の終わりまで") { timer.startEndOfSong() }
            if timer.isOn {
                Divider()
                Button("解除", role: .destructive) { timer.cancel() }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: timer.isOn ? "moon.zzz.fill" : "moon.zzz")
                Text(label)
            }
            .font(.system(size: 13))
            .foregroundStyle(timer.isOn ? Theme.accent : Theme.muted)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("おやすみタイマー")
        .accessibilityValue(label)
    }

    private var label: String {
        switch timer.mode {
        case .off: return "おやすみタイマー"
        case .endOfSong: return "この曲の終わりまで"
        case .minutes:
            let total = Int(timer.remaining.rounded(.up))
            return String(format: "残り %d:%02d", total / 60, total % 60)
        }
    }
}
