import AVFoundation
import Foundation

/// 保存済みの曲の、選んだ範囲（開始・長さ）から、アラームの音のファイル（CAF・リニアPCM 16bit）を作る。
/// 元のファイルは変えない。出力は、一時ファイルへ書いてから置き換える。
enum AlarmSoundMaker {
    /// 音量を揃える：ピークを −1 dBFS へ（小さい音を上げるのは、最大 +12 dB まで）。最初の0.2秒は、音をなめらかに立ち上げる（クリック音を避ける）。
    static let targetPeak: Float = 0.891
    static let maxBoost: Float = 4
    static let fadeInSeconds = 0.2

    private final class LevelState: @unchecked Sendable {
        var framesDone = 0
        var finished = false
    }

    private static func peakOf(asset: AVURLAsset, track: AVAssetTrack, range: CMTimeRange, settings: [String: Any]) throws -> Int {
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = range
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        guard reader.canAdd(output) else { throw AlarmError.sound("音声を読み込めません") }
        reader.add(output)
        guard reader.startReading() else { throw AlarmError.sound("音声を読み込めません") }
        var peak = 0
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr, let pointer else { continue }
            let count = length / 2
            pointer.withMemoryRebound(to: Int16.self, capacity: count) { values in
                for index in 0..<count { peak = max(peak, abs(Int(values[index]))) }
            }
        }
        return peak
    }

    /// 16bitの音声のサンプルに、倍率とフェードインをかける（ステレオ・インターリーブ）。
    private static func scale(_ buffer: CMSampleBuffer, gain: Float, fadeFrames: Int, state: LevelState) {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr, let pointer else { return }
        let count = length / 2
        let start = state.framesDone
        pointer.withMemoryRebound(to: Int16.self, capacity: count) { values in
            for index in 0..<count {
                let frame = start + index / 2
                var factor = gain
                if frame < fadeFrames { factor *= Float(frame) / Float(fadeFrames) }
                values[index] = Int16(max(-32768, min(32767, (Float(values[index]) * factor).rounded())))
            }
        }
        state.framesDone += count / 2
    }

    static func make(source: URL, start: Double, duration: Double, output: URL) async throws {
        let asset = AVURLAsset(url: source)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw AlarmError.sound("音声がありません") }
        let total = try await asset.load(.duration).seconds
        guard total.isFinite, total > 0 else { throw AlarmError.sound("曲の長さを読めません") }
        let from = min(max(0, start), max(0, total - AlarmSound.minDuration))
        let length = min(max(AlarmSound.minDuration, duration), AlarmSound.maxDuration, total - from)
        guard length > 0 else { throw AlarmError.sound("範囲が曲の外です") }

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600), duration: CMTime(seconds: length, preferredTimescale: 600))
        let pcm: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
        ]
        let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: pcm)
        guard reader.canAdd(readerOutput) else { throw AlarmError.sound("音声を読み込めません") }
        reader.add(readerOutput)
        let peak = try peakOf(asset: asset, track: track, range: reader.timeRange, settings: pcm)
        let gain: Float = peak > 0 ? min(maxBoost, targetPeak / (Float(peak) / 32768)) : 1
        let fadeFrames = Int(fadeInSeconds * 44100)
        let level = LevelState()

        let directory = output.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temp = directory.appendingPathComponent(".tmp-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: temp) }
        let writer = try AVAssetWriter(outputURL: temp, fileType: .caf)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: pcm)
        guard writer.canAdd(input) else { throw AlarmError.sound("音声を書き出せません") }
        writer.add(input)

        guard reader.startReading() else { throw AlarmError.sound("音声を読み込めません") }
        guard writer.startWriting() else { throw AlarmError.sound("音声を書き出せません") }
        writer.startSession(atSourceTime: CMTime(seconds: from, preferredTimescale: 600))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let complete: @Sendable () -> Void = {
                guard !level.finished else { return }
                level.finished = true
                input.markAsFinished()
                continuation.resume()
            }
            input.requestMediaDataWhenReady(on: DispatchQueue(label: "favecus.alarm.sound")) {
                if level.finished { return }
                while input.isReadyForMoreMediaData {
                    guard writer.status == .writing, reader.status == .reading || reader.status == .completed else {
                        complete()
                        return
                    }
                    if let buffer = readerOutput.copyNextSampleBuffer() {
                        scale(buffer, gain: gain, fadeFrames: fadeFrames, state: level)
                        if !input.append(buffer) {
                            complete()
                            return
                        }
                    } else {
                        complete()
                        return
                    }
                }
                if writer.status != .writing || reader.status == .failed || reader.status == .cancelled {
                    complete()
                }
            }
        }
        await writer.finishWriting()
        guard reader.status == .completed, writer.status == .completed else { throw AlarmError.sound("音声の書き出しに失敗しました") }
        if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
        try FileManager.default.moveItem(at: temp, to: output)
    }
}
