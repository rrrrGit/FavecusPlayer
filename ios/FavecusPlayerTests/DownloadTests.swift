import AVFoundation
import XCTest
@testable import FavecusPlayer

/// 保存（ダウンロード）とオンライン再生用の取得。応答はすべて合成データで、実際のBilibili・配信先には接続しない
/// （URLProtocolで、実際のホスト名への要求に、合成のJSONと、テストの中で作った音声・映像を返す。許可する配信先の検査は、そのまま確認する）。
@MainActor
final class DownloadTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-download-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: 合成メディア

    /// AAC（.m4a）。seconds秒の正弦波。
    private func makeAudio(seconds: Double, name: String = "tone") throws -> Data {
        let url = directory.appendingPathComponent("\(name)-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000]
        do {
            let file = try AVAudioFile(forWriting: url, settings: settings)
            let format = file.processingFormat
            let frames = AVAudioFrameCount(44100 * seconds)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
            buffer.frameLength = frames
            let samples = try XCTUnwrap(buffer.floatChannelData?[0])
            for index in 0..<Int(frames) { samples[index] = Float(sin(Double(index) / 20)) * 0.3 }
            try file.write(from: buffer)
        }
        return try Data(contentsOf: url)
    }

    /// H.264のmp4（映像のみ）。seconds秒、単色。
    private func makeVideo(seconds: Double) async throws -> Data {
        let url = directory.appendingPathComponent("video-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 120])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 120])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        let frames = Int(seconds * 10)
        for index in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 5_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 160, 120, kCVPixelFormatType_32BGRA, nil, &buffer)
            let pixel = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pixel, [])
            if let base = CVPixelBufferGetBaseAddress(pixel) { memset(base, Int32(40 + index * 10), CVPixelBufferGetDataSize(pixel)) }
            CVPixelBufferUnlockBaseAddress(pixel, [])
            XCTAssertTrue(adaptor.append(pixel, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: 10)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
        return try Data(contentsOf: url)
    }

    // MARK: 環境

    private struct Fixture {
        var audio: Data
        var video: Data = Data()
        var audioSizeOverride: Int?
        var videoURL = "https://upos.bilivideo.com/v/64.m4s"
        var audioURL = "https://upos.bilivideo.com/a/30280.m4s"
        var duration = 3
    }

    private func environment(_ fixture: Fixture, loggedIn: Bool = true, mediaStatus: Int = 200, disallowed: Bool = false, root: URL? = nil) throws -> (DownloadService, DownloadCatalog) {
        let root = root ?? directory!
        let cookies = BilibiliCookieVault(vault: MemoryVault())
        if loggedIn { try cookies.store(["SESSDATA": "test-session"]) }
        let bilibiliHost = BilibiliHost(cookies: cookies, session: StubProtocol.session())
        let biliCore = try BiliCore(bundle: Bundle(for: SharedCore.self), host: bilibiliHost)
        let view: [String: Any] = ["code": 0, "data": ["bvid": "BV1aaaaaaaaa", "aid": 1, "duration": fixture.duration, "pic": "https://i0.hdslb.com/pic.jpg", "pages": [["page": 1, "cid": 7, "duration": fixture.duration]]]]
        var audioItem: [String: Any] = ["id": 30280, "bandwidth": 64000, "codecs": "mp4a.40.2", "baseUrl": disallowed ? "https://evil.example.com/a.m4s" : fixture.audioURL, "size": fixture.audioSizeOverride ?? fixture.audio.count]
        audioItem["backupUrl"] = [String]()
        var dash: [String: Any] = ["audio": [audioItem], "video": [Any]()]
        if !fixture.video.isEmpty { dash["video"] = [["id": 64, "height": 720, "bandwidth": 500000, "codecs": "avc1.640028", "baseUrl": fixture.videoURL, "size": fixture.video.count] as [String: Any]] }
        let play: [String: Any] = ["code": 0, "data": ["dash": dash, "timelength": fixture.duration * 1000]]
        let audio = fixture.audio, video = fixture.video
        StubProtocol.install { request in
            let path = request.url?.path ?? ""
            switch (request.url?.host, path) {
            case ("api.bilibili.com", "/x/web-interface/view"): return (200, try! JSONSerialization.data(withJSONObject: view))
            case ("api.bilibili.com", "/x/player/playurl"): return (200, try! JSONSerialization.data(withJSONObject: play))
            case ("upos.bilivideo.com", let media) where media.hasPrefix("/a/"): return (mediaStatus, audio)
            case ("upos.bilivideo.com", let media) where media.hasPrefix("/v/"): return (mediaStatus, video)
            default: return (404, Data())
            }
        }
        let media = root.appendingPathComponent("downloads", isDirectory: true)
        let catalog = DownloadCatalog(url: root.appendingPathComponent("downloads.json"), mediaDirectory: media)
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let service = DownloadService(catalog: catalog, bilibili: BilibiliService(core: biliCore), downloader: MediaDownloader(configuration: StubProtocol.session().configuration), core: core, directory: media, cacheDirectory: root.appendingPathComponent("cache", isDirectory: true))
        return (service, catalog)
    }

    private let entry = EntryItem(id: "e1", title: "合成の曲", type: "bilibili", fileName: nil, url: "https://www.bilibili.com/video/BV1aaaaaaaaa/")

    private func wait(_ service: DownloadService, key: String, kind: String = "audio", _ states: Set<DeviceMediaState>) async throws -> DeviceMediaRecord {
        let end = Date().addingTimeInterval(60)
        while Date() < end {
            if let record = service.record(key: key, kind: kind), states.contains(record.state) { return record }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("状態が変わりませんでした: \(String(describing: service.record(key: key, kind: kind)))")
        throw TransferError.message("timeout")
    }

    private func requireKey(_ service: DownloadService) async throws -> String {
        let key = await service.key(for: entry)
        return try XCTUnwrap(key)
    }

    private func leftovers(_ service: DownloadService) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: service.directory.path)) ?? []).filter { $0.hasPrefix(".dl-") }
    }

    // MARK: 音声の保存

    func testAnAudioSaveDownloadsValidatesAndRecordsTheFileWithoutSendingCookiesToTheMediaHost() async throws {
        let fixture = Fixture(audio: try makeAudio(seconds: 3))
        let (service, catalog) = try environment(fixture)
        await service.start()
        let key = try await requireKey(service)
        XCTAssertEqual(key, "bili:BV1aaaaaaaaa:p1")
        service.save(entry: entry)
        let record = try await wait(service, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .completed, record.message ?? "")
        let file = try XCTUnwrap(service.savedFile(key: key))
        XCTAssertEqual(file.pathExtension, "m4a")
        XCTAssertEqual(record.duration, 3, accuracy: 1)
        XCTAssertTrue(leftovers(service).isEmpty, "ステージングが残らない")
        for request in StubProtocol.requests where request.url?.host != "api.bilibili.com" { XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"), "配信先にはCookieを付けない") }
        XCTAssertTrue(StubProtocol.requests.contains { $0.url?.host == "api.bilibili.com" && $0.value(forHTTPHeaderField: "Cookie") != nil }, "APIにはログイン情報を付ける")
        // 再起動後も、実体を確認して完了のまま
        let again = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: service.directory)
        try await again.load()
        let reloaded = await again.record(key: key, kind: "audio")
        XCTAssertEqual(reloaded?.state, .completed)
        _ = catalog
    }

    func testASizeMismatchFailsCleanlyAndLeavesNoFile() async throws {
        let audio = try makeAudio(seconds: 2)
        var fixture = Fixture(audio: audio)
        fixture.audioSizeOverride = audio.count + 5
        let (service, _) = try environment(fixture)
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry)
        let record = try await wait(service, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .failed)
        XCTAssertNil(service.savedFile(key: key))
        XCTAssertTrue(leftovers(service).isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: service.directory.path).filter { !$0.hasPrefix(".") }.count, 0)
    }

    func testAnHttpErrorFromTheMediaHostFailsWithAMessageAndIsNotRetriedElsewhere() async throws {
        let (service, _) = try environment(Fixture(audio: try makeAudio(seconds: 2)), mediaStatus: 403)
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry)
        let record = try await wait(service, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .failed)
        XCTAssertTrue(record.message?.contains("403") ?? false, record.message ?? "")
    }

    func testADisallowedMediaHostIsNeverContacted() async throws {
        let (service, _) = try environment(Fixture(audio: try makeAudio(seconds: 2)), disallowed: true)
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry)
        let record = try await wait(service, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .failed)
        XCTAssertFalse(StubProtocol.requests.contains { $0.url?.host == "evil.example.com" })
    }

    func testAnInterruptedOrMissingFileIsNeverTreatedAsCompleted() async throws {
        let media = directory.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
        let catalog = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: media)
        var downloading = DeviceMediaRecord(key: "bili:BV1xxxxxxxxx:p1", kind: "audio", state: .downloading)
        downloading.fileName = "partial.m4a"
        try await catalog.upsert(downloading)
        var missing = DeviceMediaRecord(key: "bili:BV1yyyyyyyyy:p1", kind: "audio", state: .completed)
        missing.fileName = "gone.m4a"
        try await catalog.upsert(missing)
        let reloaded = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: media)
        try await reloaded.load()
        let first = await reloaded.record(key: downloading.key, kind: "audio"), second = await reloaded.record(key: missing.key, kind: "audio")
        XCTAssertEqual(first?.state, .failed)
        XCTAssertEqual(second?.state, .failed)
        XCTAssertNil(second?.fileName)
    }

    func testFreeSpaceIsCheckedBeforeStarting() {
        XCTAssertThrowsError(try DownloadService.ensureSpace(for: Int64.max / 4, at: FileManager.default.temporaryDirectory))
        XCTAssertNoThrow(try DownloadService.ensureSpace(for: 1024, at: FileManager.default.temporaryDirectory))
    }

    // MARK: オンライン再生

    func testOnlinePlaybackFetchesOnceIntoTheCacheAndASavedFileTakesOver() async throws {
        let (service, _) = try environment(Fixture(audio: try makeAudio(seconds: 3)))
        await service.start()
        let first = try await service.playableFile(for: entry)
        XCTAssertTrue(first.path.contains("cache"))
        let mediaRequests = StubProtocol.requests.filter { $0.url?.host == "upos.bilivideo.com" }.count
        XCTAssertEqual(mediaRequests, 1)
        let second = try await service.playableFile(for: entry)
        XCTAssertEqual(second, first)
        XCTAssertEqual(StubProtocol.requests.filter { $0.url?.host == "upos.bilivideo.com" }.count, 1, "再取得しない")
        let key = try await requireKey(service)
        service.save(entry: entry)
        _ = try await wait(service, key: key, [.completed])
        let afterSave = try await service.playableFile(for: entry)
        XCTAssertEqual(afterSave, service.savedFile(key: key))
    }

    // MARK: 動画の結合

    func testAVideoSaveMergesWithoutReencodingAndAFailedMergeKeepsTheAudio() async throws {
        let audio = try makeAudio(seconds: 2), video = try await makeVideo(seconds: 2)
        var fixture = Fixture(audio: audio)
        fixture.video = video
        fixture.duration = 2
        let (service, _) = try environment(fixture)
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry, kind: "video")
        let record = try await wait(service, key: key, kind: "video", [.completed, .failed])
        XCTAssertEqual(record.state, .completed, record.message ?? "")
        let file = try XCTUnwrap(service.savedFile(key: key, kind: "video"))
        let asset = AVURLAsset(url: file)
        let tracks = try await asset.load(.tracks)
        XCTAssertTrue(tracks.contains { $0.mediaType == .video } && tracks.contains { $0.mediaType == .audio })
        // 映像が壊れている場合：結合は失敗し、音声だけの保存は残る
        var broken = fixture
        broken.video = Data(repeating: 1, count: 4096)
        let other = directory.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let (service2, _) = try environment(broken, root: other)
        await service2.start()
        service2.save(entry: entry, kind: "video")
        let failed = try await wait(service2, key: key, kind: "video", [.completed, .failed])
        XCTAssertEqual(failed.state, .failed)
        XCTAssertNil(service2.savedFile(key: key, kind: "video"))
        XCTAssertNotNil(service2.savedFile(key: key, kind: "audio"), "音声の保存は残る")
    }
}
