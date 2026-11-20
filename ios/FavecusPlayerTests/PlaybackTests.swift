import AVFoundation
import XCTest
@testable import FavecusPlayer

/// 偽の再生の道具。曲の終わり・失敗を、テストから起こせる。
@MainActor
final class FakeBackend: PlayerBackend {
    var onEnded: (() -> Void)?
    var onFailed: ((String) -> Void)?
    var onTick: (() -> Void)?
    var position: Double = 0
    var duration: Double = 10
    var isPlaying = false
    var speed: Float = 1
    private(set) var loaded: [URL] = []
    private(set) var stopped = false

    func load(url: URL) { loaded.append(url); position = 0 }
    func play() { isPlaying = true }
    func pause() { isPlaying = false }
    func seek(to seconds: Double) { position = seconds }
    func stop() { isPlaying = false; stopped = true }
    func simulateEnd() { isPlaying = false; onEnded?() }
    func simulateFailure() { onFailed?("テスト用の失敗") }
}

/// 偽のメディア供給（Bilibiliの曲のファイルを用意する）。
@MainActor
final class FakeProvider: MediaProvider {
    var file: URL?
    var error: Error?
    private(set) var requested: [String] = []
    var delayed: Set<String> = []
    /// 保存済みの動画（曲名 → ファイル）。ない曲は nil。
    var videos: [String: URL] = [:]

    func playableFile(for entry: EntryItem) async throws -> URL {
        requested.append(entry.title)
        if delayed.contains(entry.title) { try await Task.sleep(nanoseconds: 400_000_000) }
        if let error { throw error }
        return try XCTUnwrap(file)
    }

    func savedVideoFile(for entry: EntryItem) async -> URL? { videos[entry.title] }
}

/// 再生順は共通JS（Windows版と同じQueue）、再生の道具は偽物で確認する。実機のロック画面・割り込み・イヤホンの動作は、実機での確認項目。
@MainActor
final class PlaybackTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("favecus-playback-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func fixture(_ name: String) throws -> URL {
        let folder = try XCTUnwrap(ProcessInfo.processInfo.environment["FAVECUS_TRANSFER_DIR"], "FAVECUS_TRANSFER_DIR が渡されていません（CIの設定を確認）")
        let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "\(name) がありません")
        return url
    }

    /// Windows版のZIP（ローカル曲2つ・Bilibili曲2つ）を取り込んだライブラリと、偽の再生の道具つきのエンジン。
    private func prepare() async throws -> (LibraryStore, PlaybackEngine, FakeBackend) {
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let store = LibraryStore(core: core, directory: directory)
        await store.load()
        let importer = ImportCoordinator(service: TransferService(core: core), store: store)
        importer.begin(url: try fixture("windows-media.zip"))
        try await waitFor { if case .choosing = importer.phase { return true }; return false }
        guard case .choosing(let plan) = importer.phase else { throw TransferError.message("取り込み候補を読めません") }
        await importer.commit(ids: plan.lists.map(\.id))
        guard case .done = importer.phase else { throw TransferError.message("取り込めません: \(importer.phase)") }
        let backend = FakeBackend()
        return (store, PlaybackEngine(core: core, store: store, backend: backend), backend)
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(20)
        while Date() < end {
            if condition() { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTFail("条件が満たされませんでした")
    }

    private func entry(_ store: LibraryStore, _ title: String) throws -> EntryItem {
        try XCTUnwrap(store.document?.playlists.flatMap(\.entries).first { $0.title == title }, title)
    }

    private func parentId(_ store: LibraryStore) throws -> String {
        try XCTUnwrap(store.document?.playlists.first { $0.name == "親" }?.id)
    }

    func testPlayingALocalEntryLoadsItsFile() async throws {
        let (store, engine, backend) = try await prepare()
        let a = try entry(store, "ローカルA")
        XCTAssertTrue(engine.canPlay(a))
        await engine.play(entryId: a.id, scope: try parentId(store))
        XCTAssertEqual(engine.current?.title, "ローカルA")
        XCTAssertEqual(backend.loaded.last?.lastPathComponent, a.fileName)
        XCTAssertTrue(backend.isPlaying)
        XCTAssertTrue(engine.isPlaying)
    }

    func testAnEntryWithoutMediaCannotBePlayedAndExplainsWhy() async throws {
        let (store, engine, backend) = try await prepare()
        let online = try entry(store, "曲1")
        XCTAssertFalse(engine.canPlay(online))
        await engine.play(entryId: online.id, scope: try parentId(store))
        XCTAssertNotNil(engine.message)
        XCTAssertTrue(backend.loaded.isEmpty)
        XCTAssertNil(engine.current)
    }

    func testNextSkipsEntriesThatCannotBePlayedAndTheEndStops() async throws {
        let (store, engine, backend) = try await prepare()
        let scope = try parentId(store)
        await engine.play(entryId: try entry(store, "ローカルA").id, scope: scope)
        await engine.goNext() // 親の次は子のローカルB（Bilibiliの曲は飛ばす）
        XCTAssertEqual(engine.current?.title, "ローカルB")
        backend.simulateEnd() // 最後まで来た（リピートなし）→ 止まる
        try await waitFor { !engine.isPlaying }
        XCTAssertEqual(engine.current?.title, "ローカルB")
        XCTAssertEqual(backend.loaded.count, 2)
    }

    func testRepeatAllWrapsAndRepeatOneReplaysTheSameEntry() async throws {
        let (store, engine, backend) = try await prepare()
        let scope = try parentId(store)
        engine.repeatMode = .all
        await engine.play(entryId: try entry(store, "ローカルB").id, scope: scope)
        backend.simulateEnd()
        try await waitFor { engine.current?.title == "ローカルA" }
        engine.repeatMode = .one
        let count = backend.loaded.count
        backend.simulateEnd()
        try await waitFor { backend.loaded.count == count + 1 }
        XCTAssertEqual(engine.current?.title, "ローカルA")
    }

    func testAFailingEntryIsSkippedAndEndlessFailureStops() async throws {
        let (store, engine, backend) = try await prepare()
        engine.repeatMode = .all
        await engine.play(entryId: try entry(store, "ローカルA").id, scope: try parentId(store))
        backend.simulateFailure()
        try await waitFor { engine.current?.title == "ローカルB" }
        XCTAssertNotNil(engine.message)
        for _ in 0..<10 { backend.simulateFailure() } // 全部失敗しても、無限に回らず止まる
        try await waitFor { backend.stopped }
        XCTAssertTrue(engine.message?.contains("再生できる曲がありません") ?? false, engine.message ?? "")
    }

    func testDeletingTheCurrentEntryStopsPlayback() async throws {
        let (store, engine, backend) = try await prepare()
        let scope = try parentId(store)
        let a = try entry(store, "ローカルA")
        await engine.play(entryId: a.id, scope: scope)
        store.perform(["type": "remove", "playlistId": scope, "entryId": a.id])
        await store.waitUntilIdle()
        try await waitFor { engine.current == nil }
        XCTAssertTrue(backend.stopped)
    }

    func testAFailedStartKeepsTheCurrentPlayback() async throws {
        let (store, engine, backend) = try await prepare()
        let scope = try parentId(store)
        await engine.play(entryId: try entry(store, "ローカルA").id, scope: scope)
        await engine.play(entryId: try entry(store, "曲1").id, scope: scope) // Bilibiliの曲：再生できない
        XCTAssertNotNil(engine.message)
        XCTAssertEqual(engine.current?.title, "ローカルA")
        await engine.goNext()
        XCTAssertEqual(engine.current?.title, "ローカルB", "再生範囲・再生順は変わらない")
        XCTAssertEqual(backend.loaded.count, 2)
    }

    func testPreviousGoesBackToTheStartOfTheCurrentEntryAfterAFewSeconds() async throws {
        let (store, engine, backend) = try await prepare()
        let scope = try parentId(store)
        await engine.play(entryId: try entry(store, "ローカルA").id, scope: scope)
        await engine.goNext()
        backend.position = 5
        engine.seek(to: 5)
        await engine.goPrevious()
        XCTAssertEqual(engine.current?.title, "ローカルB")
        XCTAssertEqual(backend.position, 0)
        await engine.goPrevious()
        XCTAssertEqual(engine.current?.title, "ローカルA")
    }

    func testShufflePlaysEveryPlayableEntryOncePerCycle() async throws {
        let (store, engine, backend) = try await prepare()
        engine.shuffle = true
        engine.repeatMode = .off
        await engine.play(entryId: try entry(store, "ローカルA").id, scope: try parentId(store))
        backend.simulateEnd()
        try await waitFor { engine.current?.title == "ローカルB" }
        let count = backend.loaded.count
        backend.simulateEnd()
        try await waitFor { !engine.isPlaying }
        XCTAssertEqual(backend.loaded.count, count, "1周したら止まる")
    }

    private func prepareWithProvider(_ provider: FakeProvider) async throws -> (LibraryStore, PlaybackEngine, FakeBackend) {
        let (store, _, backend) = try await prepare()
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let local = try XCTUnwrap(try entry(store, "ローカルA").fileName)
        provider.file = store.mediaDirectory.appendingPathComponent(local)
        return (store, PlaybackEngine(core: core, store: store, backend: backend, provider: provider), backend)
    }

    func testAnOnlineEntryIsFetchedThroughTheProviderAndPlayed() async throws {
        let provider = FakeProvider()
        let (store, engine, backend) = try await prepareWithProvider(provider)
        let online = try entry(store, "曲1")
        XCTAssertTrue(engine.canPlay(online))
        await engine.play(entryId: online.id, scope: try parentId(store))
        XCTAssertEqual(provider.requested, ["曲1"])
        XCTAssertEqual(engine.current?.title, "曲1")
        XCTAssertFalse(engine.isPreparing)
        XCTAssertEqual(backend.loaded.last, provider.file)
        XCTAssertTrue(backend.isPlaying)
    }

    /// 動画で見ていると、次の曲も（動画があれば）動画で映す。動画のない曲では、サムネイルのままで、選択は覚えておく。
    func testTheVideoChoiceCarriesOverToTheNextSongsThatHaveAVideo() async throws {
        let provider = FakeProvider()
        let (store, engine, backend) = try await prepareWithProvider(provider)
        engine.isActive = { true }
        let withVideo = try entry(store, "曲1"), withoutVideo = try entry(store, "曲4")
        provider.videos["曲1"] = try XCTUnwrap(provider.file)
        let scope = try parentId(store)
        await engine.play(entryId: withVideo.id, scope: scope)
        try await waitFor { engine.videoAvailable }
        engine.setVideoMode(true)
        XCTAssertTrue(engine.videoMode)
        XCTAssertTrue(engine.prefersVideo)
        // 動画のない曲：サムネイルのまま。選択は残る
        await engine.play(entryId: withoutVideo.id, scope: scope)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(engine.videoMode)
        XCTAssertFalse(engine.videoAvailable)
        XCTAssertTrue(engine.prefersVideo)
        // 動画のある曲へ戻ると、続けて動画で映す
        await engine.play(entryId: withVideo.id, scope: scope)
        try await waitFor { engine.videoMode }
        XCTAssertTrue(backend.isPlaying)
        // サムネイルを選ぶと、選択は解除される
        engine.setVideoMode(false)
        XCTAssertFalse(engine.prefersVideo)
        await engine.play(entryId: withoutVideo.id, scope: scope)
        await engine.play(entryId: withVideo.id, scope: scope)
        try await waitFor { engine.videoAvailable }
        XCTAssertFalse(engine.videoMode, "サムネイルを選んだあとは、動画へ切り替えない")
    }

    /// 曲の所在は、ホームの最上位のリストから、再生中の曲があるリストまで（共通JSの規則）。
    func testTheLocationRunsFromATopLevelListToTheListOfTheCurrentSong() async throws {
        let provider = FakeProvider()
        let (store, engine, _) = try await prepareWithProvider(provider)
        let online = try entry(store, "曲1")
        await engine.play(entryId: online.id, scope: try parentId(store))
        let path = await engine.location()
        let first = try XCTUnwrap(path.first), last = try XCTUnwrap(path.last)
        XCTAssertTrue(store.document?.rootPlaylistIds.contains(first.id) == true, "最初は最上位のリスト")
        XCTAssertEqual(last.id, engine.current?.playlistId, "最後は、再生中の曲があるリスト")
        XCTAssertTrue(path.allSatisfy { !$0.name.isEmpty })
    }

    /// 背面では動画へ切り替えず、前面へ戻ったときに切り替える。
    func testTheVideoChoiceIsAppliedOnlyWhileTheAppIsActive() async throws {
        let provider = FakeProvider()
        let (store, engine, _) = try await prepareWithProvider(provider)
        var active = true
        engine.isActive = { active }
        let withVideo = try entry(store, "曲1")
        provider.videos["曲1"] = try XCTUnwrap(provider.file)
        let scope = try parentId(store)
        await engine.play(entryId: withVideo.id, scope: scope)
        try await waitFor { engine.videoAvailable }
        engine.setVideoMode(true)
        active = false
        await engine.play(entryId: withVideo.id, scope: scope)
        try await waitFor { engine.videoAvailable }
        XCTAssertFalse(engine.videoMode, "背面では動画へ切り替えない")
        active = true
        engine.applyPreferredVideo()
        XCTAssertTrue(engine.videoMode, "前面へ戻ったら切り替える")
    }

    func testAnOnlineFailureSkipsToTheNextEntryButARateLimitStopsEverything() async throws {
        let provider = FakeProvider()
        let (store, engine, backend) = try await prepareWithProvider(provider)
        let scope = try parentId(store)
        provider.error = DownloadError.message("配信先の応答を確認できません。")
        await engine.play(entryId: try entry(store, "曲1").id, scope: scope)
        try await waitFor { engine.current?.title == "ローカルA" } // 取得できない曲は飛ばして、次（保存済みのローカル曲）へ
        XCTAssertNotNil(engine.message)
        XCTAssertTrue(backend.isPlaying)
        // 続けても同じ結果になる失敗（混雑・リスク制御・ログイン要）は、次へ進まず止めて知らせる
        provider.error = BilibiliError.failed("Bilibiliから情報を取得できません（HTTP 412）。", stopBatch: true)
        engine.message = nil
        await engine.play(entryId: try entry(store, "曲4").id, scope: scope)
        try await waitFor { engine.current == nil }
        XCTAssertTrue(engine.message?.contains("412") ?? false, engine.message ?? "")
        XCTAssertTrue(backend.stopped)
    }

    func testARefusedOrOfflineFetchStopsInsteadOfTryingTheNextEntries() async throws {
        let provider = FakeProvider()
        let (store, engine, backend) = try await prepareWithProvider(provider)
        let scope = try parentId(store)
        provider.error = DownloadError.refused("配信先から取得できません（HTTP 403）。")
        await engine.play(entryId: try entry(store, "曲1").id, scope: scope)
        try await waitFor { engine.current == nil }
        XCTAssertEqual(provider.requested, ["曲1"], "次の曲を続けて要求しない")
        XCTAssertTrue(backend.stopped)
        provider.error = URLError(.notConnectedToInternet)
        engine.message = nil
        await engine.play(entryId: try entry(store, "曲4").id, scope: scope)
        try await waitFor { engine.current == nil }
        XCTAssertEqual(provider.requested, ["曲1", "曲4"])
        XCTAssertNotNil(engine.message)
    }

    func testChoosingAnotherEntryWhileOneIsBeingFetchedDropsTheOldResult() async throws {
        let provider = FakeProvider()
        let (store, engine, backend) = try await prepareWithProvider(provider)
        let scope = try parentId(store)
        provider.delayed = ["曲1"]
        let slow = Task { await engine.play(entryId: try! entry(store, "曲1").id, scope: scope) }
        try await waitFor { provider.requested.contains("曲1") }
        await engine.play(entryId: try entry(store, "ローカルB").id, scope: scope)
        await slow.value
        XCTAssertEqual(engine.current?.title, "ローカルB", "あとから選んだ曲が優先される")
        XCTAssertTrue(backend.isPlaying)
    }

    /// 本物のAVPlayerで、実際のファイルを読み込めること（CIのシミュレーターには音声の出力装置がないため、時間の進み方は確認しない）。
    func testTheRealPlayerLoadsALocalAudioFile() async throws {
        let (store, _, _) = try await prepare()
        let a = try entry(store, "ローカルA")
        let url = store.mediaDirectory.appendingPathComponent(try XCTUnwrap(a.fileName))
        let backend = AVPlayerBackend()
        backend.load(url: url)
        try await waitFor { backend.duration > 0.5 }
        XCTAssertEqual(backend.duration, 1.0, accuracy: 0.2)
        backend.stop()
    }
    // MARK: 前回の続きから再生（v0.7.3 F2）

    private func resumeStore() -> ResumeStore {
        ResumeStore(defaults: UserDefaults(suiteName: "favecus-resume-test-\(UUID().uuidString)")!)
    }

    func testPlayingSavesWhereYouLeftOffAndARestartShowsItPausedWithoutPlaying() async throws {
        let (store, engine, backend) = try await prepare()
        let saved = resumeStore()
        engine.resumeStore = saved
        let a = try entry(store, "ローカルA")
        let scope = try parentId(store)
        await engine.play(entryId: a.id, scope: scope)
        backend.duration = 200 // 終わりの5秒以内では、頭から再生するため、長い曲にする
        backend.position = 7
        backend.onTick?()
        engine.pause()
        XCTAssertEqual(saved.get()?.entryId, a.id)
        XCTAssertEqual(saved.get()?.position, 7)
        // 再起動：新しいエンジンで、前回の曲を表示するだけ（鳴らさない・読み込まない）
        let core = try SharedCore(bundle: Bundle(for: SharedCore.self))
        let backend2 = FakeBackend()
        let restarted = PlaybackEngine(core: core, store: store, backend: backend2)
        restarted.resumeStore = saved
        restarted.restoreLast()
        XCTAssertEqual(restarted.current?.title, "ローカルA")
        XCTAssertFalse(restarted.isPlaying)
        XCTAssertTrue(restarted.restoredPending)
        XCTAssertEqual(restarted.position, 7)
        XCTAssertTrue(backend2.loaded.isEmpty)
        XCTAssertFalse(backend2.isPlaying)
    }

    func testPressingPlayAfterARestoreStartsFromTheSavedPosition() async throws {
        let (store, engine, backend) = try await prepare()
        let saved = resumeStore()
        let a = try entry(store, "ローカルA")
        saved.observe(ResumeRecord(entryId: a.id, playlistId: try parentId(store), scope: try parentId(store), position: 42, duration: 200), paused: true)
        saved.flush()
        engine.resumeStore = saved
        engine.restoreLast()
        XCTAssertTrue(engine.restoredPending)
        engine.resume()
        try await waitFor { backend.isPlaying }
        XCTAssertEqual(backend.loaded.last?.lastPathComponent, a.fileName)
        XCTAssertEqual(backend.position, 42)
        XCTAssertFalse(engine.restoredPending)
    }

    func testNextAfterARestorePlaysTheFollowingSongNotTheRestoredOne() async throws {
        let (store, engine, backend) = try await prepare()
        let saved = resumeStore()
        let a = try entry(store, "ローカルA")
        saved.observe(ResumeRecord(entryId: a.id, playlistId: try parentId(store), scope: try parentId(store), position: 30, duration: 200), paused: true)
        saved.flush()
        engine.resumeStore = saved
        engine.restoreLast()
        await engine.goNext()
        XCTAssertNotNil(engine.current)
        XCTAssertNotEqual(engine.current?.entryId, a.id)
        XCTAssertFalse(engine.restoredPending)
        XCTAssertTrue(backend.isPlaying)
    }

    func testNothingIsRestoredWhenTheSavedSongIsGone() async throws {
        let (store, engine, _) = try await prepare()
        let saved = resumeStore()
        saved.observe(ResumeRecord(entryId: "no-such-entry", playlistId: try parentId(store), scope: "*", position: 30, duration: 200), paused: true)
        saved.flush()
        engine.resumeStore = saved
        engine.restoreLast()
        XCTAssertNil(engine.current)
        XCTAssertFalse(engine.restoredPending)
    }
    // MARK: 自動リスト（v0.7.3 F3）

    func testAutoListsAreChosenByTheSharedRule() async throws {
        let (store, engine, _) = try await prepare()
        let picked = await engine.autoLists()
        let lists = try XCTUnwrap(picked)
        let total = Set((store.document?.playlists ?? []).flatMap { $0.entries }.map { $0.id }).count
        XCTAssertTrue(lists.frequent.isEmpty, "再生回数が0なら、よく聴く曲は空")
        XCTAssertEqual(lists.unplayed.count, min(total, 200))
        XCTAssertEqual(lists.recent.count, min(total, 50))
    }

    func testPlayingAnAutoListFollowsTheListOrderAndKeepsItWhileMoving() async throws {
        let (store, engine, backend) = try await prepare()
        let a = try entry(store, "ローカルA"), b = try entry(store, "ローカルB")
        await engine.play(entryId: b.id, scope: "auto:recent", entryIds: [b.id, a.id])
        XCTAssertEqual(engine.current?.title, "ローカルB")
        XCTAssertTrue(backend.isPlaying)
        await engine.goNext()
        XCTAssertEqual(engine.current?.title, "ローカルA", "一覧の順（B→A）に進む")
    }
}
