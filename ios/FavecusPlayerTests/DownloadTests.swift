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
        var audioBackups: [String] = []
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
        audioItem["backupUrl"] = fixture.audioBackups
        var dash: [String: Any] = ["audio": [audioItem], "video": [Any]()]
        if !fixture.video.isEmpty { dash["video"] = [["id": 64, "height": 720, "bandwidth": 500000, "codecs": "avc1.640028", "baseUrl": fixture.videoURL, "size": fixture.video.count] as [String: Any]] }
        let play: [String: Any] = ["code": 0, "data": ["dash": dash, "timelength": fixture.duration * 1000]]
        let audio = fixture.audio, video = fixture.video
        StubProtocol.install { request in
            let path = request.url?.path ?? ""
            switch (request.url?.host, path) {
            case ("api.bilibili.com", "/x/web-interface/view"): return (200, try! JSONSerialization.data(withJSONObject: view))
            case ("api.bilibili.com", "/x/player/playurl"): return (200, try! JSONSerialization.data(withJSONObject: play))
            case ("upos.bilivideo.com", "/a/broken.m4s"): return (567, Data())
            case ("upos.bilivideo.com", let media) where media.hasPrefix("/a/"): return (mediaStatus, audio)
            case ("upos.bilivideo.com", let media) where media.hasPrefix("/v/"): return (mediaStatus, video)
            default: return (404, Data())
            }
        }
        let media = root.appendingPathComponent("downloads", isDirectory: true)
        let catalog = DownloadCatalog(url: root.appendingPathComponent("downloads.json"), mediaDirectory: media)
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let service = DownloadService(catalog: catalog, bilibili: BilibiliService(core: biliCore), downloader: MediaDownloader(configuration: StubProtocol.session().configuration), transfers: BackgroundTransfers(configuration: StubProtocol.session().configuration, identifier: "test-\(UUID().uuidString)", jobsDirectory: root.appendingPathComponent("download-jobs", isDirectory: true), stagingRoot: media), core: core, directory: media, cacheDirectory: root.appendingPathComponent("cache", isDirectory: true))
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

    func testAServerErrorFromOneMediaUrlFallsBackToTheNextCandidateAndSendsABrowserUserAgentWithoutCookies() async throws {
        var fixture = Fixture(audio: try makeAudio(seconds: 2))
        fixture.audioURL = "https://upos.bilivideo.com/a/broken.m4s"
        fixture.audioBackups = ["https://upos.bilivideo.com/a/good.m4s"]
        let (service, _) = try environment(fixture)
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry)
        let record = try await wait(service, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .completed, record.message ?? "")
        let media = StubProtocol.requests.filter { $0.url?.host == "upos.bilivideo.com" }
        XCTAssertEqual(media.count, 2, "拒否ではない失敗（567）は、次の候補のURLで試す")
        XCTAssertTrue(media.allSatisfy { ($0.value(forHTTPHeaderField: "User-Agent") ?? "").hasPrefix("Mozilla/5.0") && $0.value(forHTTPHeaderField: "Cookie") == nil })
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

    // MARK: 再起動後の引き継ぎ（背面の取得の続き）

    private func plantJob(_ service: DownloadService, id: String, key: String, files: [String: Data], errors: [String: String] = [:]) async throws {
        let job = DownloadJob(id: id, key: key, kind: "audio", title: "曲", quality: 0, duration: 2, layout: "dash", streams: [JobStream(urls: ["https://upos.bilivideo.com/a/x"], size: 0, ext: "m4a")], createdAt: Date().timeIntervalSince1970)
        let jobs = directory.appendingPathComponent("download-jobs", isDirectory: true)
        try FileManager.default.createDirectory(at: jobs, withIntermediateDirectories: true)
        try JSONEncoder().encode(job).write(to: jobs.appendingPathComponent("\(id).json"))
        let staging = service.directory.appendingPathComponent(".dl-\(id)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        for (name, data) in files { try data.write(to: staging.appendingPathComponent(name)) }
        for (name, text) in errors { try text.write(to: staging.appendingPathComponent(name), atomically: true, encoding: .utf8) }
        let catalog = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: service.directory)
        try await catalog.upsert(DeviceMediaRecord(key: key, kind: "audio", state: .downloading))
    }

    func testRelaunchFinishesAJobWhoseFilesWereFetchedInTheBackground() async throws {
        let audio = try makeAudio(seconds: 2)
        let key = "bili:BV1aaaaaaaaa:p1"
        let (service, _) = try environment(Fixture(audio: audio))
        try await plantJob(service, id: "job-done", key: key, files: ["stream-0.m4a": audio])
        // 再起動：同じ保存先を読む新しいサービス
        let (relaunched, _) = try environment(Fixture(audio: audio))
        await relaunched.start()
        let record = try await wait(relaunched, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .completed, record.message ?? "")
        XCTAssertNotNil(relaunched.savedFile(key: key))
        XCTAssertTrue(leftovers(relaunched).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("download-jobs/job-done.json").path))
    }

    func testRelaunchFailsAJobWithNoTaskAndNoFilesAndRemovesItsFolder() async throws {
        let key = "bili:BV1bbbbbbbbb:p1"
        let audio = try makeAudio(seconds: 2)
        let (service, _) = try environment(Fixture(audio: audio))
        try await plantJob(service, id: "job-lost", key: key, files: [:])
        let (relaunched, _) = try environment(Fixture(audio: audio))
        await relaunched.start()
        let record = try await wait(relaunched, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .failed)
        XCTAssertTrue(record.message?.contains("中断") ?? false)
        XCTAssertTrue(leftovers(relaunched).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("download-jobs/job-lost.json").path))
    }

    func testRelaunchCleansOnlyFoldersThatHaveNoJob() async throws {
        let key = "bili:BV1ccccccccc:p1"
        let audio = try makeAudio(seconds: 2)
        let (service, _) = try environment(Fixture(audio: audio))
        try await plantJob(service, id: "job-kept", key: key, files: ["stream-0.m4a": audio])
        let orphan = service.directory.appendingPathComponent(".dl-orphan", isDirectory: true)
        try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
        let (relaunched, _) = try environment(Fixture(audio: audio))
        await relaunched.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path), "持ち主のいない作業フォルダは片付ける")
        let record = try await wait(relaunched, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .completed, "続いているジョブの取得済みファイルは消されない: \(record.message ?? "")")
    }

    func testAFailedTransferIsRecordedWithItsReasonWithoutAnotherRequest() async throws {
        let key = "bili:BV1ddddddddd:p1"
        let audio = try makeAudio(seconds: 2)
        let (service, _) = try environment(Fixture(audio: audio))
        try await plantJob(service, id: "job-refused", key: key, files: [:], errors: ["stream-0.err": "refused:配信先から取得できません（HTTP 412）。"])
        let (relaunched, _) = try environment(Fixture(audio: audio))
        await relaunched.start()
        let record = try await wait(relaunched, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .failed)
        XCTAssertTrue(record.message?.contains("412") ?? false)
        XCTAssertFalse(StubProtocol.requests.contains { $0.url?.host == "upos.bilivideo.com" }, "拒否のあとに、別の要求を送らない")
    }

    func testNothingIsFinishedBeforeTheCatalogHasBeenLoaded() async throws {
        let audio = try makeAudio(seconds: 2)
        let key = "bili:BV1eeeeeeeee:p1"
        let (service, _) = try environment(Fixture(audio: audio))
        try await plantJob(service, id: "job-early", key: key, files: ["stream-0.m4a": audio])
        let (relaunched, _) = try environment(Fixture(audio: audio))
        await relaunched.resume() // start() より前に届いた通知：何も処理しない
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("download-jobs/job-early.json").path), "読み込み前に、ジョブを消さない")
        XCTAssertNil(relaunched.savedFile(key: key))
        await relaunched.start()
        let record = try await wait(relaunched, key: key, [.completed, .failed])
        XCTAssertEqual(record.state, .completed, record.message ?? "")
    }

    // MARK: ZIPに同梱された保存済みメディアの取り込み

    private func makeDownloadsZip(audio: Data, declaredBytes: Int? = nil, media: String = "downloads/media/abc.m4a") throws -> URL {
        let url = directory.appendingPathComponent("downloads-\(UUID().uuidString).zip")
        let writer = try ZipWriter(url: url)
        let catalog: [String: Any] = ["version": 1, "files": [["url": "https://www.bilibili.com/video/BV1aaaaaaaaa/", "kind": "audio", "media": media, "bytes": declaredBytes ?? audio.count, "duration": 2, "height": 0]]]
        try writer.add(name: "downloads/catalog.json", data: try JSONSerialization.data(withJSONObject: catalog))
        try writer.add(name: media, data: audio)
        try writer.finish()
        return url
    }

    func testDownloadedMediaInTheZipIsImportedForSongsInTheLibraryAndNotForOthers() async throws {
        let audio = try makeAudio(seconds: 2)
        let (service, _) = try environment(Fixture(audio: audio))
        await service.start()
        let url = try makeDownloadsZip(audio: audio)
        let zip = try ZipArchive(source: try FileSource(url: url))
        let records = try TransferService.readDownloads(zip)
        XCTAssertEqual(records.count, 1)
        // ライブラリにない曲の分は、取り込まない
        let none = await service.importDownloaded(from: url, records: records, entries: [])
        XCTAssertEqual(none.imported, 0)
        let result = await service.importDownloaded(from: url, records: records, entries: [entry])
        XCTAssertEqual(result.imported, 1)
        XCTAssertEqual(result.failed, 0)
        let key = try await requireKey(service)
        XCTAssertNotNil(service.savedFile(key: key), "取り込んだメディアが、保存済みとして扱われる")
        // すでに保存済みなら、重ねて取り込まない
        let again = await service.importDownloaded(from: url, records: records, entries: [entry])
        XCTAssertEqual(again.imported, 0)
        XCTAssertTrue(leftovers(service).isEmpty)
    }

    func testABrokenOrMismatchedDownloadsCatalogIsRefusedAndAnUnreadableMediaFileIsCountedAsFailed() async throws {
        let audio = try makeAudio(seconds: 2)
        let mismatch = try makeDownloadsZip(audio: audio, declaredBytes: audio.count + 1)
        XCTAssertThrowsError(try TransferService.readDownloads(try ZipArchive(source: try FileSource(url: mismatch))))
        let badName = try makeDownloadsZip(audio: audio, media: "downloads/media/evil.exe")
        XCTAssertThrowsError(try TransferService.readDownloads(try ZipArchive(source: try FileSource(url: badName))))
        // 再生できないデータ（音声ではない）は、取り込まずに失敗として数える
        let garbage = try makeDownloadsZip(audio: Data(repeating: 7, count: 4096))
        let (service, _) = try environment(Fixture(audio: audio))
        await service.start()
        let records = try TransferService.readDownloads(try ZipArchive(source: try FileSource(url: garbage)))
        let result = await service.importDownloaded(from: garbage, records: records, entries: [entry])
        XCTAssertEqual(result.imported, 0)
        XCTAssertEqual(result.failed, 1)
        let key = try await requireKey(service)
        XCTAssertNil(service.savedFile(key: key))
        XCTAssertTrue(leftovers(service).isEmpty)
    }

    func testTheCatalogKeepsAnInProgressRecordThatStillHasAJob() async throws {
        let media = directory.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
        let catalog = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: media)
        try await catalog.upsert(DeviceMediaRecord(key: "k1", kind: "audio", state: .downloading))
        try await catalog.upsert(DeviceMediaRecord(key: "k2", kind: "audio", state: .downloading))
        let reloaded = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: media)
        try await reloaded.load(keeping: ["k1|audio"])
        let kept = await reloaded.record(key: "k1", kind: "audio"), dropped = await reloaded.record(key: "k2", kind: "audio")
        XCTAssertEqual(kept?.state, .downloading)
        XCTAssertEqual(dropped?.state, .failed)
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

    // MARK: 保存タブの表示と更新（v0.7.1）

    func testClearingProblemsRemovesOnlyFailedAndCancelledRecords() async throws {
        let media = directory.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
        try Data([1]).write(to: media.appendingPathComponent("done.m4a"))
        let catalog = DownloadCatalog(url: directory.appendingPathComponent("downloads.json"), mediaDirectory: media)
        try await catalog.upsert(DeviceMediaRecord(key: "k1", kind: "audio", state: .failed))
        try await catalog.upsert(DeviceMediaRecord(key: "k2", kind: "video", state: .cancelled))
        try await catalog.upsert(DeviceMediaRecord(key: "k3", kind: "audio", state: .downloading))
        var done = DeviceMediaRecord(key: "k4", kind: "audio", state: .completed)
        done.fileName = "done.m4a"
        try await catalog.upsert(done)
        let removed = try await catalog.removeProblems()
        XCTAssertEqual(removed, 2)
        let failed = await catalog.record(key: "k1", kind: "audio"), cancelled = await catalog.record(key: "k2", kind: "video")
        let running = await catalog.record(key: "k3", kind: "audio"), saved = await catalog.record(key: "k4", kind: "audio")
        XCTAssertNil(failed)
        XCTAssertNil(cancelled)
        XCTAssertEqual(running?.state, .downloading)
        XCTAssertEqual(saved?.state, .completed)
        XCTAssertTrue(FileManager.default.fileExists(atPath: media.appendingPathComponent("done.m4a").path), "保存したファイルは消さない")
    }

    func testAFailureIsNotShownForASongWhoseOtherFormatIsSavedAndExpiresAfterAWhile() async throws {
        let audio = try makeAudio(seconds: 2)
        let (service, catalog) = try environment(Fixture(audio: audio))
        try FileManager.default.createDirectory(at: service.directory, withIntermediateDirectories: true)
        try Data([1]).write(to: service.directory.appendingPathComponent("a.m4a"))
        var failedVideo = DeviceMediaRecord(key: "only-failed", kind: "video", state: .failed)
        failedVideo.message = "結合に失敗しました"
        try await catalog.upsert(failedVideo)
        failedVideo.key = "audio-saved"
        try await catalog.upsert(failedVideo)
        var saved = DeviceMediaRecord(key: "audio-saved", kind: "audio", state: .completed)
        saved.fileName = "a.m4a"
        saved.bytes = 1
        try await catalog.upsert(saved)
        await service.start()
        XCTAssertEqual(service.problemStatus(key: "only-failed"), "保存に失敗")
        XCTAssertNil(service.problemStatus(key: "audio-saved"), "もう一方の形式が保存済みなら、失敗を出さない")
        let record = try XCTUnwrap(service.record(key: "only-failed", kind: "video"))
        XCTAssertTrue(service.isRecentProblem(record))
        XCTAssertFalse(service.isRecentProblem(record, now: Date().addingTimeInterval(DownloadService.problemLifetime + 60)), "一定時間を過ぎた失敗は出さない")
        XCTAssertEqual(service.savedBytes, 1)
    }

    func testReloadClearsFailuresButKeepsSavedMedia() async throws {
        let audio = try makeAudio(seconds: 2)
        let (service, catalog) = try environment(Fixture(audio: audio))
        try FileManager.default.createDirectory(at: service.directory, withIntermediateDirectories: true)
        try Data([1]).write(to: service.directory.appendingPathComponent("a.m4a"))
        try await catalog.upsert(DeviceMediaRecord(key: "k-failed", kind: "audio", state: .failed))
        var saved = DeviceMediaRecord(key: "k-saved", kind: "audio", state: .completed)
        saved.fileName = "a.m4a"
        try await catalog.upsert(saved)
        await service.start()
        XCTAssertNotNil(service.record(key: "k-failed", kind: "audio"))
        await service.reload()
        XCTAssertNil(service.record(key: "k-failed", kind: "audio"), "更新で、失敗の記録は消える")
        XCTAssertNotNil(service.savedFile(key: "k-saved"), "保存済みは消えない")
    }

    // MARK: 受信が止まった取得の検知（v0.7.1）

    private func stalledJob(urls: [String]) throws -> (BackgroundTransfers, DownloadJob) {
        let jobs = directory.appendingPathComponent("stall-jobs", isDirectory: true), staging = directory.appendingPathComponent("stall-staging", isDirectory: true)
        try FileManager.default.createDirectory(at: jobs, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let job = DownloadJob(id: "job-stalled", key: "bili:BV1sssssssss:p1", kind: "audio", title: "曲", quality: 0, duration: 2, layout: "dash", streams: [JobStream(urls: urls, size: 0, ext: "m4a")], createdAt: Date().timeIntervalSince1970)
        try JSONEncoder().encode(job).write(to: jobs.appendingPathComponent("job-stalled.json"))
        StubProtocol.install { _ in (404, Data()) }
        let transfers = BackgroundTransfers(configuration: StubProtocol.session().configuration, jobsDirectory: jobs, stagingRoot: staging)
        return (transfers, job)
    }

    func testAStalledTransferMovesToTheNextCandidateUrl() async throws {
        let (transfers, job) = try stalledJob(urls: ["https://upos.bilivideo.com/a/first", "https://upos.bilivideo.com/a/second"])
        let handled = await transfers.restartStalled(job.id, idleFor: 0)
        XCTAssertEqual(handled, 1)
        XCTAssertEqual(transfers.job(job.id)?.streams.first?.urlIndex, 1, "次の候補のURLで取り直す")
    }

    func testAStalledTransferWithNoCandidateLeftFailsWithADiagnosticAndNoUrl() async throws {
        let (transfers, job) = try stalledJob(urls: ["https://upos.bilivideo.com/a/only"])
        let handled = await transfers.restartStalled(job.id, idleFor: 0)
        XCTAssertEqual(handled, 1)
        guard case .failed(let text, let refused) = try XCTUnwrap(transfers.status(of: job).first) else { return XCTFail("失敗として残るはず") }
        XCTAssertFalse(refused)
        XCTAssertTrue(text.contains("取得が進みません") && text.contains("候補 1/1"), text)
        XCTAssertFalse(text.contains("http") || text.contains("bilivideo"), "診断の文にURLを含めない: \(text)")
    }

    func testATransferThatIsStillMovingIsNotRestarted() async throws {
        let (transfers, job) = try stalledJob(urls: ["https://upos.bilivideo.com/a/first", "https://upos.bilivideo.com/a/second"])
        let handled = await transfers.restartStalled(job.id, idleFor: 3600)
        XCTAssertEqual(handled, 0)
        XCTAssertEqual(transfers.job(job.id)?.streams.first?.urlIndex, 0)
    }

    // MARK: 画質の選択とオフライン用データの一括削除（v0.7.1）

    func testTheChosenHeightIsSentToThePlayUrlRequest() async throws {
        let audio = try makeAudio(seconds: 2)
        let (service, _) = try environment(Fixture(audio: audio))
        await service.start()
        let key = try await requireKey(service)
        service.save(entry: entry, kind: "audio", height: 360)
        _ = try await wait(service, key: key, [.completed, .failed])
        let play = StubProtocol.requests.first { $0.url?.path.hasSuffix("/playurl") == true }
        let query = URLComponents(url: try XCTUnwrap(play?.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first { $0.name == "qn" }?.value, "16", "360p は qn=16")
        XCTAssertTrue(DownloadService.heightChoices.contains(DownloadService.preferredHeight))
    }

    func testRemovingAllOfflineDataDeletesOnlyTheRecordedFilesAndKeepsTheRest() async throws {
        let audio = try makeAudio(seconds: 2)
        let (service, catalog) = try environment(Fixture(audio: audio))
        try FileManager.default.createDirectory(at: service.directory, withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: service.directory.appendingPathComponent("a.m4a"))
        try Data([4, 5]).write(to: service.directory.appendingPathComponent("b.mp4"))
        try Data([9]).write(to: service.directory.appendingPathComponent("not-managed.txt"))
        var first = DeviceMediaRecord(key: "k1", kind: "audio", state: .completed)
        first.fileName = "a.m4a"; first.bytes = 3
        var second = DeviceMediaRecord(key: "k1", kind: "video", state: .completed)
        second.fileName = "b.mp4"; second.bytes = 2
        try await catalog.upsert(first)
        try await catalog.upsert(second)
        try await catalog.upsert(DeviceMediaRecord(key: "k2", kind: "audio", state: .failed))
        await service.start()
        let result = await service.removeAllOffline()
        XCTAssertEqual(result?.count, 2)
        XCTAssertEqual(result?.bytes, 5)
        XCTAssertNil(service.savedFile(key: "k1", kind: "audio"))
        XCTAssertNil(service.savedFile(key: "k1", kind: "video"))
        XCTAssertNil(service.record(key: "k1", kind: "audio"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: service.directory.appendingPathComponent("a.m4a").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: service.directory.appendingPathComponent("b.mp4").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: service.directory.appendingPathComponent("not-managed.txt").path), "記録にないファイルは消さない")
        XCTAssertNotNil(service.record(key: "k2", kind: "audio"), "失敗の記録など、保存済み以外は触れない")
        XCTAssertEqual(service.savedBytes, 0)
    }
}
