import AVFoundation
import Combine
import Foundation

/// 再生に使う音声ファイルを用意する（Bilibiliの曲：保存済みならそのファイル、なければ一時ファイルへ取得）。失敗は理由つきで投げる（回避しない）。
@MainActor
protocol MediaProvider: AnyObject {
    func playableFile(for entry: EntryItem) async throws -> URL
    /// 保存済みの動画ファイル（なければnil）。再生画面の「動画」表示に使う。
    func savedVideoFile(for entry: EntryItem) async -> URL?
}

extension MediaProvider {
    func savedVideoFile(for entry: EntryItem) async -> URL? { nil }
}

/// iPhone版のローカル再生（音声）。次に何を再生するかは共通JS（FavecusCore.QueueStart / QueueMove。Windows版と同じQueue）が決め、
/// ここは「再生できる曲を集める」「選ばれた曲を道具（PlayerBackend）で鳴らす」「OSへ状態を伝える」だけ。
/// 再生できる曲＝この端末にメディアの実体があるローカル曲。それ以外（Bilibiliのオンライン・実体のない曲）は順番に入れず、選ぶとお知らせを出す。
@MainActor
final class PlaybackEngine: ObservableObject, PlaybackControls {
    enum RepeatMode: String, CaseIterable {
        case off
        case all
        case one
    }

    struct NowPlaying: Equatable {
        let entryId: String
        let playlistId: String
        let title: String
    }

    @Published private(set) var current: NowPlaying?
    @Published private(set) var isPlaying = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    /// Bilibiliの曲のファイルを用意している間（取得中）。
    @Published private(set) var isPreparing = false
    /// 再生中の曲に、動画として映せるファイルがある（保存済みのBilibili動画、映像のあるローカルファイル）。
    @Published private(set) var videoAvailable = false
    /// 再生画面で、サムネイルではなく動画を映している。
    @Published private(set) var videoMode = false
    @Published var shuffle = false
    @Published var repeatMode: RepeatMode = .off
    @Published var message: String?

    private let core: SharedCore
    private let store: LibraryStore
    private let backend: PlayerBackend
    private var system: SystemAudioHooks?
    private var scope: String?
    private var failureStreak = 0
    /// 曲の切り替え・停止のたびに増やす。待っている間に状態が変わった古い処理の結果を捨てるため。
    private var generation = 0
    private var libraryObserver: AnyCancellable?
    private let provider: MediaProvider?
    private var audioFile: URL?
    private var videoFile: URL?
    private var loadedFile: URL?
    /// 動画を映すプレイヤー（画面の映像用）。
    var videoPlayer: AVPlayer? { backend.videoPlayer }

    init(core: SharedCore, store: LibraryStore, backend: PlayerBackend, provider: MediaProvider? = nil, makeSystem: ((PlaybackControls) -> SystemAudioHooks)? = nil) {
        self.provider = provider
        self.core = core
        self.store = store
        self.backend = backend
        system = makeSystem?(self)
        backend.onEnded = { [weak self] in self?.ended() }
        backend.onFailed = { [weak self] reason in self?.failed(reason) }
        backend.onTick = { [weak self] in self?.tick() }
        // ライブラリの編集・削除・同期の反映で、再生中の曲がなくなったら止める（Windows版と同じ規則を共通JSで判断）。
        libraryObserver = store.$document.dropFirst().sink { [weak self] _ in
            Task { @MainActor in await self?.resync() }
        }
    }

    var isPlayingNow: Bool { isPlaying }

    // MARK: 再生できる曲

    /// 再生できる曲：実体のあるローカル曲、または、Bilibiliの曲（保存済み、またはオンラインで取得して再生。取得できないときは、理由を知らせて次へ進む）。
    func canPlay(_ entry: EntryItem) -> Bool {
        if entry.type == "local" { return entry.fileName.map { store.mediaFiles.contains($0) } == true }
        return entry.type == "bilibili" && entry.url != nil && provider != nil
    }

    private func playableIds() -> [String] {
        (store.document?.playlists ?? []).flatMap(\.entries).filter(canPlay).map(\.id)
    }

    private func entry(_ id: String) -> EntryItem? {
        store.document?.playlists.lazy.flatMap(\.entries).first { $0.id == id }
    }

    // MARK: 操作

    /// scope：再生範囲のリストID（そのリストと子のリスト）、または "*"（すべて）。
    func play(entryId: String, scope: String) async {
        guard let target = entry(entryId), canPlay(target) else {
            message = "この曲はこの端末で再生できません（メディアがありません）。"
            return
        }
        failureStreak = 0
        generation += 1
        let mine = generation
        guard let result = await queue("QueueStart", ["text": store.currentText, "scope": scope, "entryId": entryId, "shuffle": shuffle, "playable": playableIds()]),
              let id = result.id, let playlistId = result.playlistId else {
            if mine == generation { message = "この曲を再生キューに入れられません。" } // 失敗しても、再生中の曲・再生範囲は変えない
            return
        }
        guard mine == generation else { return } // 待っている間に、別の曲を選ばれた・止められた
        self.scope = scope
        await load(id: id, playlistId: playlistId)
    }

    func next() { Task { await goNext() } }

    func previous() { Task { await goPrevious() } }

    func goNext() async { await advance(direction: 1, automatic: false) }

    func goPrevious() async {
        // 再生位置が数秒進んでいれば、前の曲ではなく、この曲の頭へ戻る（一般的なプレイヤーの動作）。
        if position > 3 { seek(to: 0); return }
        await advance(direction: -1, automatic: false)
    }

    func resume() {
        guard current != nil else { return }
        backend.play()
        refresh()
    }

    func pause() {
        backend.pause()
        refresh()
    }

    func toggle() {
        if isPlaying { pause() } else { resume() }
    }

    func seek(to seconds: Double) {
        backend.seek(to: seconds)
        position = seconds
        refresh()
    }

    func stop() {
        generation += 1
        isPreparing = false
        videoMode = false
        videoAvailable = false
        backend.stop()
        current = nil
        scope = nil
        refresh()
    }

    // MARK: 内部

    private struct QueueResult: Decodable {
        var id: String?
        var playlistId: String?
        var error: String?
        var stopped: Bool?
    }

    private func queue(_ function: String, _ request: [String: Any]) async -> QueueResult? {
        do {
            let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
            let result = try JSONDecoder().decode(QueueResult.self, from: Data(try await core.callAsync(function, text).utf8))
            if let error = result.error { message = error; return nil }
            return result
        } catch {
            message = "再生順を決められません：\(ErrorText.safe(error))"
            return nil
        }
    }

    /// 前後の曲へ。automatic：曲の終わりでの自動送り（1曲リピートではそのまま繰り返す）。
    private func syncRequest() -> [String: Any]? {
        guard let scope, let current else { return nil }
        return ["text": store.currentText, "scope": scope, "entryId": current.entryId, "ownScope": current.playlistId, "shuffle": shuffle, "playable": playableIds()]
    }

    private func advance(direction: Int, automatic: Bool) async {
        guard let sync = syncRequest() else { return }
        generation += 1
        let mine = generation
        let request: [String: Any] = ["direction": direction, "repeat": repeatMode.rawValue, "automatic": automatic, "sync": sync]
        let result = await queue("QueueMove", request)
        guard mine == generation else { return } // 待っている間に、別の曲を選ばれた・止められた・次の曲へ進んだ
        if result?.stopped == true { stop(); return } // 現在の曲がライブラリからなくなった（Windows版と同じく止める）
        guard let result, let id = result.id, let playlistId = result.playlistId else {
            // 最後まで再生した（リピートなし）／前がない：止める。曲の表示は残す。
            backend.pause()
            refresh()
            return
        }
        await load(id: id, playlistId: playlistId)
    }

    /// ライブラリが変わったとき、再生中の曲が再生範囲に残っているかを確かめる（なくなったら止める）。
    private func resync() async {
        guard let sync = syncRequest() else { return }
        let mine = generation
        let result = await queue("QueueSync", sync)
        guard mine == generation, result?.stopped == true else { return }
        stop()
    }

    private func load(id: String, playlistId: String) async {
        guard let target = entry(id) else { return }
        system?.activate()
        generation += 1
        let mine = generation
        // 次の曲の準備中に、前の曲のファイルで動画に切り替えないよう、前の曲の動画の情報を消しておく
        videoMode = false
        videoAvailable = false
        audioFile = nil
        videoFile = nil
        loadedFile = nil
        current = NowPlaying(entryId: id, playlistId: playlistId, title: target.title.isEmpty ? "（無題）" : target.title)
        let file: URL
        if target.type == "local" {
            guard let fileName = target.fileName else { return }
            isPreparing = false
            file = store.mediaDirectory.appendingPathComponent(fileName)
        } else {
            guard let provider else { return }
            backend.pause()
            isPreparing = true
            refresh()
            do { file = try await provider.playableFile(for: target) }
            catch {
                guard mine == generation else { return }
                isPreparing = false
                onlineFailed(error)
                return
            }
            guard mine == generation else { return } // 取得している間に、別の曲を選ばれた・止められた
            isPreparing = false
        }
        backend.load(url: file)
        backend.play()
        audioFile = file
        loadedFile = file
        videoFile = nil
        videoMode = false
        videoAvailable = false
        refresh()
        Task { await updateVideoAvailability(for: target, file: file, generation: mine) }
    }

    private func updateVideoAvailability(for target: EntryItem, file: URL, generation mine: Int) async {
        var found: URL?
        if target.type == "local" {
            let tracks = (try? await AVURLAsset(url: file).loadTracks(withMediaType: .video)) ?? []
            if !tracks.isEmpty { found = file }
        } else {
            found = await provider?.savedVideoFile(for: target)
        }
        guard mine == generation else { return }
        videoFile = found
        videoAvailable = found != nil
    }

    /// サムネイルと動画を切り替える（同じ位置から続ける）。動画がないときは何もしない。
    func setVideoMode(_ on: Bool) {
        guard current != nil, on != videoMode else { return }
        guard let target = on ? videoFile : audioFile else { return }
        let position = backend.position, playing = backend.isPlaying
        videoMode = on
        if loadedFile != target {
            backend.load(url: target)
            backend.seek(to: position)
            loadedFile = target
        }
        if playing { backend.play() }
        refresh()
    }

    /// ログイン要・リスク制御・混雑のような、続けても同じ結果になる失敗は、止めて知らせる。それ以外は、その曲を飛ばす。
    private func onlineFailed(_ error: Error) {
        if let known = error as? BilibiliError, known.stopBatch {
            message = known.description
            stop()
            return
        }
        // 配信先の拒否・通信できない状態も、続けて他の曲を要求せずに止める（曲数ぶんの要求を連続して送らない）。
        if (error as? DownloadError)?.isRefusal == true || error is URLError {
            message = ErrorText.safe(error)
            stop()
            return
        }
        failed(ErrorText.safe(error))
    }

    private func ended() {
        guard current != nil else { return }
        failureStreak = 0
        Task { await advance(direction: 1, automatic: true) }
    }

    /// 読み込み・再生に失敗した曲は飛ばす。続けて失敗したら（再生できる曲がない）、無限に回らず止める。
    private func failed(_ reason: String) {
        guard current != nil else { return } // 止めたあとに届いた古い失敗は無視する
        // 動画を映しているときの失敗は、次の曲へ送らず、音声に戻す
        if videoMode, let audio = audioFile {
            let resume = position
            videoMode = false
            videoAvailable = false
            videoFile = nil
            backend.load(url: audio)
            loadedFile = audio
            backend.seek(to: resume)
            backend.play()
            message = "動画を再生できませんでした。音声に戻しました。"
            refresh()
            return
        }
        failureStreak += 1
        guard failureStreak <= max(3, playableIds().count) else {
            message = "再生できる曲がありません：\(reason)"
            failureStreak = 0
            stop()
            return
        }
        message = "再生できない曲を飛ばしました：\(reason)"
        // 1曲リピートでも、壊れた曲を繰り返さず次へ進む（automaticにしない）。
        Task { await advance(direction: 1, automatic: false) }
    }

    private func tick() {
        refresh()
        if isPlaying && position > 0.5 { failureStreak = 0 } // 実際に再生できたら、失敗の連続を数え直す
    }

    /// 画面確認用（シミュレーターのスクリーンショット）：再生中の表示だけを作る。音は鳴らさず、通常の起動では使わない。
    func showDemo(title: String, position: Double, duration: Double) {
        current = NowPlaying(entryId: "demo", playlistId: "demo", title: title)
        isPlaying = true
        self.position = position
        self.duration = duration
    }

    private func refresh() {
        isPlaying = backend.isPlaying
        position = backend.position
        duration = backend.duration
        system?.update(title: current?.title, position: position, duration: duration, playing: isPlaying)
    }
}
