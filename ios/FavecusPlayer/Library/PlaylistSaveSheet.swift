import SwiftUI

/// プレイリスト単位の保存：このリスト（と、選べば子のプレイリスト）のBilibiliの曲を、音声または動画でまとめて保存する。
/// 曲は1つずつ、間隔をあけて始め、保存済み・保存中の曲は飛ばす。拒否・制限（ログイン要・混雑など）が出たら、そこで止めて知らせる（回避しない）。
struct PlaylistSaveSheet: View {
    @ObservedObject var store: LibraryStore
    @ObservedObject var downloads: DownloadService
    let playlistId: String
    let playlistName: String
    @Binding var isPresented: Bool
    @State private var kind = "audio"
    @State private var includeChildren = false

    private var document: LibraryDocument? { store.document }
    private var hasChildren: Bool { !(document?.children(of: playlistId).isEmpty ?? true) }

    /// 対象の曲（このリスト、または子孫を含む）。同じ曲は1回だけ。
    private var targets: [EntryItem] {
        var result: [EntryItem] = []
        var seen = Set<String>()
        func visit(_ id: String, depth: Int) {
            guard let list = document?.playlist(id) else { return }
            for entry in list.entries where entry.type == "bilibili" && seen.insert(entry.id).inserted { result.append(entry) }
            if includeChildren && depth < 8 { for child in document?.children(of: id) ?? [] { visit(child.id, depth: depth + 1) } }
        }
        visit(playlistId, depth: 0)
        return result
    }

    private func isSaved(_ entry: EntryItem) -> Bool {
        guard let key = downloads.entryKeys[entry.id] else { return false }
        return downloads.record(key: key, kind: kind)?.state == .completed
    }

    var body: some View {
        let all = targets
        let pending = all.filter { !isSaved($0) }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("保存するプレイリスト：\(playlistName)").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    Picker("保存する形式", selection: $kind) {
                        Text("音声").tag("audio")
                        Text("動画").tag("video")
                    }
                    .pickerStyle(.segmented)
                    if hasChildren {
                        Toggle("子のプレイリストの曲も含める", isOn: $includeChildren).tint(Theme.accent).foregroundStyle(Theme.text)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("対象：Bilibiliの曲 \(all.count)曲").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        Text("保存済み \(all.count - pending.count)曲は飛ばし、未保存の \(pending.count)曲を保存します。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                    if let batch = downloads.batch {
                        VStack(alignment: .leading, spacing: 6) {
                            ProgressView(value: Double(batch.done), total: Double(max(batch.total, 1))).tint(Theme.accent)
                            Text("\(batch.done)/\(batch.total)曲を開始しました。保存は、画面を閉じても続きます。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                        Button("まとめての保存を取り消す") { downloads.cancelAll(entries: all, kind: kind) }.buttonStyle(SecondaryButtonStyle())
                    } else {
                        Button { downloads.saveAll(entries: pending, kind: kind) } label: {
                            Label(kind == "video" ? "動画を保存する（\(pending.count)曲）" : "音声を保存する（\(pending.count)曲）", systemImage: "arrow.down.circle").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(pending.isEmpty)
                        .opacity(pending.isEmpty ? 0.4 : 1)
                    }
                    if let message = downloads.message {
                        Text(message).font(.system(size: 13)).foregroundStyle(Theme.warning)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("曲は1つずつ、間隔をあけて始めます。ログインが必要・混雑・配信先の拒否が出たときは、そこで止めて知らせます（回避はしません）。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        Text("保存の進み具合は、「保存」タブで見られます。モバイル通信で保存したくないときは、「保存」タブの「Wi-Fiのときだけ保存する」をオンにします。").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationTitle("プレイリストを保存")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } } }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }
}
