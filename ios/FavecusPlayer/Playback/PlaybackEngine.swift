import AVFoundation
import Combine
import Foundation
import UIKit

/// 再生に使う音声ファイルを用意する（Bilibiliの曲：保存済みならそのファイル、なければ一時ファイルへ取得）。失敗は理由つきで投げる（回避しない）。
@MainActor
protocol MediaProvider: AnyObject {
    func playableFile(for entry: EntryItem) async throws -> URL
    /// 保存済みの動画ファイル（なければnil）。再生画面の「動画」表示に使う。
    func savedVideoFile(for entry: EntryItem) async -> URL?
    /// 曲の同期用メディアキー（Bilibiliの曲。再生回数の台帳のキー）。求められない曲はnil。
    func syncKeys(for entries: [EntryItem]) async -> [String?]
    /// この端末に保存済みか（Bilibiliの曲の音声・動画）。並べ替え・絞り込みの「保存」に使う。
    func isSaved(_ entry: EntryItem) -> Bool
}

extension MediaProvider {
    func savedVideoFile(for entry: EntryItem) async -> URL? { nil }
    func syncKeys(for entries: [EntryItem]) async -> [String?] { entries.map { _ in nil } }
    func isSaved(_ entry: EntryItem) -> Bool { false }
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

    @Published var current: NowPlaying?
    @Published private(set) var isPlaying = false
    @Published var position: Double = 0
    @Published private(set) var duration: Double = 0
    /// Bilibiliの曲のファイルを用意している間（取得中）。
    @Published private(set) var isPreparing = false
    /// 再生中の曲に、動画として映せるファイルがある（保存済みのBilibili動画、映像のあるローカルファイル）。
    @Published private(set) var videoAvailable = false
    /// 再生画面で、サムネイルではなく動画を映している。
    @Published private(set) var videoMode = false
    /// 利用者が動画を選んでいる（次の曲に動画があれば、続けて動画で映す）。サムネイルを選ぶ・動画の再生に失敗すると解除する。
    @Published private(set) var prefersVideo = false
    @Published var shuffle = false
    /// 再生速度（利用者の設定。この端末内だけ。次の曲にも引き継ぐ）。
    @Published var speed = PlaybackSpeed.stored()
    /// 再生キュー：いまの周で、これから再生する曲（共通JSのQueueList）。
    @Published var upcoming: [EntryItem] = []
    @Published var repeatMode: RepeatMode = .off
    @Published var message: String?

    /// おやすみタイマー（終わりに、音量を下げて一時停止する）。端末内の一時的な状態。
    let sleepTimer = SleepTimer()
    /// お気に入り（シャッフルで、少しだけ選ばれやすくする）。この端末内だけ。変わったら、一覧の表示を更新する。
    var favorites = FavoritesStore()
    @Published var favoriteRevision = 0
    /// 音量の自動調整（曲ごとの平均音量の記録）。設定「曲ごとの音量差を自動で揃える」がオンのときだけ使う。
    private let loudness = LoudnessCache()
    /// 前回の続きから再生：最後の曲・位置の保存（端末内。同期しない）。なければ、保存も復元もしない。
    var resumeStore: ResumeStore?
    /// 起動後に、前回の曲を「一時停止の状態」で表示しているだけ（まだ読み込んでいない）。再生を押すと、保存した位置から始める。
    @Published private(set) var restoredPending = false
    private var resumeSeek: (id: String, position: Double)?
    /// 再生回数の台帳（数える・抽選の重み）。なければ、数えず、均等に抽選する。
    var counts: PlayCountStore?
    /// 曲の並べ替え・絞り込みの選択（リストごと。この端末内だけ）。再生順にも使う。
    let listViews = ListViewStore()
    /// 再生履歴（最近聴いた曲）と、自動リストの設定（件数・条件）。この端末内だけ。
    var history: PlayHistoryStore?
    /// クロスフェードを、この曲では、すでに始めた（同じ曲で、何度も始めない）。
    var crossfadeStartedFor: String?
    var crossfadePending = false
    let autoSettings = AutoListSettingsStore()
    /// 曲の情報（アーティスト・タグ・メモ・チャプター）。この端末内だけ。変わったら notesRevision が増える。
    let notes = SongNotesStore()
    @Published var notesRevision = 0
    /// アプリを開いている（前面にある）か。背面では、映像の層が外れるため、動画へ切り替えない（前面へ戻ったとき、切り替える）。テストでは差し替える。
    var isActive: () -> Bool = { UIApplication.shared.applicationState == .active }
    /// 再生の範囲（"*" はすべて、または、リストのID）。曲の所在の表示に使う。
    var playScope: String? { scope }
    let core: SharedCore
    let store: LibraryStore
    let backend: PlayerBackend
    private var system: SystemAudioHooks?
    private var scope: String?
    /// 自動リストの再生：再生範囲の曲のID（開いた時点の並び。scope は auto:…）。ふつうのリストでは nil。
    private var scopeEntryIds: [String]?
    var failureStreak = 0
    /// 曲の切り替え・停止のたびに増やす。待っている間に状態が変わった古い処理の結果を捨てるため。
    var generation = 0
    private var libraryObserver: AnyCancellable?
    let provider: MediaProvider?
    /// ロック画面に出す、曲のサムネイル（アプリが設定する）。
    var artworkProvider: ((EntryItem) -> UIImage?)?
    private var artworkCache: (id: String, image: UIImage)?
    private var lastArtworkLookup = Date.distantPast
    private var lastArtworkEntry: String?
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
        backend.speed = Float(speed)
        system = makeSystem?(self)
        backend.onEnded = { [weak self] in self?.ended() }
        backend.onFailed = { [weak self] reason in self?.failed(reason) }
        backend.onTick = { [weak self] in self?.tick() }
        sleepTimer.onFade = { [weak self] factor in self?.backend.volume = Float(factor) }
        sleepTimer.onExpire = { [weak self] in self?.pause() }
        // ライブラリの編集・削除・同期の反映で、再生中の曲がなくなったら止める（Windows版と同じ規則を共通JSで判断）。
        libraryObserver = store.$document.dropFirst().sink { [weak self] _ in
            Task { @MainActor in await self?.resync() }
        }
        _ = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.applyPreferredVideo() }
        }
    }

    /// 動画を選んでいて、この曲に動画があり、まだ動画で映していなければ、動画へ切り替える（前面にあるときだけ）。
    func applyPreferredVideo() {
        guard prefersVideo, videoAvailable, !videoMode, current != nil, isActive() else { return }
        switchVideo(true)
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

    /// 再生中の曲（ライブラリの登録情報）。
    var currentEntry: EntryItem? { current.flatMap { entry($0.entryId) } }

    func entry(_ id: String) -> EntryItem? {
        store.document?.playlists.lazy.flatMap(\.entries).first { $0.id == id }
    }

    // MARK: 操作

    /// scope：再生範囲のリストID（そのリストと子のリスト）、または "*"（すべて）。
    /// entryId が nil のときは、シャッフル再生で、最初の曲もランダムに選ぶ（再生範囲の中から。重みの設定に従う）。
    func play(entryId: String?, scope: String, entryIds: [String]? = nil) async {
        if let entryId {
            guard let target = entry(entryId), canPlay(target) else {
                message = "この曲はこの端末で再生できません（メディアがありません）。"
                return
            }
        }
        failureStreak = 0
        generation += 1
        let mine = generation
        // そのリストに、並べ替え・絞り込みを選んでいるときは、その順で再生する（明示の曲の並びがあるときは、それを優先）
        var entryIds = entryIds
        if entryIds == nil, let view = listViews.view(for: scope) { entryIds = await arrangedIds(scope: scope, view: view) }
        guard mine == generation else { return }
        guard let result = await startQueue(entryId: entryId, scope: scope, entryIds: entryIds),
              let id = result.id, let playlistId = result.playlistId else {
            if mine == generation { message = "この曲を再生キューに入れられません。" } // 失敗しても、再生中の曲・再生範囲は変えない
            return
        }
        guard mine == generation else { return } // 待っている間に、別の曲を選ばれた・止められた
        self.scope = scope
        scopeEntryIds = entryIds
        await load(id: id, playlistId: playlistId)
    }

    /// 再生キューだけを作る（読み込み・再生はしない）。entryId が nil のときは、シャッフルで、最初の曲もランダムに選ぶ。
    private func startQueue(entryId: String?, scope: String, entryIds: [String]? = nil) async -> QueueResult? {
        var request: [String: Any] = ["text": store.currentText, "scope": scope, "entryId": entryId ?? "", "shuffle": shuffle || entryId == nil, "playable": playableIds()]
        if let entryIds { request["entryIds"] = entryIds }
        if entryId == nil { request["randomStart"] = true; shuffle = true }
        if shuffle, let weights = await shuffleWeights() { request["weights"] = weights } // 再生回数が少ない曲を優先する（設定がオンのとき）
        return await queue("QueueStart", request)
    }

    /// 再生回数が少ない曲を優先する：曲のID → 重み（1/(1+回数)）。設定がオフ・台帳がないときは nil（均等）。
    private func shuffleWeights() async -> [String: Double]? {
        guard let counts, counts.weighted else { return nil }
        let entries = (store.document?.playlists ?? []).flatMap(\.entries).filter(canPlay)
        var seen = Set<String>(), unique: [EntryItem] = []
        for entry in entries where seen.insert(entry.id).inserted { unique.append(entry) }
        let keys = await countKeys(for: unique)
        let weights = await counts.weights(for: keys.compactMap { $0 }, favorites: favorites.keys)
        var result: [String: Double] = [:]
        for (entry, key) in zip(unique, keys) { if let key, let weight = weights[key] { result[entry.id] = weight } }
        return result
    }

    func isFavorite(key: String?) -> Bool { favorites.contains(key) }

    /// お気に入りにする／外す。キーがまだ分からない曲は、できない（理由を知らせる）。
    @discardableResult
    func setFavorite(key: String?, _ value: Bool) -> Bool {
        guard favorites.set(key, value) else {
            message = "この曲は、まだ識別できないため、お気に入りにできません。"
            return false
        }
        favoriteRevision += 1
        return true
    }

    /// 再生中の曲のメディアキー（お気に入りの単位）。
    func currentFavoriteKey() async -> String? {
        guard let current, let target = entry(current.entryId) else { return nil }
        return await countKeys(for: [target]).first ?? nil
    }

    /// 曲の行・メニューの「お気に入り」の操作。
    func favoriteAction(key: String?) -> RowAction? {
        guard let key else { return nil }
        let on = isFavorite(key: key)
        return RowAction(icon: on ? "heart.slash" : "heart", title: on ? "お気に入りから外す" : "お気に入りにする") { [weak self] in self?.setFavorite(key: key, !on) }
    }

    /// 曲の再生回数のキー：Bilibiliは同期用メディアキー、ローカルは「local:ファイル名」。
    func countKeys(for entries: [EntryItem]) async -> [String?] {
        let online = entries.filter { $0.type == "bilibili" }
        let keys = await provider?.syncKeys(for: online) ?? online.map { _ in nil }
        var byId: [String: String] = [:]
        for (entry, key) in zip(online, keys) { if let key { byId[entry.id] = key } }
        return entries.map { entry in
            guard entry.type == "local" else { return byId[entry.id] }
            guard let name = entry.fileName, name.range(of: "^[A-Za-z0-9._-]{1,200}$", options: .regularExpression) != nil else { return nil } // 共通の台帳のキーの形に合わない名前は、数えない
            return "local:" + name
        }
    }

    func next() { Task { await goNext() } }

    func previous() { Task { await goPrevious() } }

    func goNext() async {
        if restoredPending { await prepareRestoredQueue() } // 起動直後の表示だけの状態：先に、前回の曲を基準に再生キューを作る
        await advance(direction: 1, automatic: false)
    }

    func goPrevious() async {
        if restoredPending { await playRestored(fromStart: true); return } // 読み込み前：この曲の頭から再生する
        // 再生位置が数秒進んでいれば、前の曲ではなく、この曲の頭へ戻る（一般的なプレイヤーの動作）。
        if position > 3 { seek(to: 0); return }
        await advance(direction: -1, automatic: false)
    }

    func resume() {
        guard current != nil else { return }
        if restoredPending { Task { await playRestored(fromStart: false) }; return }
        backend.play()
        refresh()
    }

    func pause() {
        backend.pause()
        refresh()
        saveResume()
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
        if let counts { Task { await counts.stop() } }
        isPreparing = false
        videoMode = false
        videoAvailable = false
        backend.stop()
        current = nil
        scope = nil
        scopeEntryIds = nil
        refresh()
    }

    // MARK: 内部

    struct QueueResult: Decodable {
        var id: String?
        var playlistId: String?
        var error: String?
        var stopped: Bool?
    }

    func queue(_ function: String, _ request: [String: Any]) async -> QueueResult? {
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
    func syncRequest() -> [String: Any]? {
        guard let scope, let current else { return nil }
        var request: [String: Any] = ["text": store.currentText, "scope": scope, "entryId": current.entryId, "ownScope": current.playlistId, "shuffle": shuffle, "playable": playableIds()]
        if let scopeEntryIds { request["entryIds"] = scopeEntryIds }
        return request
    }

    func advance(direction: Int, automatic: Bool) async {
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

    func load(id: String, playlistId: String) async {
        guard let target = entry(id) else { return }
        system?.activate()
        generation += 1
        let mine = generation
        restoredPending = false
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
        backend.crossfade = crossfadePending ? Double(Crossfade.seconds(stored: UserDefaults.standard.integer(forKey: Crossfade.defaultsKey))) : 0 // 重ねて始めるのは、つなぎ目の自動の曲送りのときだけ
        crossfadePending = false
        backend.load(url: file)
        applyLeveling(file: file, generation: mine)
        if let seek = resumeSeek, seek.id == id { backend.seek(to: seek.position) } // 前回の続きから（位置は、再生を始める前に合わせる）
        resumeSeek = nil
        backend.play()
        audioFile = file
        loadedFile = file
        videoFile = nil
        videoMode = false
        videoAvailable = false
        refresh()
        Task { await refreshQueue() }
        Task { await updateVideoAvailability(for: target, file: file, generation: mine) }
        Task { // 再生回数：この曲の再生を数え始める（実再生3秒で1回。同期が無効でも数える）
            guard let counts else { return }
            let key = await countKeys(for: [target]).first ?? nil
            guard mine == generation else { return }
            await counts.begin(key: key)
        }
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
        applyPreferredVideo() // 動画で見ていたなら、次の曲も動画で映す
    }

    /// サムネイルと動画を切り替える（利用者の操作。選んだ側を、次の曲でも続ける）。動画がないときは何もしない。
    func setVideoMode(_ on: Bool) {
        prefersVideo = on && (videoAvailable || videoMode)
        switchVideo(on)
    }

    private func switchVideo(_ on: Bool) {
        guard current != nil, on != videoMode else { return }
        guard let target = on ? videoFile : audioFile else { return }
        let position = backend.position, playing = backend.isPlaying
        videoMode = on
        if loadedFile != target {
            backend.load(url: target)
            backend.seek(to: position)
            loadedFile = target
            applyLeveling(file: target, generation: generation) // 別のファイルなので、音量の倍率も測り直す（前のファイルの倍率を残さない）
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
        if let counts { // 短い曲は、終わりまで聞いたときに数える
            let duration = self.duration
            Task { await counts.observe(position: duration, duration: duration, paused: false, ended: true) }
        }
        if sleepTimer.consumeEndOfSong() { // 「この曲の終わりまで」：次の曲へ進まず、ここで止める
            backend.pause()
            refresh()
            return
        }
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
            prefersVideo = false // 動画を再生できなかったので、続けて動画へ切り替えない
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

    /// 曲の音量を揃える：測ったことがあれば、すぐ倍率を反映する。なければ、いったん等倍で再生し、測り終えたら反映する（初めての曲だけ、数秒かかる）。
    private func applyLeveling(file: URL, generation mine: Int) {
        guard UserDefaults.standard.object(forKey: "volumeLeveling") as? Bool ?? true else { backend.gain = 1; return }
        if let cached = loudness.cachedGain(file) { backend.gain = Float(cached); return }
        backend.gain = 1
        Task { [weak self] in
            guard let meanDb = await VolumeLeveling.meanDb(of: file), let self else { return }
            self.loudness.store(file, meanDb: meanDb)
            if mine == self.generation, UserDefaults.standard.object(forKey: "volumeLeveling") as? Bool ?? true { self.backend.gain = Float(VolumeLeveling.gain(meanDb: meanDb)) }
        }
    }

    /// 前回の続きから再生のために、いまの曲・位置を保存する（約10秒ごと・一時停止の瞬間。保存の間隔は ResumeStore が管理）。
    private func saveResume() {
        guard let resumeStore, let current, !isPreparing, !restoredPending else { return }
        resumeStore.observe(ResumeRecord(entryId: current.entryId, playlistId: current.playlistId, scope: (scope?.hasPrefix("auto:") == true ? "*" : scope) ?? "*", position: position, duration: duration), paused: !isPlaying)
    }

    /// アプリが背面へ移るとき・終了するときに、保存を確定する。
    func flushResume() { resumeStore?.flush() }

    /// 起動後、前回の曲を、一時停止の状態で表示する（読み込まず、鳴らさない）。ライブラリの読み込みのあとに呼ぶ。
    func restoreLast() {
        guard current == nil, let record = resumeStore?.get(), let target = entry(record.entryId), canPlay(target) else { return }
        current = NowPlaying(entryId: record.entryId, playlistId: record.playlistId, title: target.title.isEmpty ? "（無題）" : target.title)
        scope = record.scope
        position = record.position
        duration = record.duration
        isPlaying = false
        restoredPending = true
    }

    /// 表示だけの前回の曲を、実際に読み込んで再生する（保存した位置から。fromStart なら頭から）。
    private func playRestored(fromStart: Bool) async {
        guard restoredPending, let current else { return }
        let start = fromStart ? 0 : position
        resumeSeek = start > 0 ? (id: current.entryId, position: start) : nil
        await play(entryId: current.entryId, scope: scope ?? "*")
    }

    /// 表示だけの前回の曲を基準に、再生キューだけを作る（次の曲へ進むため）。
    private func prepareRestoredQueue() async {
        guard restoredPending, let current else { return }
        guard let result = await startQueue(entryId: current.entryId, scope: scope ?? "*"), result.id == current.entryId else { return }
        restoredPending = false
        self.current = NowPlaying(entryId: current.entryId, playlistId: result.playlistId ?? current.playlistId, title: current.title)
    }

    private func tick() {
        refresh()
        startCrossfadeIfDue()
        saveResume()
        if isPlaying && position > 0.5 { failureStreak = 0 } // 実際に再生できたら、失敗の連続を数え直す
        if let counts, current != nil, !isPreparing {
            let position = self.position, duration = self.duration, paused = !isPlaying
            Task { await counts.observe(position: position, duration: duration, paused: paused) }
        }
    }

    /// 曲の所在（ホームから、再生中の曲があるリストまでの階層）。規則は共通JS（Windows版の「再生中」の経路と同じ。再生範囲を通る経路を優先）。見つからなければ空。
    struct LocationItem: Equatable, Identifiable {
        let id: String
        let name: String
    }

    func location() async -> [LocationItem] {
        guard let current else { return [] }
        struct Reply: Decodable { struct Item: Decodable { let id: String; let name: String }; var path: [Item]? }
        do {
            let request = ["text": store.currentText, "playlistId": current.playlistId, "scope": scope ?? "*"]
            let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
            let reply = try JSONDecoder().decode(Reply.self, from: Data(try await core.callAsync("PlaylistPath", text).utf8))
            return (reply.path ?? []).map { LocationItem(id: $0.id, name: $0.name) }
        } catch { return [] }
    }

    /// 画面確認用（シミュレーターのスクリーンショット）：再生中の表示だけを作る。音は鳴らさず、通常の起動では使わない。
    func showDemo(title: String, position: Double, duration: Double, playlistId: String = "demo") {
        current = NowPlaying(entryId: "demo", playlistId: playlistId, title: title)
        isPlaying = true
        self.position = position
        self.duration = duration
    }

    /// 再生中の曲のサムネイル。画像が見つかるまでは、毎回探す（見つかったら、曲が変わるまで覚える）。
    private func currentArtwork() -> UIImage? {
        guard let current else { artworkCache = nil; return nil }
        if let artworkCache, artworkCache.id == current.entryId { return artworkCache.image }
        // 画像が見つかるまでの探索は、1.5秒に1回まで（毎回の更新で、曲の検索と画像の読み込みをしない）
        guard lastArtworkEntry != current.entryId || Date().timeIntervalSince(lastArtworkLookup) > 1.5 else { return nil }
        lastArtworkEntry = current.entryId
        lastArtworkLookup = Date()
        guard let entry = entry(current.entryId), let image = artworkProvider?(entry) else { return nil }
        artworkCache = (current.entryId, image)
        return image
    }

    func refresh() {
        isPlaying = backend.isPlaying
        position = backend.position
        duration = backend.duration
        system?.update(title: current?.title, position: position, duration: duration, playing: isPlaying, artwork: currentArtwork(), rate: speed)
    }
}
