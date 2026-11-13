import AVFoundation
import Foundation
import MediaPlayer

/// OSとの連携：オーディオセッション（バックグラウンド再生）、割り込み、ロック画面・コントロールセンターの操作と表示。
/// 実機のロック画面・イヤホン・他アプリの割り込みでの動作は、シミュレーターでは確認できない（実機で確認する項目）。
@MainActor
protocol SystemAudioHooks: AnyObject {
    func activate()
    func update(title: String?, position: Double, duration: Double, playing: Bool)
    func clear()
}

/// エンジンが提供する、OSからの操作の受け口。
@MainActor
protocol PlaybackControls: AnyObject {
    func resume()
    func pause()
    func toggle()
    func next()
    func previous()
    func seek(to seconds: Double)
}

@MainActor
final class SystemAudio: SystemAudioHooks {
    private weak var controls: PlaybackControls?
    private var resumeAfterInterruption = false
    private var observers: [NSObjectProtocol] = []
    private var configured = false

    init(controls: PlaybackControls) {
        self.controls = controls
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:))
            Task { @MainActor in self?.interruption(type: type, options: options) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            Task { @MainActor in
                // イヤホンを抜いたとき、そのまま鳴らさず一時停止する（標準的な動作）。
                if reason == .oldDeviceUnavailable { self?.controls?.pause() }
            }
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            // 再生自体は続ける（シミュレーターや一部の環境では失敗することがある）。
        }
        configureCommands()
    }

    private func interruption(type: AVAudioSession.InterruptionType?, options: AVAudioSession.InterruptionOptions?) {
        switch type {
        case .began:
            resumeAfterInterruption = true
            controls?.pause()
        case .ended:
            if resumeAfterInterruption, options?.contains(.shouldResume) == true { controls?.resume() }
            resumeAfterInterruption = false
        default:
            break
        }
    }

    private func configureCommands() {
        guard !configured else { return }
        configured = true
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in self.map { $0.run { $0.resume() } } ?? .commandFailed }
        commands.pauseCommand.addTarget { [weak self] _ in self.map { $0.run { $0.pause() } } ?? .commandFailed }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in self.map { $0.run { $0.toggle() } } ?? .commandFailed }
        commands.nextTrackCommand.addTarget { [weak self] _ in self.map { $0.run { $0.next() } } ?? .commandFailed }
        commands.previousTrackCommand.addTarget { [weak self] _ in self.map { $0.run { $0.previous() } } ?? .commandFailed }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            return self.run { $0.seek(to: position) }
        }
    }

    /// リモートコマンドはメインスレッドで呼ばれる前提（MPRemoteCommandCenterの既定）。メインアクター上の操作へ橋渡しする。
    private nonisolated func run(_ action: @escaping @MainActor (PlaybackControls) -> Void) -> MPRemoteCommandHandlerStatus {
        Task { @MainActor in
            if let controls = self.controls { action(controls) }
        }
        return .success
    }

    func update(title: String?, position: Double, duration: Double, playing: Bool) {
        guard let title else { clear(); return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0
        ]
    }

    func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
