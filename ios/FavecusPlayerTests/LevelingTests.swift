import AVFoundation
import XCTest
@testable import FavecusPlayer

/// 音量の自動調整（v0.7.3 F5）：アラーム音の正規化と、曲の音量の測り方・倍率。
@MainActor
final class LevelingTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-leveling-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// 振幅 amplitude の正弦波（44.1kHz・モノ・16bit・WAV）。
    private func makeTone(amplitude: Float, seconds: Double) throws -> URL {
        let url = directory.appendingPathComponent("tone-\(UUID().uuidString).wav")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        let frames = AVAudioFrameCount(seconds * 44100)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<Int(frames) { samples[index] = amplitude * sin(Float(index) * 0.05) }
        try file.write(from: buffer)
        return url
    }

    /// 書き出した音声の、最大の大きさ（0〜1）と、最初の1フレームの大きさ。
    private func levels(_ url: URL) throws -> (peak: Float, first: Float) {
        let file = try AVAudioFile(forReading: url)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        var peak: Float = 0
        let channel = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<Int(buffer.frameLength) { peak = max(peak, abs(channel[index])) }
        return (peak, abs(channel[0]))
    }

    func testAlarmSoundIsRaisedToTheTargetPeakAndFadesIn() async throws {
        let source = try makeTone(amplitude: 0.3, seconds: 4)
        let output = directory.appendingPathComponent("Sounds/quiet.caf")
        try await AlarmSoundMaker.make(source: source, start: 0, duration: 3, output: output)
        let result = try levels(output)
        XCTAssertEqual(result.peak, AlarmSoundMaker.targetPeak, accuracy: 0.04, "ピークは、−1 dBFS付近")
        XCTAssertLessThan(result.first, 0.02, "最初は、音量0から立ち上がる")
    }

    func testAnAlreadyLoudAlarmSoundIsNotClippedAndAVeryQuietOneIsRaisedByAtMostTwelveDecibels() async throws {
        let loud = try makeTone(amplitude: 0.99, seconds: 3)
        let loudOut = directory.appendingPathComponent("Sounds/loud.caf")
        try await AlarmSoundMaker.make(source: loud, start: 0, duration: 2, output: loudOut)
        XCTAssertLessThanOrEqual(try levels(loudOut).peak, 0.95)
        let tiny = try makeTone(amplitude: 0.02, seconds: 3)
        let tinyOut = directory.appendingPathComponent("Sounds/tiny.caf")
        try await AlarmSoundMaker.make(source: tiny, start: 0, duration: 2, output: tinyOut)
        XCTAssertEqual(try levels(tinyOut).peak, 0.02 * AlarmSoundMaker.maxBoost, accuracy: 0.02, "上げるのは、最大4倍（+12 dB）まで")
    }

    /// 平均音量（dB）→ 倍率。PC版の test/loudness.test.cjs と同じ表。
    func testGainTableMatchesThePCRule() {
        let table: [(Double, Double)] = [(-30, 1), (-20, 1), (-16, 1), (-14, 0.7943), (-10, 0.5012), (-6, 0.3162), (-3, 0.25), (0, 0.25)]
        for (db, expected) in table { XCTAssertEqual(VolumeLeveling.gain(meanDb: db), expected, accuracy: 0.001, "\(db) dB") }
        XCTAssertEqual(VolumeLeveling.gain(meanDb: .nan), 1)
        XCTAssertEqual(VolumeLeveling.gain(meanDb: -70), 1, "無音に近い曲は、変えない")
    }

    func testMeanVolumeIsMeasuredFromTheDecodedAudio() async throws {
        let tone = try makeTone(amplitude: 0.5, seconds: 3) // 振幅0.5の正弦波のRMSは 約 −9.0 dB
        let measured = await VolumeLeveling.meanDb(of: tone)
        XCTAssertEqual(try XCTUnwrap(measured), -9.0, accuracy: 0.5)
        let bogus = directory.appendingPathComponent("bogus.wav")
        try Data("not audio".utf8).write(to: bogus)
        let none = await VolumeLeveling.meanDb(of: bogus)
        XCTAssertNil(none)
    }

    func testTheCacheRemembersAMeasurementUntilTheFileChanges() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "favecus-loudness-\(UUID().uuidString)"))
        let cache = LoudnessCache(defaults: defaults)
        let file = directory.appendingPathComponent("song.m4a")
        try Data(repeating: 1, count: 100).write(to: file)
        XCTAssertNil(cache.cachedGain(file))
        cache.store(file, meanDb: -10)
        XCTAssertEqual(try XCTUnwrap(cache.cachedGain(file)), 0.5012, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(LoudnessCache(defaults: defaults).cachedGain(file)), 0.5012, accuracy: 0.001, "再起動しても覚えている")
        try Data(repeating: 2, count: 200).write(to: file) // ファイルが変わった
        XCTAssertNil(cache.cachedGain(file), "変わったら、測り直す")
    }
}
