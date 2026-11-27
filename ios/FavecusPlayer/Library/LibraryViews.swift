import SwiftUI
import UniformTypeIdentifiers

/// アプリの骨組み（ライブラリ・保存・アラーム・設定の4つのタブ、ミニプレイヤー、再生画面）。
/// 表示・編集の規則はここに持たず、操作は LibraryStore.perform（共通JS）へ渡すだけ。
struct LibraryRootView: View {
    @ObservedObject var store: LibraryStore
    let importer: ImportCoordinator?
    let exporter: ExportCoordinator?
    let player: PlaybackEngine?
    let sync: SyncCoordinator?
    let bilibili: BilibiliAccount?
    let downloads: DownloadService?
    let artwork: ArtworkStore
    let observer: ServicesObserver
    var onLibraryLoaded: () async -> Void = {}
    var onDocumentChanged: () async -> Void = {}

    @State private var tab = 0
    @State private var path = NavigationPath()
    @State private var showPlayer = false
    /// 再生画面から「ライブラリで表示」が押された：再生画面を閉じたあとで、タブ・階層・曲の位置を切り替える（閉じている最中に切り替えると、無視されることがある）。
    @State private var pendingReveal: RevealTarget?
    @State private var reveal: RevealTarget?
    @State private var showPicker = false
    @State private var showImport = false
    @State private var pendingImport = false
    @State private var waitingForImportDismissal = false
    @State private var showExport = false
    @State private var showSync = false
    @State private var alarmDemo: AlarmDemoMode?
    /// 画面確認用：stats / auto / audit の画面を、そのまま開く。
    @State private var insightsDemo: String?
    @State private var showBilibili = false
    @State private var showDiagnostics = false

    private var services: Services { Services(player: player, downloads: downloads, artwork: artwork) }

    var body: some View {
        Group {
            switch store.state {
            case .loading:
                ProgressView("読み込み中…")
            case .blocked(let message):
                BlockedView(message: message)
            case .ready:
                TabView(selection: $tab) {
                    LibraryTab(store: store, services: services, path: $path, showPlayer: $showPlayer, reveal: $reveal)
                        .tabItem { Label("ライブラリ", systemImage: "books.vertical.fill") }
                        .tag(0)
                    DownloadsTab(store: store, services: services, showPlayer: $showPlayer)
                        .tabItem { Label("保存", systemImage: "arrow.down.circle.fill") }
                        .tag(1)
                    AlarmTab(store: store, services: services, showPlayer: $showPlayer)
                        .tabItem { Label("アラーム", systemImage: "alarm.fill") }
                        .tag(2)
                    SettingsTab(store: store, hasImporter: importer != nil, hasExporter: exporter != nil, hasSync: sync != nil, hasBilibili: bilibili != nil,
                                services: services, showPlayer: $showPlayer,
                                openPicker: { showPicker = true }, openExport: { showExport = true }, openSync: { showSync = true },
                                openBilibili: { showBilibili = true }, openDiagnostics: { showDiagnostics = true })
                        .tabItem { Label("設定", systemImage: "gearshape.fill") }
                        .tag(3)
                }
            }
        }
        .environmentObject(observer)
        .tint(Theme.accent)
        .background(Theme.background.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .background {
            if let player { RootPlayerAlert(player: player, showPlayer: showPlayer) }
        }
        .task {
            await store.load()
            player?.restoreLast() // 前回の曲を、一時停止の状態で表示する（鳴らさない）
            await downloads?.start() // 保存の記録を先に読み込み、アラーム再生やオフライン再生を待たせない
            await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
            downloads?.ensureLocalFrames(entries: store.document?.playlists.flatMap(\.entries) ?? [], mediaDirectory: store.mediaDirectory)
            await onLibraryLoaded()
            await sync?.start() // 同期が有効なら、状態を読み込んで同期を始める
            // 画面確認用（シミュレーターのスクリーンショット）：起動引数で、タブ・階層・再生画面を指定する。通常の起動では何もしない。
            let defaults = UserDefaults.standard
            if let raw = defaults.string(forKey: "FavecusDemoPath"), path.isEmpty {
                for id in raw.split(separator: ",") { path.append(String(id)) }
            }
            if defaults.object(forKey: "FavecusDemoTab") != nil { tab = defaults.integer(forKey: "FavecusDemoTab") }
            if defaults.bool(forKey: "FavecusDemoSync") { showSync = true }
            if let raw = defaults.string(forKey: "FavecusDemoAlarm") { alarmDemo = AlarmDemoMode(rawValue: raw) }
            if let raw = defaults.string(forKey: "FavecusDemoInsights") { insightsDemo = raw }
            if defaults.bool(forKey: "FavecusDemoMini") { player?.showDemo(title: "朝のピアノ", position: 62, duration: 257) }
            if defaults.bool(forKey: "FavecusDemoPlayer") {
                // 所在の表示を確かめるため、模擬ライブラリの深い階層のリスト（作業用BGM ＞ 集中 ＞ 試験前）を持つ曲として表示する
                player?.showDemo(title: "朝のピアノ", position: 62, duration: 257, playlistId: "00000001-0000-4000-8000-000000000004")
                showPlayer = true
            }
        }
        .onChange(of: store.document) { document in
            Task {
                await downloads?.refreshKeys(entries: document?.playlists.flatMap(\.entries) ?? [])
                downloads?.ensureLocalFrames(entries: document?.playlists.flatMap(\.entries) ?? [], mediaDirectory: store.mediaDirectory)
                await onDocumentChanged()
            }
        }
        .sheet(isPresented: $showDiagnostics, onDismiss: finishImportDismissal) { PlaceholderView() }
        .sheet(item: $alarmDemo, onDismiss: finishImportDismissal) { AlarmDemoView(mode: $0, store: store, downloads: downloads) }
        .sheet(isPresented: Binding(get: { insightsDemo != nil }, set: { if !$0 { insightsDemo = nil } }), onDismiss: finishImportDismissal) {
            NavigationStack {
                switch insightsDemo {
                case "auto": AutoListSettingsView(store: player?.autoSettings ?? AutoListSettingsStore(), player: player)
                case "audit": AuditView(store: store, player: player)
                default: StatsView(player: player)
                }
            }
        }
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.zip]) { result in
            guard let importer else { return }
            switch result {
            case .success(let url):
                importer.begin(url: url)
                Task { @MainActor in
                    await Task.yield()
                    requestImportPresentation()
                }
            case .failure(let error):
                store.notice = "ファイルを開けません：\(ErrorText.safe(error))"
            }
        }
        .onOpenURL { url in
            // 「このアプリで開く」で渡されたZIP（ファイルアプリ・共有シート）。
            guard let importer, url.isFileURL, url.pathExtension.lowercased() == "zip" else { return }
            importer.begin(url: url)
            requestImportPresentation()
        }
        .sheet(isPresented: $showBilibili, onDismiss: finishImportDismissal) {
            if let bilibili { BilibiliSheet(account: bilibili, isPresented: $showBilibili) }
        }
        .sheet(isPresented: $showSync, onDismiss: finishImportDismissal) {
            if let sync { SyncSheet(sync: sync, isPresented: $showSync) }
        }
        .sheet(isPresented: $showExport, onDismiss: finishImportDismissal) {
            if let exporter { ExportSheet(coordinator: exporter, isPresented: $showExport) }
        }
        .sheet(isPresented: $showImport) {
            if let importer { ImportSheet(coordinator: importer, isPresented: $showImport) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openFullPlayer)) { _ in showPlayer = true } // 再生ボタンを押したとき、再生画面を大きく開く
        .fullScreenCover(isPresented: $showPlayer, onDismiss: { applyReveal(); finishImportDismissal() }) {
            if let player {
                FullPlayerView(player: player, services: services, isPresented: $showPlayer) { chain, entryId in
                    guard let last = chain.last else { return }
                    pendingReveal = RevealTarget(chain: chain, listId: last, entryId: entryId)
                    showPlayer = false
                }
                .tint(Theme.accent).preferredColorScheme(.dark)
            }
        }
        .alert("お知らせ", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("コピー") { Clipboard.copy(store.notice ?? ""); store.notice = nil }
            Button("閉じる", role: .cancel) { store.notice = nil }
        } message: {
            Text(store.notice ?? "")
        }
    }
}

/// 再生画面からライブラリへ移動する先（ホームからのプレイリストの階層、最後のリスト、曲の位置まで動かすときの曲のID）。
struct RevealTarget: Equatable {
    let chain: [String]
    let listId: String
    let entryId: String?
}

extension LibraryRootView {
    private func requestImportPresentation() {
        guard !showImport else { return }
        pendingImport = true
        // シートのアニメーションが終わるまで、次の表示はonDismissに任せる。
        let dismissingSheet = showSync || showBilibili || showExport || showDiagnostics || alarmDemo != nil || insightsDemo != nil || showPlayer
        waitingForImportDismissal = waitingForImportDismissal || dismissingSheet
        showSync = false
        showBilibili = false
        showExport = false
        showDiagnostics = false
        alarmDemo = nil
        insightsDemo = nil
        showPlayer = false
        showPicker = false
        if !dismissingSheet {
            Task { @MainActor in
                await Task.yield()
                presentPendingImport()
            }
        }
    }

    private func presentPendingImport() {
        guard pendingImport, !waitingForImportDismissal, !showPicker, !showPlayer, !showSync, !showBilibili, !showExport, !showDiagnostics, alarmDemo == nil, insightsDemo == nil else { return }
        pendingImport = false
        showImport = true
    }

    private func finishImportDismissal() {
        waitingForImportDismissal = false
        presentPendingImport()
    }

    fileprivate func applyReveal() {
        guard let target = pendingReveal else { return }
        pendingReveal = nil
        tab = 0
        path = NavigationPath(target.chain)
        reveal = target
    }
}

/// 各タブで同時に提示せず、再生画面が閉じている間だけルートが通知を受け持つ。
private struct RootPlayerAlert: View {
    @ObservedObject var player: PlaybackEngine
    let showPlayer: Bool

    var body: some View {
        Color.clear
            .alert("お知らせ", isPresented: Binding(get: { player.message != nil && !showPlayer }, set: { if !$0 && !showPlayer { player.message = nil } })) {
                Button("コピー") { Clipboard.copy(player.message ?? ""); player.message = nil }
                Button("閉じる", role: .cancel) { player.message = nil }
            } message: { Text(player.message ?? "") }
    }
}

private struct BlockedView: View {
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle)
            Text("保存データを開けません").font(.headline)
            Text(message).font(.footnote).multilineTextAlignment(.center)
            Text("保存データは変更していません。アプリを更新するか、バックアップから復元してください。")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding()
    }
}

/// 各タブの下に出す、ミニプレイヤー。
extension View {
    func miniPlayer(_ services: Services, showPlayer: Binding<Bool>) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            if let player = services.player { MiniPlayerBar(player: player, services: services, showPlayer: showPlayer) }
        }
    }
}

