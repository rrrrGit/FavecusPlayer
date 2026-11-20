import Foundation

/// 再生速度の選べる値と、保存（この端末内だけ。同期しない）。
enum PlaybackSpeed {
    static let options: [Double] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    private static let key = "playbackSpeed"

    /// 選べる値のうち、いちばん近いもの（範囲外・数でない値は 1.0）。
    static func nearest(_ value: Double) -> Double {
        guard value.isFinite else { return 1 }
        return options.min { abs($0 - value) < abs($1 - value) } ?? 1
    }

    static func stored(_ defaults: UserDefaults = .standard) -> Double {
        guard let value = defaults.object(forKey: key) as? Double else { return 1 }
        return nearest(value)
    }

    static func store(_ value: Double, _ defaults: UserDefaults = .standard) {
        defaults.set(nearest(value), forKey: key)
    }

    static func text(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(format: "%.1f倍", rounded) : String(format: "%g倍", rounded)
    }
}
