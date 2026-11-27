import AVFoundation
import SwiftUI

// 動画の表示（向きの制限・最大化・映像の層）。MiniPlayerView.swift から分けたもの（動作は同じ）。

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
        weak var currentPlayer: AVPlayer?
        var isInBackground = UIApplication.shared.applicationState == .background
        var observers: [NSObjectProtocol] = []
        deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer } // swiftlint:disable:this force_cast

        func updatePlayer(_ player: AVPlayer?) {
            currentPlayer = player
            if !isInBackground, playerLayer.player !== player { playerLayer.player = player }
        }

        func observeApplicationState() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            observers = [
                center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                    self?.isInBackground = true
                    self?.playerLayer.player = nil
                },
                center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                    self?.isInBackground = false
                    self?.playerLayer.player = self?.currentPlayer
                }
            ]
        }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.backgroundColor = .black
        view.playerLayer.videoGravity = .resizeAspect
        view.updatePlayer(player)
        // 画面が見えなくなる間（ロック・ホームへ戻る）は、映像の層をプレイヤーから外す。つないだままだと、iOSが映像の再生を止めるため。
        view.observeApplicationState()
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        view.updatePlayer(player)
    }
}
