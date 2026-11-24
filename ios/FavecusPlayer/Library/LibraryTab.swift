import SwiftUI
import UniformTypeIdentifiers

// ライブラリのタブ（ホームのカード・検索・自動リスト）。LibraryViews.swift から分けたもの（動作は同じ）。

struct LibraryTab: View {
    @EnvironmentObject private var observer: ServicesObserver // 保存の状態・サムネイルが変わったら描き直す
    @ObservedObject var store: LibraryStore
    let services: Services
    @Binding var path: NavigationPath
    @Binding var showPlayer: Bool
    @Binding var reveal: RevealTarget?
    @State private var editing = false
    @State private var creating = false
    @State private var newName = ""
    @State private var renaming: PlaylistItem?
    @State private var renameText = ""
    @State private var pendingDelete: PlaylistItem?
    @State private var dragging: String?
    @State private var query = ""
    @State private var hits: [LibrarySearchHit] = []
    @State private var hitTotal = 0
    @State private var hitPage = 0
    @State private var hitPages = 1
    @State private var searchGeneration = 0
    @State private var loadMoreTask: Task<Void, Never>?

    private var document: LibraryDocument? { store.document }
    private var roots: [PlaylistItem] { document?.children(of: nil) ?? [] }
    private var songCount: Int {
        var seen = Set<String>()
        for list in document?.playlists ?? [] { for entry in list.entries { seen.insert(entry.id) } }
        return seen.count
    }
    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// 検索の結果（所属ごとに1行）。規則は共通の処理（50件ごと）。再生は、その行のリストの範囲で行う。
    private var results: [(entry: EntryItem, list: PlaylistItem, key: String)] {
        guard !trimmedQuery.isEmpty else { return [] }
        guard services.player != nil else { return fallbackResults }
        var lists: [String: PlaylistItem] = [:]
        for list in document?.playlists ?? [] { lists[list.id] = list }
        return hits.compactMap { hit in
            guard let list = lists[hit.playlistId], let entry = list.entries.first(where: { $0.id == hit.entryId }) else { return nil }
            return (entry, list, hit.playlistId + "/" + hit.entryId)
        }
    }

    /// 検索の入力・ライブラリの変化で、先頭の50件を取り直す（入力が続く間は待つ）。
    private func runSearch(page: Int) async {
        if page == 0 {
            loadMoreTask?.cancel()
            loadMoreTask = nil
            searchGeneration += 1
        }
        let mine = searchGeneration
        let targetQuery = trimmedQuery
        guard !targetQuery.isEmpty, let player = services.player else { hits = []; hitTotal = 0; hitPage = 0; hitPages = 1; return }
        if page == 0 { try? await Task.sleep(nanoseconds: 200_000_000); if Task.isCancelled || mine != searchGeneration || targetQuery != trimmedQuery { return } }
        guard let result = await player.search(query: targetQuery, page: page), !Task.isCancelled, mine == searchGeneration, targetQuery == trimmedQuery else { return }
        hits = page == 0 ? result.items : hits + result.items
        hitTotal = result.total; hitPage = result.page; hitPages = result.pages
    }

    /// 曲の再生の準備がない画面確認用の、簡易な検索。
    private var fallbackResults: [(entry: EntryItem, list: PlaylistItem, key: String)] {
        var found: [(EntryItem, PlaylistItem, String)] = []
        for list in document?.playlists ?? [] {
            let listMatches = list.name.localizedStandardContains(trimmedQuery)
            for entry in list.entries where listMatches || entry.title.localizedStandardContains(trimmedQuery) || (entry.videoId ?? "").localizedCaseInsensitiveContains(trimmedQuery) || (entry.url ?? "").localizedCaseInsensitiveContains(trimmedQuery) {
                found.append((entry, list, list.id + "/" + entry.id))
                if found.count >= 100 { return found }
            }
        }
        return found
    }

    /// HOME：プレイリストのカード（3列）。1枚ずつ長押しでつかめる。
    private var homeContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    SectionLabel(text: "ホーム")
                    Text("\(songCount)曲").font(.system(size: 12)).foregroundStyle(Theme.mint)
                }
                .padding(.horizontal, 16).padding(.top, 4)
                if editing {
                    EditNotice(text: "編集中です。各カードの ✎ で名前を変更、ごみ箱で削除します。並べ替えは、編集中でなくても、カードを長押ししてつかみ、動かしたい場所のカードの上で離します。終わったら、右上のチェックを押します。")
                        .padding(.horizontal, 16).padding(.vertical, 4)
                }
                if roots.isEmpty {
                    Text("プレイリストはありません。上の「新規プレイリスト」から作れます。").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                }
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(Array(roots.enumerated()), id: \.element.id) { index, list in
                        card(list, index: index)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8)
                // 自分のプレイリストの下：自動リスト（保存せず、その都度作る。曲の選び方は共通JS）
                AutoListsSection(store: store, services: services)
                    .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 90)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
        .onDrop(of: [.text], delegate: ClearDrag(dragging: $dragging))
    }

    private var searchResults: some View {
        List {
            HStack(spacing: 8) {
                SectionLabel(text: "検索結果")
                Text("\(services.player == nil ? results.count : hitTotal)件").font(.system(size: 12)).foregroundStyle(Theme.mint)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.background)
            if results.isEmpty { Text("見つかりませんでした").font(.system(size: 13)).foregroundStyle(Theme.muted).listRowBackground(Theme.background) }
            ForEach(results, id: \.key) { item in
                SongRow(entry: item.entry, scope: item.list.id, services: services, context: item.list.name)
            }
            if services.player != nil, hitPage + 1 < hitPages {
                Button("さらに表示") {
                    loadMoreTask?.cancel()
                    loadMoreTask = Task { await runSearch(page: hitPage + 1) }
                }
                .listRowBackground(Theme.background)
            }
            Color.clear.frame(height: 80).listRowBackground(Theme.background).listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .task(id: SearchTrigger(query: trimmedQuery, document: document)) { await runSearch(page: 0) }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
    }

    var body: some View {
        NavigationStack(path: $path) {
            // 検索欄と「新規プレイリスト」は固定（入力中に、下の表示が切り替わっても、入力が途切れないように）。
            // HOMEのカードは、Listの1行にまとめず、ScrollViewへ置く（Listだと、横並びの3枚が1つの行として、まとめて持ち上がってしまう）。検索結果は、行ごとの操作があるためListのまま。
            VStack(spacing: 0) {
                SearchField(text: $query)
                    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
                Button { newName = ""; creating = true } label: {
                    Label("新規プレイリスト", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
                if trimmedQuery.isEmpty { homeContent } else { searchResults }
            }
            .background(Theme.background)
            .navigationTitle("マイライブラリ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { EditToggle(editing: $editing) } }
            .navigationDestination(for: String.self) { id in
                PlaylistDetail(store: store, services: services, parentId: id, reveal: $reveal)
            }
            .navigationDestination(for: AutoListKind.self) { kind in
                AutoListDetail(kind: kind, store: store, services: services)
            }
            .alert("新しいプレイリスト", isPresented: $creating) {
                TextField("名前", text: $newName)
                Button("作成") { store.perform(["type": "create", "name": newName, "select": false]) }
                Button("キャンセル", role: .cancel) {}
            }
            .alert("名前を変更", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { item in
                TextField("名前", text: $renameText)
                Button("変更") { store.perform(["type": "rename", "playlistId": item.id, "name": renameText]) }
                Button("キャンセル", role: .cancel) {}
            }
            .confirmationDialog("プレイリストを削除", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { item in
                Button("削除", role: .destructive) { store.perform(["type": "delete", "playlistId": item.id]) }
                Button("キャンセル", role: .cancel) {}
            } message: { item in
                Text("「\(item.name)」を削除します。曲はこのリストから消え、子のプレイリストは1つ上へ移ります。")
            }
        }
        .miniPlayer(services, showPlayer: $showPlayer)
        .onAppear {
            let defaults = UserDefaults.standard
            if defaults.bool(forKey: "FavecusDemoHomeEdit") { editing = true }
            if let text = defaults.string(forKey: "FavecusDemoSearch") { query = text }
        }
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
                Button { path.append(list.id) } label: { face }.buttonStyle(.plain)
            }
        }
        .opacity(dragging == list.id ? 0.4 : 1)
        .contentShape(.dragPreview, RoundedRectangle(cornerRadius: 10)) // つかんだときに浮かぶ像は、このカード1枚だけ
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
            Image(systemName: icon).font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                .frame(width: 32, height: 32).background(Circle().fill(Color.black.opacity(0.65)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
    }
}
