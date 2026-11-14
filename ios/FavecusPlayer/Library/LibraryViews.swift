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
    let observer: ServicesObserver

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
        .environmentObject(observer)
        .tint(Theme.accent)
        .background(Theme.background.ignoresSafeArea())
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
            if defaults.bool(forKey: "FavecusDemoSync") { showSync = true }
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
            if let player { FullPlayerView(player: player, services: services, isPresented: $showPlayer).tint(Theme.accent).preferredColorScheme(.dark) }
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

// MARK: ホーム（四角のカード）

private struct LibraryTab: View {
    @EnvironmentObject private var observer: ServicesObserver // 保存の状態・サムネイルが変わったら描き直す
    @ObservedObject var store: LibraryStore
    let services: Services
    @Binding var path: NavigationPath
    @Binding var showPlayer: Bool
    @State private var editing = false
    @State private var creating = false
    @State private var newName = ""
    @State private var renaming: PlaylistItem?
    @State private var renameText = ""
    @State private var pendingDelete: PlaylistItem?
    @State private var dragging: String?

    private var document: LibraryDocument? { store.document }
    private var roots: [PlaylistItem] { document?.children(of: nil) ?? [] }
    private var songCount: Int {
        var seen = Set<String>()
        for list in document?.playlists ?? [] { for entry in list.entries { seen.insert(entry.id) } }
        return seen.count
    }
    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        SectionLabel(text: "HOME")
                        Text("\(songCount)曲").font(.system(size: 12)).foregroundStyle(Theme.mint)
                    }
                    if editing {
                        EditNotice(text: "編集中です。各カードの ✎ で名前を変更、ごみ箱で削除します。並べ替えは、編集中でなくても、カードを長押ししてつかみ、動かしたい場所のカードの上で離します。終わったら、右上のチェックを押します。")
                    }
                    if roots.isEmpty {
                        Text("プレイリストはありません。右下の「新規作成」から作れます。").font(.system(size: 13)).foregroundStyle(Theme.muted).padding(.top, 20)
                    }
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(Array(roots.enumerated()), id: \.element.id) { index, list in
                            card(list, index: index)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 90)
            }
            .background(Theme.background)
            .navigationTitle("マイライブラリ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { EditToggle(editing: $editing) } }
            .navigationDestination(for: String.self) { id in
                PlaylistDetail(store: store, services: services, parentId: id)
            }
            .overlay(alignment: .bottomTrailing) {
                Button { newName = ""; creating = true } label: { Label("新規作成", systemImage: "plus") }
                    .buttonStyle(PrimaryButtonStyle())
                    .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
                    .padding(16)
            }
            .alert("新しいプレイリスト", isPresented: $creating) {
                TextField("名前", text: $newName)
                Button("作成") { store.perform(["type": "create", "name": newName, "select": false]) }
                Button("キャンセル", role: .cancel) {}
            }
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
        .miniPlayer(services, showPlayer: $showPlayer)
        .onAppear { if UserDefaults.standard.bool(forKey: "FavecusDemoHomeEdit") { editing = true } }
    }

    @ViewBuilder
    private func card(_ list: PlaylistItem, index: Int) -> some View {
        let face = ZStack(alignment: .bottom) {
            SquareCover(image: firstCover(of: list, document: document, services: services))
            LinearGradient(colors: [.clear, .black.opacity(0.78)], startPoint: .center, endPoint: .bottom)
            HStack(alignment: .bottom, spacing: 4) {
                Text(list.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.85))
            }
            .padding(8)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.coverLine, lineWidth: 1))
        Group {
            if editing {
                face.overlay(alignment: .top) { editControls(list, index: index) }
            } else {
                NavigationLink(value: list.id) { face }.buttonStyle(.plain)
            }
        }
        .opacity(dragging == list.id ? 0.4 : 1)
        .onDrag {
            dragging = list.id
            return NSItemProvider(object: list.id as NSString)
        }
        .onDrop(of: [.text], delegate: PlaylistReorderDrop(target: list.id, siblings: roots.map(\.id), dragging: $dragging) { id, target, after in
            store.perform(["type": "playlist-reorder", "playlistId": id, "targetId": target, "after": after])
        })
    }

    private func editControls(_ list: PlaylistItem, index: Int) -> some View {
        HStack(spacing: 4) {
            round("pencil", label: "名前を変更") { renaming = list; renameText = list.name }
            round("trash", label: "削除") { pendingDelete = list }
            Spacer(minLength: 0)
        }
        .padding(6)
    }

    private func round(_ icon: String, label: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .frame(width: 30, height: 30).background(Circle().fill(Color.black.opacity(0.65)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
    }

}

/// 編集の説明（「編集中です。…」）。
private struct EditNotice: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "pencil.circle.fill").foregroundStyle(Theme.accent)
            Text(text).font(.system(size: 12)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.currentRow))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.controlLine, lineWidth: 1))
    }
}

/// 右上の編集ボタン（ペンのマーク。編集中はチェックのマークで、押すと終わる）。
private struct EditToggle: View {
    @Binding var editing: Bool

    var body: some View {
        Button { withAnimation { editing.toggle() } } label: {
            Image(systemName: editing ? "checkmark.circle.fill" : "pencil").font(.system(size: 17, weight: .semibold))
        }
        .accessibilityLabel(editing ? "編集を終わる" : "編集")
    }
}

// MARK: 並べ替え（長押しでつかんで動かす）

/// プレイリストのカードを長押しでつかみ、別のカードの上で離すと、その位置へ移す（左右の矢印は使わない）。
/// つかんだカードが、離した先より前にあったなら、その後ろへ。後ろにあったなら、その前へ入れる。
struct PlaylistReorderDrop: DropDelegate {
    let target: String
    let siblings: [String]
    @Binding var dragging: String?
    let move: (_ id: String, _ target: String, _ after: Bool) -> Void

    func validateDrop(info: DropInfo) -> Bool { dragging != nil }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func performDrop(info: DropInfo) -> Bool {
        defer { dragging = nil }
        guard let id = dragging, id != target, let from = siblings.firstIndex(of: id), let to = siblings.firstIndex(of: target) else { return false }
        move(id, target, from < to)
        return true
    }
}

// MARK: プレイリストのページ

/// 1つのリストのページ（PC版と同じ構成）：先頭の曲のサムネイルを出した見出し → 「再生リスト」の行（上へ・曲数・検索・並べ替え・シャッフル再生・再生）
/// → 子のプレイリスト（幅いっぱいのカード。長押しで並べ替え）→ 曲（番号・画像・曲名・長さ/ID/パート・DL済み・…）。
private struct PlaylistDetail: View {
    @EnvironmentObject private var observer: ServicesObserver
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: LibraryStore
    let services: Services
    let parentId: String
    @State private var editMode: EditMode = .inactive
    @State private var showAdd = false
    @State private var showSave = false
    @State private var query = ""
    @State private var dragging: String?

    private var parent: PlaylistItem? { store.document?.playlist(parentId) }
    private var allEntries: [EntryItem] { parent?.entries ?? [] }
    private var entries: [EntryItem] {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return allEntries }
        return allEntries.filter { $0.title.localizedCaseInsensitiveContains(text) || ($0.videoId ?? "").localizedCaseInsensitiveContains(text) }
    }
    private var children: [PlaylistItem] { store.document?.children(of: parentId) ?? [] }
    private var editing: Bool { editMode == .active }
    private var cover: UIImage? { parent.flatMap { firstCover(of: $0, document: store.document, services: services) } }

    var body: some View {
        List {
            hero
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            header
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            if editing {
                EditNotice(text: "編集中です。曲は、右端のつまみ（≡）をドラッグして並べ替えます。曲を外すときは、曲の「…」から「このリストから外す」を選びます。プレイリストは、編集中でなくても、カードを長押ししてつかみ、動かして並べ替えられます。終わったら、右上のチェックを押します。")
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
            }
            ForEach(children) { list in childCard(list) }
            Button { showAdd = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        .frame(width: 68, height: 38).background(RoundedRectangle(cornerRadius: 5).fill(Theme.control))
                    Text("曲を追加").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .listRowBackground(Theme.background)
            .listRowSeparatorTint(Theme.rowLine)
            if allEntries.isEmpty { Text("曲はありません").foregroundStyle(Theme.muted).listRowBackground(Theme.background) }
            ForEach(entries) { entry in
                SongRow(entry: entry, scope: parentId, services: services, number: (allEntries.firstIndex { $0.id == entry.id } ?? 0) + 1) {
                    store.perform(["type": "remove", "playlistId": parentId, "entryId": entry.id])
                }
            }
            .onMove { source, destination in
                guard query.trimmingCharacters(in: .whitespaces).isEmpty, let move = MoveMapper.map(ids: allEntries.map(\.id), from: source, to: destination) else { return }
                store.perform(["type": "reorder", "playlistId": parentId, "entryId": move.id, "targetId": move.targetId, "after": move.after])
            }
            .moveDisabled(!query.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .environment(\.editMode, $editMode)
        .navigationTitle(parent?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                EditToggle(editing: Binding(get: { editing }, set: { editMode = $0 ? .active : .inactive }))
            }
        }
        .sheet(isPresented: $showAdd) {
            AddSongSheet(store: store, downloads: services.downloads, playlistId: parentId, playlistName: parent?.name ?? "", isPresented: $showAdd)
        }
        .sheet(isPresented: $showSave) {
            if let downloads = services.downloads {
                PlaylistSaveSheet(store: store, downloads: downloads, playlistId: parentId, playlistName: parent?.name ?? "", isPresented: $showSave)
            }
        }
        .onAppear {
            let defaults = UserDefaults.standard
            if defaults.bool(forKey: "FavecusDemoSave") { showSave = true }
            if defaults.bool(forKey: "FavecusDemoEdit") { editMode = .active }
            if defaults.bool(forKey: "FavecusDemoAdd") { showAdd = true }
        }
    }

    /// 見出し：先頭の曲のサムネイルを上に大きく、その上に、パンくずとタイトル。
    private var hero: some View {
        Theme.panel
            .frame(maxWidth: .infinity)
            .frame(height: 220)
            .overlay {
                if let cover {
                    Image(uiImage: cover).resizable().scaledToFill()
                } else {
                    Image(systemName: "music.note.list").font(.system(size: 56)).foregroundStyle(Color(hex: 0x50586F))
                }
            }
            .clipped()
            .overlay(LinearGradient(colors: [.clear, Theme.background], startPoint: .center, endPoint: .bottom))
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(breadcrumb).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    Text(parent?.name ?? "").font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.text).lineLimit(2)
                }
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
    }

    /// 「↑ 再生リスト 24」・検索・ボタン（PC版のリスト見出しと同じ並び）。
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button { dismiss() } label: { Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent).frame(width: 30, height: 30) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("ひとつ上のプレイリストへ戻る")
                Text("再生リスト").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.text)
                Text("\(allEntries.count)").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Theme.control))
                Spacer()
                if services.downloads != nil {
                    Button { showSave = true } label: { Label("保存", systemImage: "arrow.down.circle").font(.system(size: 13, weight: .semibold)) }
                        .buttonStyle(TintedButtonStyle(color: Theme.mint, fill: Color(hex: 0x1F2C2C)))
                        .accessibilityLabel("このプレイリストの曲を保存")
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.faint)
                TextField("リスト内を検索", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Theme.text)
                if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faint) }.buttonStyle(.plain) }
            }
            .font(.system(size: 14))
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.controlLine, lineWidth: 1))
            HStack(spacing: 8) {
                Button { withAnimation { editMode = editing ? .inactive : .active } } label: { Text(editing ? "並べ替えを終わる" : "並べ替え").lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryButtonStyle())
                Button { play(shuffled: true) } label: { Label("シャッフル再生", systemImage: "shuffle").lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity) }
                    .buttonStyle(TintedButtonStyle(color: Theme.accent, fill: Color(hex: 0x2A2440)))
                Button { play(shuffled: false) } label: { Label("再生", systemImage: "play.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(TintedButtonStyle(color: Theme.mint, fill: Color(hex: 0x1F2C2C)))
            }
            .font(.system(size: 13, weight: .semibold))
            .disabled(services.player == nil)
        }
    }

    /// 子のプレイリスト：幅いっぱいのカード（≡・先頭の曲のサムネイル・名前・曲数・›）。長押しでつかんで並べ替える。
    @ViewBuilder
    private func childCard(_ list: PlaylistItem) -> some View {
        let card = HStack(spacing: 12) {
            Image(systemName: "line.3.horizontal").font(.system(size: 14)).foregroundStyle(Theme.accent.opacity(0.85))
            ArtworkTile(image: firstCover(of: list, document: store.document, services: services), title: list.name, side: 56, corner: 4)
            Text(list.name).font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.text).lineLimit(1)
            Spacer(minLength: 4)
            Text("\(list.entries.count)曲").font(.system(size: 13)).foregroundStyle(Theme.muted)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(hex: 0x1C1F2B)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
        .opacity(dragging == list.id ? 0.4 : 1)
        ZStack {
            card
            NavigationLink(value: list.id) { EmptyView() }.opacity(0) // 標準の矢印は出さず、カード全体を押せるようにする
        }
        .onDrag {
            dragging = list.id
            return NSItemProvider(object: list.id as NSString)
        }
        .onDrop(of: [.text], delegate: PlaylistReorderDrop(target: list.id, siblings: children.map(\.id), dragging: $dragging) { id, target, after in
            store.perform(["type": "playlist-reorder", "playlistId": id, "targetId": target, "after": after, "parentId": parentId])
        })
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Theme.background)
    }

    /// パンくず（マイライブラリ / 親 / このリスト）。
    private var breadcrumb: String {
        var names: [String] = []
        var current: PlaylistItem? = parent
        var guardCount = 0
        while let item = current, guardCount < 20 {
            names.insert(item.name, at: 0)
            current = store.document?.playlists.first { $0.childIds.contains(item.id) }
            guardCount += 1
        }
        return (["マイライブラリ"] + names).joined(separator: " / ")
    }

    private func play(shuffled: Bool) {
        guard let player = services.player, let first = allEntries.first(where: { player.canPlay($0) }) ?? allEntries.first else { return }
        player.shuffle = shuffled
        Task { await player.play(entryId: first.id, scope: parentId) }
    }
}
