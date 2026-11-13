import Combine
import Foundation

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

    init(core: SharedCore, store: LibraryStore, backend: PlayerBackend, makeSystem: ((PlaybackControls) -> SystemAudioHooks)? = nil) {
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

    /// この端末で再生できる曲（実体のあるローカル曲）。
    func canPlay(_ entry: EntryItem) -> Bool {
        entry.type == "local" && entry.fileName.map { store.mediaFiles.contains($0) } == true
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
        load(id: id, playlistId: playlistId)
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
            message = "再生順を決められません：\(error)"
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
        load(id: id, playlistId: playlistId)
    }

    /// ライブラリが変わったとき、再生中の曲が再生範囲に残っているかを確かめる（なくなったら止める）。
    private func resync() async {
        guard let sync = syncRequest() else { return }
        let mine = generation
        let result = await queue("QueueSync", sync)
        guard mine == generation, result?.stopped == true else { return }
        stop()
    }

    private func load(id: String, playlistId: String) {
        guard let target = entry(id), let fileName = target.fileName else { return }
        system?.activate()
        generation += 1
        current = NowPlaying(entryId: id, playlistId: playlistId, title: target.title.isEmpty ? "（無題）" : target.title)
        backend.load(url: store.mediaDirectory.appendingPathComponent(fileName))
        backend.play()
        refresh()
    }

    private func ended() {
        guard current != nil else { return }
        failureStreak = 0
        Task { await advance(direction: 1, automatic: true) }
    }

    /// 読み込み・再生に失敗した曲は飛ばす。続けて失敗したら（再生できる曲がない）、無限に回らず止める。
    private func failed(_ reason: String) {
        guard current != nil else { return } // 止めたあとに届いた古い失敗は無視する
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

    private func refresh() {
        isPlaying = backend.isPlaying
        position = backend.position
        duration = backend.duration
        system?.update(title: current?.title, position: position, duration: duration, playing: isPlaying)
    }
}
