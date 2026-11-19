import Foundation

/// おやすみタイマー（v0.7.3 F1）。規則は、PC版（src/core/sleep-timer.cjs）と同じ：
/// 時間（15・30・45・60・90分）または「この曲の終わりまで」。時間は、現在時刻の期限で判定する（画面ロックで間隔が遅れても、期限を過ぎれば止める）。
/// 期限の直前の8秒は音量を下げていき、期限で一時停止して、音量を元に戻す。端末内の一時的な状態で、保存・同期はしない。
enum SleepTimerRules {
    static let minutes = [15, 30, 45, 60, 90]
    static let fadeSeconds: TimeInterval = 8
}

@MainActor
final class SleepTimer: ObservableObject {
    enum Mode: Equatable {
        case off
        case minutes(Int)
        case endOfSong
    }

    @Published private(set) var mode: Mode = .off
    /// 時間のタイマーの残り（秒）。表示用で、1秒ごとに更新する。
    @Published private(set) var remaining: TimeInterval = 0
    private(set) var deadline: Date?
    /// 音量の倍率（1＝元の音量）。
    var onFade: ((Double) -> Void)?
    var onExpire: (() -> Void)?

    private let now: () -> Date
    private var loop: Task<Void, Never>?

    init(now: @escaping () -> Date = { Date() }) {
        self.now = now
    }

    var isOn: Bool { mode != .off }

    /// 決められた時間だけ受け付ける。それ以外は、何もせず false。
    @discardableResult
    func start(minutes: Int) -> Bool {
        guard SleepTimerRules.minutes.contains(minutes) else { return false }
        reset()
        mode = .minutes(minutes)
        deadline = now().addingTimeInterval(TimeInterval(minutes * 60))
        remaining = TimeInterval(minutes * 60)
        loop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self?.tick()
            }
        }
        return true
    }

    func startEndOfSong() {
        reset()
        mode = .endOfSong
    }

    func cancel() {
        let wasOn = isOn
        reset()
        if wasOn { onFade?(1) }
    }

    /// 曲の終わりに届いたとき：「この曲の終わりまで」なら、次の曲へ進まずに止める（true）。
    func consumeEndOfSong() -> Bool {
        guard mode == .endOfSong else { return false }
        reset()
        return true
    }

    /// 1秒ごと、および前面に戻ったときに呼ぶ。期限を過ぎていれば、すぐ止める。
    func tick() {
        guard case .minutes = mode, let deadline else { return }
        let left = deadline.timeIntervalSince(now())
        if left <= 0 {
            reset()
            onExpire?()
            onFade?(1)
            return
        }
        remaining = left
        if left <= SleepTimerRules.fadeSeconds { onFade?(left / SleepTimerRules.fadeSeconds) }
    }

    private func reset() {
        loop?.cancel()
        loop = nil
        mode = .off
        deadline = nil
        remaining = 0
    }
}
