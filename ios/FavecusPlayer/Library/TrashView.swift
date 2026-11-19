import SwiftUI

/// 設定の「最近削除」。削除したプレイリスト・「このリストから外す」で外した曲を、30日間保管し、元に戻せる。
struct TrashView: View {
    @ObservedObject var store: LibraryStore
    @ObservedObject var trash: TrashStore
    @State private var confirmClear = false
    @State private var pendingDelete: TrashEntry?

    init(store: LibraryStore) {
        self.store = store
        trash = store.trash
    }

    var body: some View {
        List {
            Section {
                EmptyView()
            } footer: {
                Text("削除したプレイリストと、「このリストから外す」で外した曲を、30日間、この端末に保管します（同期はしません）。元に戻すと、元の場所へ戻り、同期している他の端末にも反映されます。")
            }
            if trash.items.isEmpty {
                Text("削除した項目は、ありません").foregroundStyle(Theme.muted)
            }
            ForEach(trash.items) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.label).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                    Text("\(item.deletedAt.formatted(date: .abbreviated, time: .omitted))に削除・残り\(item.daysLeft(now: trash.currentTime))日")
                        .font(.system(size: 12)).foregroundStyle(Theme.muted)
                    HStack(spacing: 10) {
                        Button { store.restoreFromTrash(id: item.id) } label: { Label("元に戻す", systemImage: "arrow.uturn.backward").frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryButtonStyle())
                        Button(role: .destructive) { pendingDelete = item } label: { Label("完全に削除", systemImage: "trash").frame(maxWidth: .infinity) }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("最近削除")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("すべて削除") { confirmClear = true }.disabled(trash.items.isEmpty)
            }
        }
        .confirmationDialog("保管中の項目をすべて完全に削除します。元に戻せません。", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("すべて完全に削除", role: .destructive) { trash.clear() }
            Button("キャンセル", role: .cancel) {}
        }
        .confirmationDialog("この項目を完全に削除します。元に戻せません。", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("完全に削除", role: .destructive) {
                if let target = pendingDelete { trash.remove(id: target.id) }
                pendingDelete = nil
            }
            Button("キャンセル", role: .cancel) { pendingDelete = nil }
        }
    }
}
