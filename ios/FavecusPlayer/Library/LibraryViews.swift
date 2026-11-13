import SwiftUI
import UniformTypeIdentifiers

/// 仮の最小画面（Step8）。最終的な画面はStep15でユーザーのUI案に沿って置き換える。
/// 表示・編集の規則はここに持たず、操作は LibraryStore.perform（共通JS）へ渡すだけ。
struct LibraryRootView: View {
    @ObservedObject var store: LibraryStore
    let importer: ImportCoordinator?
    let exporter: ExportCoordinator?
    @State private var showDiagnostics = false
    @State private var showPicker = false
    @State private var showImport = false
    @State private var showExport = false
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                switch store.state {
                case .loading:
                    ProgressView("読み込み中…")
                case .blocked(let message):
                    BlockedView(message: message)
                case .ready:
                    PlaylistPage(store: store, parentId: nil)
                }
            }
            .navigationDestination(for: String.self) { id in
                PlaylistPage(store: store, parentId: id)
            }
            .toolbar {
                ToolbarItemGroup(placement: .navigationBarLeading) {
                    Button("診断") { showDiagnostics = true }
                    if importer != nil, store.isReady { Button("取り込み") { showPicker = true } }
                    if exporter != nil, store.isReady { Button("出力") { showExport = true } }
                }
            }
        }
        .task {
            await store.load()
            // 画面確認用（シミュレーターのスクリーンショット）：起動引数 -FavecusDemoPath <ID,ID...> で、指定の階層まで開く。通常の起動では何もしない。
            if let raw = UserDefaults.standard.string(forKey: "FavecusDemoPath"), path.isEmpty {
                for id in raw.split(separator: ",") { path.append(String(id)) }
            }
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
        .sheet(isPresented: $showExport) {
            if let exporter { ExportSheet(coordinator: exporter, isPresented: $showExport) }
        }
        .sheet(isPresented: $showImport) {
            if let importer { ImportSheet(coordinator: importer, isPresented: $showImport) }
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

/// 親（nilなら最上位）の子リストと、そのリストの曲を表示・編集する1ページ。
private struct PlaylistPage: View {
    @ObservedObject var store: LibraryStore
    let parentId: String?

    @State private var creating = false
    @State private var newName = ""
    @State private var renaming: PlaylistItem?
    @State private var renameText = ""
    @State private var pendingDelete: PlaylistItem?

    private var document: LibraryDocument? { store.document }
    private var parent: PlaylistItem? { parentId.flatMap { document?.playlist($0) } }
    private var children: [PlaylistItem] { document?.children(of: parentId) ?? [] }
    private var entries: [EntryItem] { parent?.entries ?? [] }

    var body: some View {
        List {
            Section("プレイリスト") {
                if children.isEmpty { Text("子のプレイリストはありません").foregroundStyle(.secondary) }
                ForEach(children) { list in
                    NavigationLink(value: list.id) {
                        VStack(alignment: .leading) {
                            Text(list.name)
                            Text("\(list.entries.count)曲・子 \(list.childIds.count)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button("名前") { renaming = list; renameText = list.name }.tint(.blue)
                    }
                }
                .onDelete { offsets in
                    if let index = offsets.first { pendingDelete = children[index] }
                }
                .onMove { source, destination in
                    guard let move = MoveMapper.map(ids: children.map(\.id), from: source, to: destination) else { return }
                    var action: [String: Any] = ["type": "playlist-reorder", "playlistId": move.id, "targetId": move.targetId, "after": move.after]
                    if let parentId { action["parentId"] = parentId }
                    store.perform(action)
                }
            }
            if let parent {
                Section("曲") {
                    if entries.isEmpty { Text("曲はありません").foregroundStyle(.secondary) }
                    ForEach(entries) { entry in
                        Text(entry.title.isEmpty ? "（無題）" : entry.title)
                    }
                    .onDelete { offsets in
                        for index in offsets {
                            store.perform(["type": "remove", "playlistId": parent.id, "entryId": entries[index].id])
                        }
                    }
                    .onMove { source, destination in
                        guard let move = MoveMapper.map(ids: entries.map(\.id), from: source, to: destination) else { return }
                        store.perform(["type": "reorder", "playlistId": parent.id, "entryId": move.id, "targetId": move.targetId, "after": move.after])
                    }
                }
            }
        }
        .navigationTitle(parent?.name ?? "プレイリスト")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                EditButton()
                Button { newName = ""; creating = true } label: { Image(systemName: "plus") }
            }
        }
        .alert("新しいプレイリスト", isPresented: $creating) {
            TextField("名前", text: $newName)
            Button("作成") {
                var action: [String: Any] = ["type": "create", "name": newName, "select": false]
                if let parentId { action["parentId"] = parentId }
                store.perform(action)
            }
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
}
