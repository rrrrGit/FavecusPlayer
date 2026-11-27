import AVFoundation
import XCTest
@testable import FavecusPlayer

/// クロスフェード：始めるかどうかの判断（曲の終わりの手前だけ・短い曲・1曲リピート・次の曲の準備・二重に始めない）と、設定値の丸め。
final class CrossfadeTests: XCTestCase {
    private func start(seconds: Int = 4, position: Double = 196, duration: Double = 200, playing: Bool = true, repeatOne: Bool = false, ready: Bool = true, started: Bool = false) -> Bool {
        Crossfade.shouldStart(seconds: seconds, position: position, duration: duration, isPlaying: playing, repeatOne: repeatOne, nextIsReady: ready, alreadyStarted: started)
    }

    func testItStartsOnlyInsideTheLastSecondsOfASong() {
        XCTAssertTrue(start(position: 196))
        XCTAssertTrue(start(position: 195.8))
        XCTAssertFalse(start(position: 190), "まだ早い")
        XCTAssertFalse(start(position: 199.9), "もう終わる直前")
    }

    func testItIsOffByDefaultAndNeverStartsWhenAnythingIsNotReady() {
        XCTAssertFalse(start(seconds: 0))
        XCTAssertFalse(start(playing: false))
        XCTAssertFalse(start(repeatOne: true))
        XCTAssertFalse(start(ready: false), "次の曲を、すぐ鳴らせないとき")
        XCTAssertFalse(start(started: true), "同じ曲で、二重に始めない")
        XCTAssertFalse(Crossfade.shouldStart(seconds: 4, position: .nan, duration: 200, isPlaying: true, repeatOne: false, nextIsReady: true, alreadyStarted: false))
    }

    func testAShortSongIsNeverCrossfaded() {
        XCTAssertFalse(start(seconds: 6, position: 10, duration: 12))
        XCTAssertFalse(start(seconds: 4, position: 9, duration: 10), "つなぎ目の2倍＋2秒より短い")
        XCTAssertTrue(start(seconds: 4, position: 106, duration: 110))
    }

    func testStoredValuesSnapToTheChoices() {
        XCTAssertEqual(Crossfade.seconds(stored: 0), 0)
        XCTAssertEqual(Crossfade.seconds(stored: -3), 0)
        XCTAssertEqual(Crossfade.seconds(stored: 5), 4)
        XCTAssertEqual(Crossfade.seconds(stored: 7), 6)
        XCTAssertEqual(Crossfade.seconds(stored: 99), 10)
        XCTAssertEqual(Crossfade.choices, [0, 2, 4, 6, 8, 10])
    }

    @MainActor
    func testSeekingDuringCrossfadeRestoresTheCurrentPlayersVolume() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-seek-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false])
            let frames = AVAudioFrameCount(441000)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
            buffer.frameLength = frames
            let channel = try XCTUnwrap(buffer.floatChannelData)[0]
            for index in 0..<Int(frames) { channel[index] = 0 }
            try file.write(from: buffer)
        }
        let backend = AVPlayerBackend()
        defer { backend.stop() }
        backend.load(url: url)
        let player = try XCTUnwrap(backend.videoPlayer)
        for _ in 0..<250 {
            if player.currentItem?.status == .readyToPlay { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(player.currentItem?.status, .readyToPlay)
        XCTAssertTrue(backend.duration > 0)
        backend.volume = 0.8
        backend.gain = 0.5
        player.playImmediately(atRate: 1)
        XCTAssertGreaterThan(player.rate, 0)
        backend.crossfade = 4
        backend.load(url: url)
        XCTAssertEqual(player.volume, 0, accuracy: 0.001)
        backend.seek(to: 1)
        XCTAssertEqual(player.volume, 0.4, accuracy: 0.001)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(player.volume, 0.4, accuracy: 0.001, "遅れて届くフェード処理で音量を戻さない")
    }
}
