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
    /// 音量（0〜1）。おやすみタイマーの終わりのフェードに使う。
    var volume: Float { get set }
    /// 曲ごとの音量の自動調整の倍率（0〜1。1＝そのまま）。実際の音量は、volume × gain。
    var gain: Float { get set }
    /// 再生速度（0.5〜2.0。1＝そのまま）。音の高さは変えない。
    var speed: Float { get set }
    /// 次の load で、いま鳴っている曲を、この秒数で小さくしながら、新しい曲を重ねて始める（0＝しない。load のあとは、0に戻される）。
    var crossfade: Double { get set }
    func load(url: URL)
    func play()
    func pause()
    func seek(to seconds: Double)
    func stop()
    /// 動画を映すためのプレイヤー（映像を持たない道具・テストではnil）。
    var videoPlayer: AVPlayer? { get }
}

extension PlayerBackend {
    var videoPlayer: AVPlayer? { nil }
    var volume: Float {
        get { 1 }
        set {}
    }
    var gain: Float {
        get { 1 }
        set {}
    }
    var speed: Float {
        get { 1 }
        set {}
    }
    var crossfade: Double {
        get { 0 }
        set {}
    }
}

@MainActor
final class AVPlayerBackend: PlayerBackend {
    var onEnded: (() -> Void)?
    var onFailed: ((String) -> Void)?
    var onTick: (() -> Void)?

    private let player = AVPlayer()
    var videoPlayer: AVPlayer? { player }
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

    private var fade: Float = 1
    private var levelGain: Float = 1
    /// クロスフェードの間の、新しい曲の音量の割合（0→1）。おやすみタイマーの音量（fade）とは別。
    private var mix: Float = 1
    private var ghost: AVPlayer?
    private var fadeTask: Task<Void, Never>?
    var crossfade: Double = 0
    private func applyVolume() { player.volume = fade * levelGain * mix }

    /// いま鳴っている曲を、別の再生（ghost）へ移して鳴らし続け、秒数をかけて小さくする。新しい曲は、大きくしていく。
    private func startCrossfade() {
        let seconds = crossfade
        crossfade = 0
        guard seconds > 0, player.rate > 0, let old = player.currentItem, old.duration.seconds.isFinite else {
            endCrossfade()
            return
        }
        let time = player.currentTime()
        let outgoingGain = levelGain
        endCrossfade()
        removeItemObservers()
        player.replaceCurrentItem(with: nil) // 古い曲を、この再生から外す（1つの曲を、2つの再生に結びつけない）
        let outgoing = AVPlayer(playerItem: old)
        outgoing.defaultRate = speed
        outgoing.volume = fade * outgoingGain
        ghost = outgoing
        outgoing.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak outgoing] _ in
            Task { @MainActor in
                guard let self, let outgoing, self.ghost === outgoing, self.fadeTask != nil else { return }
                outgoing.playImmediately(atRate: self.speed)
            }
        }
        mix = 0
        applyVolume()
        fadeTask = Task { @MainActor [weak self] in
            let steps = max(1, Int(seconds * 20))
            for step in 1...steps {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self, !Task.isCancelled else { return }
                let progress = Float(step) / Float(steps)
                self.mix = progress
                self.applyVolume()
                self.ghost?.volume = self.fade * outgoingGain * (1 - progress)
            }
            self?.endCrossfade()
        }
    }

    private func endCrossfade() {
        fadeTask?.cancel()
        fadeTask = nil
        ghost?.pause()
        ghost?.replaceCurrentItem(with: nil)
        ghost = nil
        mix = 1
        applyVolume()
    }

    var volume: Float {
        get { fade }
        set { fade = max(0, min(1, newValue)); applyVolume() }
    }

    var gain: Float {
        get { levelGain }
        set { levelGain = max(0, min(1, newValue)); applyVolume() }
    }

    var position: Double {
        let seconds = player.currentTime().seconds
        return seconds.isFinite && seconds >= 0 ? seconds : 0
    }

    var duration: Double {
        let seconds = player.currentItem?.duration.seconds ?? 0
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    var isPlaying: Bool { player.timeControlStatus != .paused || player.rate > 0 }

    func load(url: URL) {
        startCrossfade()
        removeItemObservers()
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .spectral // 速度を変えても、音の高さを変えない
        failureReported = false
        // 通知は、いま読み込んでいる曲（item）のものだけを扱う。差し替え前の古い通知で、新しい曲を送らない。
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self, self.player.currentItem === item else { return }
                if item.status == .failed { self.reportFailure(item.error.map { ErrorText.safe($0) } ?? "再生できません。") }
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
                self.reportFailure(error.map { ErrorText.safe($0) } ?? "再生が途中で止まりました。")
            }
        }
        player.replaceCurrentItem(with: item)
    }

    /// 再生速度。再生中なら、すぐ反映する。一時停止中は、次に再生するとき（defaultRate）から。
    var speed: Float = 1 {
        didSet {
            player.defaultRate = speed
            if player.rate > 0 { player.rate = speed }
        }
    }

    func play() { player.play() }

    func pause() {
        endCrossfade()
        player.pause()
    }

    func seek(to seconds: Double) {
        endCrossfade()
        player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func stop() {
        endCrossfade()
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
