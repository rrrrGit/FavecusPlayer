import AVFoundation
import Foundation

/// 取得したファイルの仕上げと検証。検証に通ったものだけを「完了」にする（ファイルがあるだけでは完了にしない）。
enum MediaProcessor {
    /// 音声：配信の音声ファイルを .m4a として置き、読み込めること・音声トラックがあること・長さがAPIの値に近いことを確認する。戻り値：長さ（秒）。
    static func finalizeAudio(input: URL, output: URL, expectedDuration: Double) async throws -> Double {
        let manager = FileManager.default
        if manager.fileExists(atPath: output.path) { try manager.removeItem(at: output) }
        try manager.copyItem(at: input, to: output)
        do {
            return try await validate(file: output, needsVideo: false, expectedDuration: expectedDuration)
        } catch {
            try? manager.removeItem(at: output)
            throw error
        }
    }

    /// 動画：映像と音声を、再エンコードせずに（passthrough）1つのmp4へ結合し、検証する。失敗したら出力を残さない（呼び出し側は、音声だけの保存を残せる）。
    static func mergeVideo(video: URL, audio: URL, output: URL, expectedDuration: Double) async throws -> Double {
        let manager = FileManager.default
        if manager.fileExists(atPath: output.path) { try manager.removeItem(at: output) }
        let composition = AVMutableComposition()
        let videoAsset = AVURLAsset(url: video), audioAsset = AVURLAsset(url: audio)
        guard let sourceVideo = try await videoAsset.loadTracks(withMediaType: .video).first, let sourceAudio = try await audioAsset.loadTracks(withMediaType: .audio).first else {
            throw DownloadError.message("映像・音声のトラックを読み取れません。")
        }
        let videoDuration = try await videoAsset.load(.duration), audioDuration = try await audioAsset.load(.duration)
        let length = CMTimeMinimum(videoDuration, audioDuration)
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw DownloadError.message("結合の準備ができません。")
        }
        try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: sourceVideo, at: .zero)
        try audioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: sourceAudio, at: .zero)
        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else { throw DownloadError.message("結合できません。") }
        session.outputURL = output
        session.outputFileType = .mp4
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                session.exportAsynchronously { continuation.resume() }
            }
        } onCancel: {
            session.cancelExport()
        }
        if Task.isCancelled {
            try? manager.removeItem(at: output)
            throw CancellationError()
        }
        guard session.status == .completed else {
            try? manager.removeItem(at: output)
            throw DownloadError.message("結合に失敗しました：\(session.error.map { ErrorText.safe($0) } ?? "不明なエラー")")
        }
        do {
            // 長さが合わないときの原因を切り分けられるよう、結合前の映像・音声それぞれの長さも、エラーの文へ添える
            return try await validate(file: output, needsVideo: true, expectedDuration: expectedDuration, detail: String(format: "・結合前の映像 %.1f秒・音声 %.1f秒", videoDuration.seconds, audioDuration.seconds))
        } catch {
            try? manager.removeItem(at: output)
            throw error
        }
    }

    /// 読み込める・再生できる・必要なトラックがある・長さがAPIの値に近い（短すぎるものは、途中で切れた可能性がある）。
    static func validate(file: URL, needsVideo: Bool, expectedDuration: Double, detail: String = "") async throws -> Double {
        let asset = AVURLAsset(url: file)
        let playable = try await asset.load(.isPlayable)
        let duration = try await asset.load(.duration).seconds
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let video = try await asset.loadTracks(withMediaType: .video)
        guard playable, duration.isFinite, duration > 0, !audio.isEmpty, !needsVideo || !video.isEmpty else {
            throw DownloadError.message("保存したファイルを再生できません（形式が対応していない可能性があります）。")
        }
        if expectedDuration > 0, abs(duration - expectedDuration) > max(3, expectedDuration * 0.05) {
            throw DownloadError.message(String(format: "保存したファイルの長さが、動画の長さと一致しません（途中で切れた可能性があります）。動画 %.1f秒・保存 %.1f秒", expectedDuration, duration) + detail + "。")
        }
        return duration
    }
}
