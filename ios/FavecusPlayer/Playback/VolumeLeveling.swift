import AVFoundation
import Foundation

/// 音量の自動調整（v0.7.3 F5）。規則は、PC版（src/core/loudness.cjs）と同じ：
/// 曲全体の平均音量（RMS、dBFS）が目標（−16 dB）より大きい曲だけ、差の分だけ再生音量を下げる（上げない。下限 0.25）。
/// 測った結果は、曲のファイルごとに端末内へ覚える（ファイルが変わったら測り直す）。同期しない。
enum VolumeLeveling {
    static let targetDb: Double = -16
    static let minGain: Double = 0.25

    /// 平均音量（dBFS）→ 再生音量の倍率（0.25〜1）。測れない・無音に近い曲は 1（変えない）。
    nonisolated static func gain(meanDb: Double) -> Double {
        guard meanDb.isFinite, meanDb > -60 else { return 1 }
        return max(minGain, min(1, pow(10, (targetDb - meanDb) / 20)))
    }

    /// 音声の平均音量（RMS、dBFS）を測る。22.05kHzのモノラルへ復号して、全体の二乗平均を取る（20分まで）。測れなければ nil。
    nonisolated static func meanDb(of url: URL, maxSeconds: Double = 1200) async -> Double? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { return nil }
        let rate = 22050.0
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }
        var sumSquares = 0.0
        var count = 0
        while let buffer = output.copyNextSampleBuffer() {
            if Task.isCancelled { reader.cancelReading(); return nil }
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr, let pointer else { continue }
            let samples = length / 2
            pointer.withMemoryRebound(to: Int16.self, capacity: samples) { values in
                for index in 0..<samples {
                    let value = Double(values[index]) / 32768.0
                    sumSquares += value * value
                }
            }
            count += samples
            if Double(count) / rate > maxSeconds { reader.cancelReading(); break }
        }
        guard count > 0 else { return nil }
        let meanSquare = sumSquares / Double(count)
        return meanSquare > 0 ? 10 * log10(meanSquare) : -120
    }
}

/// 測った平均音量の記録（曲のファイルの識別＝パス・大きさ・更新時刻 → dB）。
@MainActor
final class LoudnessCache {
    private let defaults: UserDefaults
    private let key = "loudnessCache"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func identity(_ url: URL) -> String? {
        // URLの値の保持（キャッシュ）に頼らず、毎回ファイルから読む（ファイルが変わったことを見逃さない）
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), let size = attributes[.size] as? NSNumber, let date = attributes[.modificationDate] as? Date else { return nil }
        return "\(url.path)|\(size.int64Value)|\(Int(date.timeIntervalSince1970 * 1000))"
    }

    func cachedGain(_ url: URL) -> Double? {
        guard let identity = identity(url), let table = defaults.dictionary(forKey: key) as? [String: Double], let db = table[identity] else { return nil }
        return VolumeLeveling.gain(meanDb: db)
    }

    func store(_ url: URL, meanDb: Double) {
        guard let identity = identity(url) else { return }
        var table = (defaults.dictionary(forKey: key) as? [String: Double]) ?? [:]
        table[identity] = meanDb
        if table.count > 2000 { for extra in table.keys.prefix(table.count - 2000) { table[extra] = nil } } // 古いものの整理（件数の上限）
        defaults.set(table, forKey: key)
    }
}
