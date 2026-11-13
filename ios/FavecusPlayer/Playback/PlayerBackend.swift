import AVFoundation
import Foundation

/// 再生の道具（AVPlayer）の抽象。再生順や再生できる曲の判断は共通JS・PlaybackEngineが行い、ここは「1曲を鳴らす」だけ。
/// テストでは偽の実装に差し替える。
@MainActor
protocol PlayerBackend: AnyObject {
    var onEnded: (() -> Void)? { get set }
    var onFailed: ((String) -> Void)? { get set }
    var onTick: (() -> Void)? { get set }
    var position: Double { get }
    var duration: Double { get }
    var isPlaying: Bool { get }
    func load(url: URL)
    func play()
    func pause()
    func seek(to seconds: Double)
    func stop()
}

@MainActor
final class AVPlayerBackend: PlayerBackend {
    var onEnded: (() -> Void)?
    var onFailed: ((String) -> Void)?
    var onTick: (() -> Void)?

    private let player = AVPlayer()
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var failObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var failureReported = false

    init() {
        // バックグラウンド・ロック中も再生が止まらないよう、画面が消えても動かし続ける設定。
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onTick?() }
        }
    }

    deinit {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
    }

    var position: Double {
        let seconds = player.currentTime().seconds
        return seconds.isFinite && seconds >= 0 ? seconds : 0
    }

    var duration: Double {
        let seconds = player.currentItem?.duration.seconds ?? 0
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    var isPlaying: Bool { player.rate > 0 }

    func load(url: URL) {
        removeItemObservers()
        let item = AVPlayerItem(url: url)
        failureReported = false
        // 通知は、いま読み込んでいる曲（item）のものだけを扱う。差し替え前の古い通知で、新しい曲を送らない。
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self, self.player.currentItem === item else { return }
                if item.status == .failed { self.reportFailure(item.error?.localizedDescription ?? "再生できません。") }
                self.onTick?()
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.player.currentItem === item else { return }
                self.onEnded?()
            }
        }
        failObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            Task { @MainActor in
                guard let self, self.player.currentItem === item else { return }
                self.reportFailure(error?.localizedDescription ?? "再生が途中で止まりました。")
            }
        }
        player.replaceCurrentItem(with: item)
    }

    func play() { player.play() }

    func pause() { player.pause() }

    func seek(to seconds: Double) {
        player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func stop() {
        player.pause()
        removeItemObservers()
        player.replaceCurrentItem(with: nil)
    }

    /// 同じ曲の失敗は1回だけ伝える（statusの失敗と再生途中の失敗の両方が届いても、二重に送らない）。
    private func reportFailure(_ reason: String) {
        guard !failureReported else { return }
        failureReported = true
        onFailed?(reason)
    }

    private func removeItemObservers() {
        statusObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        endObserver = nil
        failObserver = nil
    }
}
