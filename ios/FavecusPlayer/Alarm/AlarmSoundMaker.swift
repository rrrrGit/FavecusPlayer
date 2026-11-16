import AVFoundation
import Foundation

/// 保存済みの曲の、選んだ範囲（開始・長さ）から、アラームの音のファイル（CAF・リニアPCM 16bit）を作る。
/// 元のファイルは変えない。出力は、一時ファイルへ書いてから置き換える。
enum AlarmSoundMaker {
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
            input.requestMediaDataWhenReady(on: DispatchQueue(label: "favecus.alarm.sound")) {
                while input.isReadyForMoreMediaData {
                    if let buffer = readerOutput.copyNextSampleBuffer() {
                        input.append(buffer)
                    } else {
                        input.markAsFinished()
                        continuation.resume()
                        return
                    }
                }
            }
        }
        await writer.finishWriting()
        guard reader.status == .completed, writer.status == .completed else { throw AlarmError.sound("音声の書き出しに失敗しました") }
        if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
        try FileManager.default.moveItem(at: temp, to: output)
    }
}
