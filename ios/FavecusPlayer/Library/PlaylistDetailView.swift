import Combine
import SwiftUI
import UniformTypeIdentifiers

// 1つのリストのページ。LibraryViews.swift から分けたもの（動作は同じ）。

/// 1つのリストのページ：上に先頭の曲のサムネイル（左上に戻る・右上にメニュー）→ 中央にプレイリスト名 → ボタン（左：子のプレイリストを作る／右：シャッフル再生・再生。アイコンだけ）
/// → 子のプレイリスト（幅いっぱいのカード。長押しで並べ替え）→ 曲。曲の追加は、右下に浮かぶ＋ボタン（このリストへ追加）。
struct PlaylistDetail: View {
    @EnvironmentObject private var observer: ServicesObserver
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: LibraryStore
    let services: Services
    let parentId: String
    @Binding var reveal: RevealTarget?
    @State private var editMode: EditMode = .inactive
    @State private var showAdd = false
    /// 「コピーしたリンクを追加」から開いた（貼り付けたら、そのまま追加する）。クリップボードにリンクらしいものがあるときだけ、ボタンを出す。
    @State private var addFromClipboard = false
    @State private var clipboardLink = false
    @State private var showSave = false
    @State private var creatingChild = false
    @State private var childName = ""
    @State private var renaming = false
    @State private var renameText = ""
    @State private var confirmDelete = false
    @State private var confirmRemoveOffline = false
    /// 先頭の画像が、画面の上端からどれだけ動いたか（上のバーを、スクロールに合わせて濃くするため）。
    @State private var heroTop: CGFloat = 0
    @State private var dragging: String?
    /// 曲の並べ替え・絞り込み（選んでいるときだけ）。結果の曲のIDの並びは、共通JS（PC版と同じ規則）で求める。
    @State private var showView = false
    @State private var viewTick = 0
    @State private var arrangedIds: [String]?
    /// 複数の曲を選んで、まとめて操作する（移動・追加・お気に入り・保存・外す）。
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var confirmRemoveSelected = false
    /// 曲名の変更・1曲の移動/追加・URLのまとめ追加。
    @State private var renameTarget: EntryItem?
    @State private var renameSong = ""
    @State private var transfer: TransferRequest?
    @State private var showBulkAdd = false
    @State private var infoTarget: EntryItem?
    @State private var extrasRevision = 0

    private var extrasChanges: AnyPublisher<Int, Never> {
        guard let player = services.player else { return Empty(completeImmediately: false).eraseToAnyPublisher() }
        return player.$extrasRevision.eraseToAnyPublisher()
    }

    struct TransferRequest: Identifiable {
        let id = UUID()
        let entryIds: [String]
        let mode: String
    }

    private var parent: PlaylistItem? { store.document?.playlist(parentId) }
    private var entries: [EntryItem] { parent?.entries ?? [] }
    private var viewSetting: EntryViewSetting? { _ = viewTick; return services.player?.listViews.view(for: parentId) }
    /// 画面に出す曲（並べ替え・絞り込みを選んでいれば、その結果。届くまでは、保存した順）。
    private var shown: [EntryItem] {
        guard viewSetting != nil, let ids = arrangedIds else { return entries }
        var byId: [String: EntryItem] = [:]
        for entry in entries { byId[entry.id] = entry }
        return ids.compactMap { byId[$0] }
    }
    private var originalNumbers: [String: Int] {
        var result: [String: Int] = [:]
        for (index, entry) in entries.enumerated() { result[entry.id] = index + 1 }
        return result
    }
    private var children: [PlaylistItem] { store.document?.children(of: parentId) ?? [] }
    private var editing: Bool { editMode == .active }
    private var cover: UIImage? { parent.flatMap { firstCover(of: $0, document: store.document, services: services) } }

    var body: some View {
        ScrollViewReader { proxy in
        List {
            hero
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            titleBlock
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            if clipboardLink && !editing {
                Button { addFromClipboard = true; showAdd = true } label: {
                    Label("コピーしたリンクを、このリストへ追加…", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Theme.background)
            }
            if editing {
                EditNotice(text: "編集中です。曲は、右端のつまみ（≡）をドラッグして並べ替えます。曲を外すときは、曲の「…」から「このリストから外す」を選びます。プレイリストは、編集中でなくても、カードを長押ししてつかみ、動かして並べ替えられます。終わったら、右上のチェックを押します。")
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.background)
            }
            ForEach(children) { list in childCard(list) }
            if entries.isEmpty { Text("曲はありません。右下の ＋ から追加できます。").font(.system(size: 13)).foregroundStyle(Theme.muted).listRowBackground(Theme.background) }
            if viewSetting != nil {
                Text("並べ替え・絞り込みを選んでいます（\(shown.count)/\(entries.count)曲）。選んだ順で再生します。").font(.system(size: 12)).foregroundStyle(Theme.accent).listRowBackground(Theme.background)
            }
            let numbers = originalNumbers
            ForEach(shown) { entry in
                HStack(spacing: 8) {
                    if selecting {
                        Image(systemName: selection.contains(entry.id) ? "checkmark.circle.fill" : "circle").font(.system(size: 20)).foregroundStyle(selection.contains(entry.id) ? Theme.accent : Theme.faint)
                    }
                    SongRow(entry: entry, scope: parentId, services: services, number: numbers[entry.id], onRemove: {
                        store.perform(["type": "remove", "playlistId": parentId, "entryId": entry.id])
                    }, extra: selecting ? [] : songActions(entry))
                    .allowsHitTesting(!selecting) // 選んでいる間は、行を押すと、選ぶ・外すだけ（再生しない）
                }
                .overlay { if selecting { Color.clear.contentShape(Rectangle()).onTapGesture { toggle(entry.id) } } }
            }
            .onMove(perform: viewSetting != nil ? nil : moveEntries)
            Color.clear.frame(height: 90).listRowBackground(Theme.background).listRowSeparator(.hidden) // 右下の＋ボタンと再生バーに隠れないための余白
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .ignoresSafeArea(edges: .top)
        .onAppear { scrollToRevealed(proxy) }
        .task(id: ArrangeKey(view: viewSetting, entries: entries, revision: extrasRevision)) {
            guard let view = viewSetting, let player = services.player else { arrangedIds = nil; return }
            arrangedIds = await player.arrangedIds(forEntries: entries, view: view)
        }
        .onReceive(extrasChanges) { extrasRevision = $0 }
        .sheet(isPresented: $showView) {
            EntryViewSheet(initial: viewSetting ?? EntryViewSetting()) { next in
                services.player?.listViews.set(next, for: parentId)
                arrangedIds = nil
                viewTick += 1
                Task { await services.player?.onListViewChanged(playlistId: parentId) }
            }
        }
        .safeAreaInset(edge: .bottom) { if selecting { bulkBar } }
        .sheet(item: $transfer) { request in
            PlaylistPickerSheet(document: store.document, exclude: [parentId], title: request.mode == "move" ? "移動先のリスト" : "追加先のリスト", actionLabel: request.mode == "move" ? "移動する" : "追加する") { destinations in
                store.perform(["type": "entries-transfer", "playlistId": parentId, "entryIds": request.entryIds, "destinationIds": destinations, "mode": request.mode])
                selection = []
                if request.mode == "move" { selecting = false }
            }
        }
        .sheet(item: $infoTarget) { entry in
            if let player = services.player { SongInfoSheet(player: player, entry: entry) }
        }
        .sheet(isPresented: $showBulkAdd) {
            BulkAddSheet(store: store, downloads: services.downloads, playlistId: parentId, playlistName: parent?.name ?? "", isPresented: $showBulkAdd)
        }
        .alert("曲名を変更", isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })) {
            TextField("曲名", text: $renameSong)
            Button("保存") {
                if let target = renameTarget { store.perform(["type": "title", "playlistId": parentId, "entryId": target.id, "title": renameSong.trimmingCharacters(in: .whitespacesAndNewlines)]) }
                renameTarget = nil
            }
            Button("キャンセル", role: .cancel) { renameTarget = nil }
        } message: { Text("このリストでの曲名です。空にすると、動画IDの名前になります。") }
        .confirmationDialog("選んだ\(selection.count)曲を、このリストから外します。「最近削除」から、30日間、元に戻せます。", isPresented: $confirmRemoveSelected, titleVisibility: .visible) {
            Button("外す", role: .destructive) {
                store.perform(["type": "remove-many", "playlistId": parentId, "entryIds": Array(selection)])
                selection = []; selecting = false
            }
            Button("キャンセル", role: .cancel) {}
        }
        .onChange(of: reveal) { _ in scrollToRevealed(proxy) }
        .onDrop(of: [.text], delegate: ClearDrag(dragging: $dragging))
        .environment(\.editMode, $editMode)
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler()) // ナビゲーションバーを隠しても、画面の端からのスワイプで戻れるようにする
        .onPreferenceChange(HeroTopKey.self) { heroTop = $0 }
        .overlay(alignment: .top) { pinnedBar } // 上のメニューは、スクロールしても常に表示する
        .overlay(alignment: .bottomTrailing) {
            if !selecting { AddSongButton(player: services.player) { showAdd = true } } // 曲を選んでいる間は、操作欄と重なるため隠す
        }
        .sheet(isPresented: $showAdd, onDismiss: {
            addFromClipboard = false
            Task { clipboardLink = await ClipboardLink.pasteboardHasLink() }
        }) {
            AddSongSheet(store: store, downloads: services.downloads, playlistId: parentId, playlistName: parent?.name ?? "", isPresented: $showAdd, startWithPaste: addFromClipboard)
        }
        .task { clipboardLink = await ClipboardLink.pasteboardHasLink() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { clipboardLink = await ClipboardLink.pasteboardHasLink() }
        }
        .sheet(isPresented: $showSave) {
            if let downloads = services.downloads {
                PlaylistSaveSheet(store: store, downloads: downloads, playlistId: parentId, playlistName: parent?.name ?? "", isPresented: $showSave)
            }
        }
        .alert("子のプレイリストを作る", isPresented: $creatingChild) {
            TextField("名前", text: $childName)
            Button("作成") { store.perform(["type": "create", "name": childName, "parentId": parentId, "select": false]) }
            Button("キャンセル", role: .cancel) {}
        }
        .alert("名前を変更", isPresented: $renaming) {
            TextField("名前", text: $renameText)
            Button("変更") { store.perform(["type": "rename", "playlistId": parentId, "name": renameText]) }
            Button("キャンセル", role: .cancel) {}
        }
        .confirmationDialog(offlineRemovalTitle, isPresented: $confirmRemoveOffline, titleVisibility: .visible) {
            Button("削除", role: .destructive) {
                let keys = offlineTarget.keys
                Task {
                    if let current = services.player?.current, entries.contains(where: { $0.id == current.entryId }) { services.player?.stop() }
                    _ = await services.downloads?.removeOffline(keys: keys)
                }
            }
            Button("キャンセル", role: .cancel) {}
        }
        .confirmationDialog("このプレイリストを削除", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) {
                store.perform(["type": "delete", "playlistId": parentId])
                dismiss()
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("「\(parent?.name ?? "")」を削除します。曲はこのリストから消え、子のプレイリストは1つ上へ移ります。")
        }
        .onAppear {
            let defaults = UserDefaults.standard
            if defaults.bool(forKey: "FavecusDemoEdit") { editMode = .active }
            if defaults.bool(forKey: "FavecusDemoAdd") { showAdd = true }
            if defaults.bool(forKey: "FavecusDemoSave") { showSave = true }
            if defaults.bool(forKey: "FavecusDemoSelect") { selecting = true; selection = Set(entries.prefix(2).map(\.id)) }
            if defaults.bool(forKey: "FavecusDemoView") { showView = true }
            if defaults.bool(forKey: "FavecusDemoInfo") { infoTarget = entries.first }
            if defaults.bool(forKey: "FavecusDemoBulkAdd") { showBulkAdd = true }
        }
        } // ScrollViewReader
    }

    /// このリストの曲のうち、ほかのリストが使っていない保存済みの動画（オフライン用データの削除の対象）。
    private var offlineTarget: (keys: [String], shared: Int) {
        let all = store.document?.playlists.flatMap(\.entries) ?? []
        return DownloadService.exclusiveKeys(target: entries, all: all) { services.downloads?.entryKeys[$0.id] }
    }

    private var offlineRemovalTitle: String {
        let target = offlineTarget
        let saved = services.downloads?.savedSummary(keys: target.keys) ?? (0, 0)
        if saved.0 == 0 { return "このプレイリストに、削除できるオフライン用データはありません。" + (target.shared > 0 ? "（他のプレイリストにもある動画 \(target.shared)件は、削除の対象外です）" : "") }
        let size = ByteCountFormatter.string(fromByteCount: saved.1, countStyle: .file)
        let sharedNote = target.shared > 0 ? "他のプレイリストにもある動画 \(target.shared)件は、残します。" : ""
        return "「\(parent?.name ?? "")」の保存した音声・動画 \(saved.0)件（\(size)）を、この端末から削除します。曲は消えません。\(sharedNote)元に戻せません。"
    }

    /// 再生画面から曲の位置を指定されたとき、このリストの曲まで動かす（画面が出そろってから）。ほかのリストの指定は、何もしない。
    private func scrollToRevealed(_ proxy: ScrollViewProxy) {
        guard let target = reveal, target.listId == parentId else { return }
        guard let entryId = target.entryId, entries.contains(where: { $0.id == entryId }) else { reveal = nil; return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            withAnimation { proxy.scrollTo(entryId, anchor: .center) }
            reveal = nil
        }
    }

    // MARK: 上の部分

    /// 先頭の曲のサムネイルを大きく。左上に戻る、右上にメニュー（編集中は終わるチェック）。
    private var hero: some View {
        Theme.panel
            .frame(maxWidth: .infinity)
            .frame(height: 260 + Self.topInset)
            .overlay {
                if let cover {
                    Image(uiImage: cover).resizable().scaledToFill()
                } else {
                    Image(systemName: "music.note.list").font(.system(size: 56)).foregroundStyle(Color(hex: 0x50586F))
                }
            }
            .clipped()
            .overlay(LinearGradient(colors: [.black.opacity(0.35), .clear, Theme.background], startPoint: .top, endPoint: .bottom))
            .background(GeometryReader { Color.clear.preference(key: HeroTopKey.self, value: $0.frame(in: .global).minY) })
    }

    /// 上に固定するバー：戻る・（スクロールすると）題名・再生・メニュー（編集中は終わるチェック）。スクロールするほど背景が濃くなる。
    private var pinnedBar: some View {
        let progress = min(1, max(0, (-heroTop - 120) / 100))
        return HStack(spacing: 10) {
            circle("chevron.left", label: "ひとつ前へ戻る") { dismiss() }
            Text(parent?.name ?? "").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.text).lineLimit(1).opacity(progress)
            Spacer(minLength: 0)
            if editing {
                circle("checkmark", label: "編集を終わる") { withAnimation { editMode = .inactive } }
            } else {
                if progress > 0.5 {
                    circle("play.fill", label: "再生") { play(shuffled: false) }
                        .disabled(services.player == nil)
                }
                menuButton
            }
        }
        .padding(.horizontal, 12).padding(.top, Self.topInset + 8).padding(.bottom, 6)
        .background(Theme.background.opacity(progress).ignoresSafeArea(edges: .top))
    }

    private var menuButton: some View {
                        Menu {
                            Button { withAnimation { editMode = .active } } label: { Label("編集（曲の並べ替え・削除）", systemImage: "pencil") }
                            Button { withAnimation { selecting.toggle(); selection = [] } } label: { Label(selecting ? "選択を終わる" : "曲を選ぶ", systemImage: selecting ? "checkmark.circle" : "checkmark.circle.badge.questionmark") }
                            Button { showBulkAdd = true } label: { Label("URLをまとめて追加", systemImage: "link.badge.plus") }
                            Button { showView = true } label: { Label(viewSetting != nil ? "曲の並べ替え・絞り込み（選択中）" : "曲の並べ替え・絞り込み", systemImage: "line.3.horizontal.decrease.circle") }
                            if services.downloads != nil { Button { showSave = true } label: { Label("このプレイリストの曲を保存", systemImage: "arrow.down.circle") } }
                            if services.downloads != nil { Button { Task { await services.downloads?.ensureFrames(entries: entries) } } label: { Label("サムネイルを取得", systemImage: "photo") } }
                            if services.downloads != nil { Button { confirmRemoveOffline = true } label: { Label("このプレイリストのオフライン用データを削除", systemImage: "trash.slash") } }
                            Button { renameText = parent?.name ?? ""; renaming = true } label: { Label("名前を変更", systemImage: "textformat") }
                            Button(role: .destructive) { confirmDelete = true } label: { Label("プレイリストを削除", systemImage: "trash") }
                        } label: {
                            Image(systemName: "ellipsis").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 44, height: 44).background(Circle().fill(Color.black.opacity(0.45)))
                        }
                        .accessibilityLabel("メニュー")
    }

    /// 画面上端の安全領域（ステータスバーの高さ）。見出しの画像を、画面の上端まで広げるために使う。
    private static var topInset: CGFloat {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets.top ?? 0
    }

    private func circle(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                .frame(width: 44, height: 44).background(Circle().fill(Color.black.opacity(0.45)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// 中央にプレイリスト名、その下に、ボタン（アイコンだけ）。
    private var titleBlock: some View {
        VStack(spacing: 12) {
            Text(parent?.name ?? "").font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.text).multilineTextAlignment(.center).lineLimit(2)
            Text("\(entries.count)曲" + (children.isEmpty ? "" : " ・ 子のプレイリスト \(children.count)")).font(.system(size: 12)).foregroundStyle(Theme.muted)
            HStack(spacing: 12) {
                Button { childName = ""; creatingChild = true } label: {
                    Image(systemName: "folder.badge.plus").font(.system(size: 18)).foregroundStyle(Theme.text)
                        .frame(width: 48, height: 48).background(Circle().fill(Theme.control)).overlay(Circle().stroke(Theme.controlLine, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("子のプレイリストを作る")
                Spacer()
                Button { play(shuffled: true) } label: {
                    Image(systemName: "shuffle").font(.system(size: 18)).foregroundStyle(Theme.accent)
                        .frame(width: 48, height: 48).background(Circle().fill(Color(hex: 0x2A2440))).overlay(Circle().stroke(Theme.accent.opacity(0.45), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("シャッフル再生")
                Button { play(shuffled: false) } label: {
                    Image(systemName: "play.fill").font(.system(size: 24)).foregroundStyle(.black)
                        .frame(width: 64, height: 64).background(Circle().fill(Color.white))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("再生")
            }
            .disabled(services.player == nil)
        }
        .frame(maxWidth: .infinity)
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

    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }

    private var selectedEntries: [EntryItem] { shown.filter { selection.contains($0.id) } }

    /// 曲の操作に足す項目：曲名の変更・別のリストへ移動/追加。
    private func songActions(_ entry: EntryItem) -> [RowAction] {
        [RowAction(icon: "pencil", title: "曲名を変更") { renameSong = entry.title; renameTarget = entry },
         RowAction(icon: "person.text.rectangle", title: "曲の情報（アーティスト・タグ・メモ・チャプター）") { infoTarget = entry },
         RowAction(icon: "arrow.right.circle", title: "別のリストへ移動") { transfer = TransferRequest(entryIds: [entry.id], mode: "move") },
         RowAction(icon: "plus.circle", title: "別のリストへ追加") { transfer = TransferRequest(entryIds: [entry.id], mode: "copy") }]
    }

    /// 選んだ曲の操作（画面の下）。
    private var bulkBar: some View {
        VStack(spacing: 6) {
            HStack {
                Text("\(selection.count)曲を選択中").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accent)
                Spacer()
                Button(selection.count == shown.count ? "選びなおす" : "すべて選ぶ") { selection = selection.count == shown.count ? [] : Set(shown.map(\.id)) }.font(.system(size: 13))
            }
            HStack(spacing: 0) {
                barButton("arrow.right.circle", "移動") { transfer = TransferRequest(entryIds: Array(selection), mode: "move") }
                barButton("plus.circle", "追加") { transfer = TransferRequest(entryIds: Array(selection), mode: "copy") }
                barButton("heart", "お気に入り") { let items = selectedEntries; Task { await services.player?.setFavorites(entries: items, true) } }
                barButton("heart.slash", "外す") { let items = selectedEntries; Task { await services.player?.setFavorites(entries: items, false) } }
                if services.downloads != nil { barButton("arrow.down.circle", "保存") { services.downloads?.saveAll(entries: selectedEntries.filter { $0.type == "bilibili" }, kind: "audio") } }
                barButton("minus.circle", "リストから", destructive: true) { confirmRemoveSelected = true }
            }
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
        .background(.ultraThinMaterial)
    }

    private func barButton(_ icon: String, _ label: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon).font(.system(size: 18))
                Text(label).font(.system(size: 10))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(destructive ? Theme.warning : Theme.text)
        }
        .disabled(selection.isEmpty)
    }

    /// 手動の並べ替え（保存した順。並べ替え・絞り込みを選んでいる間は、使えない）。
    private func moveEntries(_ source: IndexSet, _ destination: Int) {
        guard let move = MoveMapper.map(ids: entries.map(\.id), from: source, to: destination) else { return }
        store.perform(["type": "reorder", "playlistId": parentId, "entryId": move.id, "targetId": move.targetId, "after": move.after])
    }

    private func firstPlayableEntry(player: PlaybackEngine) -> EntryItem? {
        if let direct = shown.first(where: { player.canPlay($0) }) { return direct }
        guard let document = store.document else { return shown.first }
        var visited: Set<String> = [parentId]
        var fallback: EntryItem?
        func search(_ listId: String) -> EntryItem? {
            guard visited.insert(listId).inserted, let list = document.playlist(listId) else { return nil }
            if let playable = list.entries.first(where: { player.canPlay($0) }) { return playable }
            if fallback == nil, let any = list.entries.first { fallback = any }
            for childId in list.childIds {
                if let found = search(childId) { return found }
            }
            return nil
        }
        for childId in parent?.childIds ?? [] {
            if let found = search(childId) { return found }
        }
        return shown.first ?? fallback
    }

    private func play(shuffled: Bool) {
        guard let player = services.player else { return }
        if shuffled {
            // 最初の曲も、再生範囲の中からランダムに選ぶ（先頭の曲に固定しない）
            OpenPlayer.request()
            Task { await player.play(entryId: nil, scope: parentId) }
            return
        }
        guard let first = firstPlayableEntry(player: player) else { return }
        player.setShuffle(false)
        OpenPlayer.request()
        Task { await player.play(entryId: first.id, scope: parentId) }
    }
}
