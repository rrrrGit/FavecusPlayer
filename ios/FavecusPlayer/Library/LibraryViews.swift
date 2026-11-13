import SwiftUI
import UniformTypeIdentifiers

/// アプリの骨組み（ライブラリ・保存・設定の3つのタブ、ミニプレイヤー、再生画面）。
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

    @State private var tab = 0
    @State private var path = NavigationPath()
    @State private var showPlayer = false
    @State private var showPicker = false
    @State private var showImport = false
    @State private var showExport = false
    @State private var showSync = false
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
                    LibraryTab(store: store, services: services, path: $path, showPlayer: $showPlayer)
                        .tabItem { Label("ライブラリ", systemImage: "books.vertical.fill") }
                        .tag(0)
                    DownloadsTab(store: store, services: services, showPlayer: $showPlayer)
                        .tabItem { Label("保存", systemImage: "arrow.down.circle.fill") }
                        .tag(1)
                    SettingsTab(store: store, hasImporter: importer != nil, hasExporter: exporter != nil, hasSync: sync != nil, hasBilibili: bilibili != nil,
                                services: services, showPlayer: $showPlayer,
                                openPicker: { showPicker = true }, openExport: { showExport = true }, openSync: { showSync = true },
                                openBilibili: { showBilibili = true }, openDiagnostics: { showDiagnostics = true })
                        .tabItem { Label("設定", systemImage: "gearshape.fill") }
                        .tag(2)
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            await store.load()
            await sync?.start() // 同期が有効なら、状態を読み込んで同期を始める
            await downloads?.start() // 保存の記録を読み込み、前回から続いている取得を引き継ぐ
            await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
            // 画面確認用（シミュレーターのスクリーンショット）：起動引数で、タブ・階層・再生画面を指定する。通常の起動では何もしない。
            let defaults = UserDefaults.standard
            if let raw = defaults.string(forKey: "FavecusDemoPath"), path.isEmpty {
                for id in raw.split(separator: ",") { path.append(String(id)) }
            }
            if defaults.object(forKey: "FavecusDemoTab") != nil { tab = defaults.integer(forKey: "FavecusDemoTab") }
            if defaults.bool(forKey: "FavecusDemoPlayer") {
                player?.showDemo(title: "朝のピアノ", position: 62, duration: 257)
                showPlayer = true
            }
        }
        .onChange(of: store.document) { document in
            Task { await downloads?.refreshKeys(entries: document?.playlists.flatMap(\.entries) ?? []) }
        }
        .sheet(isPresented: $showDiagnostics) { PlaceholderView() }
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.zip]) { result in
            guard let importer else { return }
            switch result {
            case .success(let url):
                importer.begin(url: url)
                showImport = true
            case .failure(let error):
                store.notice = "ファイルを開けません：\(error.localizedDescription)"
            }
        }
        .onOpenURL { url in
            // 「このアプリで開く」で渡されたZIP（ファイルアプリ・共有シート）。
            guard let importer, url.isFileURL, url.pathExtension.lowercased() == "zip" else { return }
            importer.begin(url: url)
            showImport = true
        }
        .sheet(isPresented: $showBilibili) {
            if let bilibili { BilibiliSheet(account: bilibili, isPresented: $showBilibili) }
        }
        .sheet(isPresented: $showSync) {
            if let sync { SyncSheet(sync: sync, isPresented: $showSync) }
        }
        .sheet(isPresented: $showExport) {
            if let exporter { ExportSheet(coordinator: exporter, isPresented: $showExport) }
        }
        .sheet(isPresented: $showImport) {
            if let importer { ImportSheet(coordinator: importer, isPresented: $showImport) }
        }
        .fullScreenCover(isPresented: $showPlayer) {
            if let player { FullPlayerView(player: player, services: services, isPresented: $showPlayer).preferredColorScheme(.dark) }
        }
        .alert("お知らせ", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("閉じる", role: .cancel) { store.notice = nil }
        } message: {
            Text(store.notice ?? "")
        }
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

// MARK: ライブラリ

private enum LibraryFilter: String, CaseIterable, Identifiable {
    case playlists = "プレイリスト"
    case songs = "曲"
    case offline = "オフライン"
    var id: String { rawValue }
}

private struct LibraryTab: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    @Binding var path: NavigationPath
    @Binding var showPlayer: Bool
    @State private var filter: LibraryFilter = .playlists
    @State private var creating = false
    @State private var newName = ""

    private var document: LibraryDocument? { store.document }

    /// 全リストの曲（同じ曲は1回だけ。再生の範囲は、最初に見つかったリスト）。
    private var allSongs: [(entry: EntryItem, scope: String)] {
        var seen = Set<String>()
        var result: [(EntryItem, String)] = []
        for list in document?.playlists ?? [] {
            for entry in list.entries where seen.insert(entry.id).inserted { result.append((entry, list.id)) }
        }
        return result
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                chips
                switch filter {
                case .playlists:
                    PlaylistList(store: store, services: services, parentId: nil)
                case .songs:
                    songList(allSongs)
                case .offline:
                    songList(allSongs.filter { isOffline($0.entry) })
                }
            }
            .navigationTitle("ライブラリ")
            .toolbar { if filter == .playlists { ToolbarItem(placement: .navigationBarTrailing) { EditButton() } } }
            .navigationDestination(for: String.self) { id in
                PlaylistDetail(store: store, services: services, parentId: id)
            }
            .overlay(alignment: .bottomTrailing) {
                if filter == .playlists {
                    Button { newName = ""; creating = true } label: {
                        Label("新規作成", systemImage: "plus").font(.headline).padding(.horizontal, 18).padding(.vertical, 12)
                            .background(Capsule().fill(Color.white)).foregroundStyle(.black)
                    }
                    .padding(16)
                }
            }
            .alert("新しいプレイリスト", isPresented: $creating) {
                TextField("名前", text: $newName)
                Button("作成") { store.perform(["type": "create", "name": newName, "select": false]) }
                Button("キャンセル", role: .cancel) {}
            }
        }
        .miniPlayer(services, showPlayer: $showPlayer)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(LibraryFilter.allCases) { item in
                    Button { filter = item } label: {
                        Text(item.rawValue).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 8)
                            .background(Capsule().fill(filter == item ? Color.white : Color.white.opacity(0.12)))
                            .foregroundStyle(filter == item ? Color.black : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func isOffline(_ entry: EntryItem) -> Bool {
        if entry.type == "bilibili" {
            guard let key = services.downloads?.entryKeys[entry.id] else { return false }
            return services.downloads?.savedFile(key: key) != nil
        }
        return services.player?.canPlay(entry) == true
    }

    @ViewBuilder
    private func songList(_ songs: [(entry: EntryItem, scope: String)]) -> some View {
        if songs.isEmpty {
            VStack { Spacer(); Text(filter == .offline ? "オフラインで再生できる曲はありません" : "曲はありません").foregroundStyle(.secondary); Spacer() }.frame(maxWidth: .infinity)
        } else {
            List {
                ForEach(songs, id: \.entry.id) { item in
                    SongRow(entry: item.entry, scope: item.scope, services: services)
                }
            }
            .listStyle(.plain)
        }
    }
}

// MARK: プレイリスト

/// 親（nilなら最上位）の子リストの一覧。名前の変更・削除・並べ替えができる。
private struct PlaylistList: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    let parentId: String?
    @ObservedObject private var artwork: ArtworkStore
    @State private var renaming: PlaylistItem?
    @State private var renameText = ""
    @State private var pendingDelete: PlaylistItem?

    init(store: LibraryStore, services: Services, parentId: String?) {
        self.store = store
        self.services = services
        self.parentId = parentId
        _artwork = ObservedObject(wrappedValue: services.artwork)
    }

    private var children: [PlaylistItem] { store.document?.children(of: parentId) ?? [] }

    var body: some View {
        List {
            if children.isEmpty { Text("プレイリストはありません").foregroundStyle(.secondary) }
            ForEach(children) { list in
                NavigationLink(value: list.id) {
                    HStack(spacing: 12) {
                        ArtworkTile(image: cover(of: list), title: list.name, side: 56)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(list.name).font(.body.weight(.medium)).lineLimit(1)
                            Text("プレイリスト・\(list.entries.count)曲" + (list.childIds.isEmpty ? "" : "・子 \(list.childIds.count)")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .contextMenu {
                    Button("名前を変更") { renaming = list; renameText = list.name }
                    Button("削除", role: .destructive) { pendingDelete = list }
                }
            }
            .onMove { source, destination in
                guard let move = MoveMapper.map(ids: children.map(\.id), from: source, to: destination) else { return }
                var action: [String: Any] = ["type": "playlist-reorder", "playlistId": move.id, "targetId": move.targetId, "after": move.after]
                if let parentId { action["parentId"] = parentId }
                store.perform(action)
            }
        }
        .listStyle(.plain)
        .alert("名前を変更", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("名前", text: $renameText)
            Button("変更") {
                if let renaming { store.perform(["type": "rename", "playlistId": renaming.id, "name": renameText]) }
                renaming = nil
            }
            Button("キャンセル", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("プレイリストを削除", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("削除", role: .destructive) {
                if let pendingDelete { store.perform(["type": "delete", "playlistId": pendingDelete.id]) }
                pendingDelete = nil
            }
            Button("キャンセル", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("「\(pendingDelete?.name ?? "")」を削除します。曲はこのリストから消え、子のプレイリストは1つ上へ移ります。")
        }
    }

    /// リストの画像：最初に画像のある曲のもの。
    private func cover(of list: PlaylistItem) -> UIImage? {
        _ = artwork.revision
        for entry in list.entries {
            if let key = services.downloads?.entryKeys[entry.id], let image = artwork.image(for: key) { return image }
        }
        return nil
    }
}

/// 1つのリストのページ：画像つきの見出し、シャッフル・再生、子のリスト、曲。
private struct PlaylistDetail: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    let parentId: String
    @ObservedObject private var artwork: ArtworkStore
    @Environment(\.editMode) private var editMode

    init(store: LibraryStore, services: Services, parentId: String) {
        self.store = store
        self.services = services
        self.parentId = parentId
        _artwork = ObservedObject(wrappedValue: services.artwork)
    }

    private var parent: PlaylistItem? { store.document?.playlist(parentId) }
    private var entries: [EntryItem] { parent?.entries ?? [] }
    private var cover: UIImage? {
        _ = artwork.revision
        for entry in entries {
            if let key = services.downloads?.entryKeys[entry.id], let image = artwork.image(for: key) { return image }
        }
        return nil
    }

    var body: some View {
        List {
            header
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
            if let parent, !parent.childIds.isEmpty {
                Section("子のプレイリスト") {
                    PlaylistChildren(store: store, services: services, parentId: parentId)
                }
            }
            Section("曲") {
                if entries.isEmpty { Text("曲はありません").foregroundStyle(.secondary) }
                ForEach(entries) { entry in
                    SongRow(entry: entry, scope: parentId, services: services) {
                        store.perform(["type": "remove", "playlistId": parentId, "entryId": entry.id])
                    }
                }
                .onMove { source, destination in
                    guard let move = MoveMapper.map(ids: entries.map(\.id), from: source, to: destination) else { return }
                    store.perform(["type": "reorder", "playlistId": parentId, "entryId": move.id, "targetId": move.targetId, "after": move.after])
                }
            }
        }
        .listStyle(.plain)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { EditButton() } }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ArtworkTile(image: cover, title: parent?.name ?? "", side: 180, corner: 10)
                .shadow(radius: 12)
                .padding(.top, 12)
            Text(parent?.name ?? "").font(.title.bold()).multilineTextAlignment(.center).padding(.horizontal)
            Text("\(entries.count)曲" + ((parent?.childIds.isEmpty ?? true) ? "" : "・子のプレイリスト \(parent?.childIds.count ?? 0)")).font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 16) {
                Button { play(shuffled: true) } label: { Image(systemName: "shuffle").font(.title3).frame(width: 48, height: 48).background(Circle().fill(Color.white.opacity(0.12))) }
                Button { play(shuffled: false) } label: { Image(systemName: "play.fill").font(.title2).foregroundStyle(.black).frame(width: 60, height: 60).background(Circle().fill(Color.white)) }
            }
            .buttonStyle(.plain)
            .disabled(services.player == nil || entries.isEmpty)
            .padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity)
    }

    private func play(shuffled: Bool) {
        guard let player = services.player, let first = entries.first(where: { player.canPlay($0) }) ?? entries.first else { return }
        player.shuffle = shuffled
        Task { await player.play(entryId: first.id, scope: parentId) }
    }
}

/// 子のリスト（詳細ページの中）。
private struct PlaylistChildren: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    let parentId: String

    private var children: [PlaylistItem] { store.document?.children(of: parentId) ?? [] }

    var body: some View {
        ForEach(children) { list in
            NavigationLink(value: list.id) {
                HStack(spacing: 12) {
                    ArtworkTile(image: nil, title: list.name, side: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(list.name).lineLimit(1)
                        Text("プレイリスト・\(list.entries.count)曲").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .onMove { source, destination in
            guard let move = MoveMapper.map(ids: children.map(\.id), from: source, to: destination) else { return }
            store.perform(["type": "playlist-reorder", "playlistId": move.id, "targetId": move.targetId, "after": move.after, "parentId": parentId])
        }
    }
}

