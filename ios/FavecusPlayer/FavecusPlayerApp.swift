import SwiftUI
import UIKit

/// 背面で終わった保存の通信を、再起動されたときに受け取る（BackgroundTransfers が同じ識別子のセッションを作り直して続きを受け取る）。
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// 画面の向きの制限：通常は縦のみ。動画の最大化の間だけ、OrientationLock が横を許す。
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.mask
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        BackgroundTransfers.register(identifier: identifier, completion: completionHandler)
    }

    /// 背面で起こされたときも、画面（Scene）を待たずに、保存の通信のセッションを作り直して、続きを受け取る。
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        _ = AppEnvironment.shared
        // PC版と同じ配色（タブバー・ナビゲーションバー）
        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(Theme.panel)
        tab.shadowColor = UIColor(Theme.line)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
        let bar = UINavigationBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = UIColor(Theme.panel)
        bar.shadowColor = UIColor(Theme.line)
        bar.titleTextAttributes = [.foregroundColor: UIColor(Theme.text)]
        bar.largeTitleTextAttributes = [.foregroundColor: UIColor(Theme.text)]
        UINavigationBar.appearance().standardAppearance = bar
        UINavigationBar.appearance().scrollEdgeAppearance = bar
        return true
    }
}

@main
struct FavecusPlayerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var environment = AppEnvironment.shared

    var body: some Scene {
        WindowGroup {
            LibraryRootView(store: environment.store, importer: environment.importer, exporter: environment.exporter, player: environment.player, sync: environment.sync, bilibili: environment.bilibili, downloads: environment.downloads, artwork: environment.artwork, observer: environment.observer, onLibraryLoaded: { await environment.onLibraryLoaded() }, onDocumentChanged: { await environment.migrateAliases() })
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        Task { await environment.downloads?.resume(); await environment.alarms.resync(); await environment.playPendingAlarm() }
                        environment.player?.sleepTimer.tick() // 画面ロック中に期限を過ぎていれば、すぐ止める
                    } else {
                        environment.player?.flushResume() // 背面へ移るとき、前回の続きの位置を確定する
                    }
                }
                .task { await environment.playPendingAlarm() }
        }
    }
}

/// アプリ全体の部品（保存・取り込み）を1か所で作る。
@MainActor
final class AppEnvironment: ObservableObject {
    static let shared = AppEnvironment()
    let observer: ServicesObserver
    let store: LibraryStore
    let importer: ImportCoordinator?
    let exporter: ExportCoordinator?
    let player: PlaybackEngine?
    let sync: SyncCoordinator?
    let bilibili: BilibiliAccount?
    let downloads: DownloadService?
    let artwork: ArtworkStore
    /// アラーム（端末内だけ。同期しない）。保存先の準備に失敗しても、アラームの画面にだけ理由を出す。
    let alarms: AlarmService
    private(set) var libraryReady = false
    private var pendingAlarmId: String?
    private var playingPendingAlarm = false

    func migrateAliases() async {
        let aliases = (store.document?.videoAliases ?? []).map { ["aid": $0.aid, "bvid": $0.bvid] }
        await player?.migrateAliases(aliases)
    }

    func onLibraryLoaded() async {
        await migrateAliases()
        libraryReady = true
        await alarms.resync()
        await playPendingAlarm()
    }

    /// アラームの「曲を再生」で開かれたとき、そのアラームの曲の全体を再生する。ライブラリ・保存の読み込みを待つ（最大10秒）。
    func playPendingAlarm() async {
        pendingAlarmId = pendingAlarmId ?? AlarmPlayRequest.take()
        guard let id = pendingAlarmId, !playingPendingAlarm else { return }
        playingPendingAlarm = true
        defer { playingPendingAlarm = false }
        guard let alarm = alarms.alarms.first(where: { $0.id.uuidString == id }), let sound = alarm.sound else {
            pendingAlarmId = nil
            return
        }
        let catalog = AlarmSongCatalog(store: store, downloads: downloads)
        var refreshedKeys = false
        for _ in 0..<50 {
            if case .ready = store.state {
                if let entryId = catalog.entryId(forKey: sound.mediaKey), let player {
                    pendingAlarmId = nil
                    OpenPlayer.request()
                    await player.play(entryId: entryId, scope: "*")
                    return
                }
                if !refreshedKeys {
                    refreshedKeys = true
                    await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
                    if let entryId = catalog.entryId(forKey: sound.mediaKey), let player {
                        pendingAlarmId = nil
                        OpenPlayer.request()
                        await player.play(entryId: entryId, scope: "*")
                        return
                    }
                }
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        pendingAlarmId = nil
        alarms.notice = "アラームの曲を再生できませんでした（曲が見つかりません）"
    }

    init() {
        let alarmDirectory = (try? LibraryStore.defaultDirectory()) ?? FileManager.default.temporaryDirectory.appendingPathComponent("FavecusPlayer-unavailable")
        let alarmService = AlarmService(store: AlarmStore(directory: alarmDirectory), scheduler: AlarmSchedulers.make())
        // 作ったアラームの音は、Library/Sounds（アラームが探す場所）に置く
        alarmService.soundsDirectory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?.appendingPathComponent("Sounds", isDirectory: true)
        alarms = alarmService
        do {
            let directory = try LibraryStore.defaultDirectory()
            let core = try SharedCore(bundle: .main)
            let store = LibraryStore(core: core, directory: directory)
            self.store = store
            importer = ImportCoordinator(service: TransferService(core: core), store: store)
            exporter = ExportCoordinator(service: ExportService(core: core), store: store)
            // Bilibiliの情報取得は、別のJavaScriptCoreで動かす（ログイン情報はKeychain。api.bilibili.com 宛てだけにCookieを付ける）。
            let cookies = BilibiliCookieVault()
            let biliCore = try? BiliCore(bundle: .main, host: BilibiliHost(cookies: cookies))
            bilibili = biliCore.map { BilibiliAccount(cookies: cookies, core: $0) }
            let service = biliCore.map { BilibiliService(core: $0) }
            // 保存（ダウンロード）とオンライン再生の取得。保存先は、バックアップ対象外のフォルダ。
            let downloadsDirectory = store.syncDirectory.deletingLastPathComponent().appendingPathComponent("downloads", isDirectory: true)
            let caches = (try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
            let downloadService = service.map {
                DownloadService(catalog: DownloadCatalog(url: downloadsDirectory.deletingLastPathComponent().appendingPathComponent("downloads.json"), mediaDirectory: downloadsDirectory),
                                bilibili: $0, downloader: MediaDownloader(), transfers: BackgroundTransfers(configuration: BackgroundTransfers.backgroundConfiguration(), jobsDirectory: downloadsDirectory.deletingLastPathComponent().appendingPathComponent("download-jobs", isDirectory: true), stagingRoot: downloadsDirectory, wifiOnly: { UserDefaults.standard.bool(forKey: "downloadWiFiOnly") }), core: core, directory: downloadsDirectory, cacheDirectory: caches.appendingPathComponent("online", isDirectory: true),
                                aliasesProvider: { (store.document?.videoAliases ?? []).map { ["aid": $0.aid, "bvid": $0.bvid] } })
            }
            let artworkStore = ArtworkStore(directory: downloadsDirectory.deletingLastPathComponent().appendingPathComponent("thumbnails", isDirectory: true))
            downloadService?.artwork = artworkStore
            artwork = artworkStore
            downloads = downloadService
            if let downloadService { importer?.downloadImporter = { zip, records, entries in await downloadService.importDownloaded(from: zip, records: records, entries: entries) } }
            observer = ServicesObserver(downloads: downloadService, artwork: artworkStore)
            let appDataDirectory = store.syncDirectory.deletingLastPathComponent()
            let aliasesProvider: () -> [[String: String]] = { (store.document?.videoAliases ?? []).map { ["aid": $0.aid, "bvid": $0.bvid] } }
            let favoritesStore = FavoritesStore(directory: appDataDirectory, core: core, aliasesProvider: aliasesProvider)
            let engine = PlaybackEngine(core: core, store: store, backend: AVPlayerBackend(), provider: downloadService, favorites: favoritesStore, makeSystem: { SystemAudio(controls: $0) })
            let artworkLookup = downloadService
            engine.artworkProvider = { entry in artworkStore.image(for: artworkLookup?.entryKeys[entry.id]) }
            // 再生回数の台帳（同期が無効でも数える）。数え方・重みの規則は共通JS
            let playCounts = PlayCountStore(core: core, directory: appDataDirectory, aliasesProvider: aliasesProvider)
            engine.counts = playCounts
            // 再生履歴：回数を数えたときに足す（Bilibili曲・削除時刻は同期する）
            let history = PlayHistoryStore(core: core, directory: appDataDirectory, aliasesProvider: aliasesProvider)
            engine.history = history
            playCounts.onCounted = { key in Task { @MainActor in await history.add(key: key) } }
            engine.resumeStore = ResumeStore()
            engine.bindExtras()
            player = engine
            // 同期は、再生などとは別のJavaScriptCoreで動かす。Keychainが使えない環境でも、起動は妨げない（同期の画面にエラーとして出る）。
            let vault = KeychainVault()
            let host = StoreSyncHost(store: store, directory: store.syncDirectory, vault: vault, counts: playCounts, favorites: favoritesStore, history: history)
            let coordinator = (try? SyncCore(bundle: .main, host: host)).map { SyncCoordinator(store: store, core: $0, host: host, vault: vault) }
            sync = coordinator
            playCounts.onChange = { [weak coordinator] in coordinator?.scheduleExtras() }
            favoritesStore.onChange = { [weak coordinator] in coordinator?.scheduleExtras() }
            history.onChange = { [weak coordinator] in coordinator?.scheduleExtras() }
            coordinator?.onResetExtras = {
                playCounts.resetSync()
                favoritesStore.resetSync()
                history.resetSync()
            }
            let catalog = AlarmSongCatalog(store: store, downloads: downloadService)
            alarmService.soundSource = { catalog.file(forKey: $0) }
            // アラームの「ランダム」：保存済みの曲から抽選（お気に入りは、少しだけ選ばれやすい）。音は、最初の30秒
            alarmService.randomPicker = { [weak engine] in
                AlarmRandom.pick(catalog.songs(), favorites: engine?.favorites.keys ?? [], rng: { Double.random(in: 0..<1) }).map(AlarmRandom.sound(for:))
            }
        } catch {
            // 起動に必要な部品がない：保存データには触らず、画面に理由を出す。
            let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("FavecusPlayer-unavailable")
            store = LibraryStore(core: nil, directory: fallback, startupError: "起動に必要な部品を読み込めません：\(error)")
            importer = nil
            exporter = nil
            player = nil
            sync = nil
            bilibili = nil
            downloads = nil
            let fallbackArtwork = ArtworkStore(directory: fallback.appendingPathComponent("thumbnails", isDirectory: true))
            artwork = fallbackArtwork
            observer = ServicesObserver(downloads: nil, artwork: fallbackArtwork)
        }
        alarms.isLibraryReady = { [weak self] in self?.libraryReady == true }
        alarms.pendingPlayAlarmId = { [weak self] in self?.pendingAlarmId }
    }
}
