import SwiftUI

/// 移動・追加先のプレイリストを選ぶ（複数選べる。親子の階層を字下げで示す）。複数選択の一括操作・1曲の移動/追加に使う。
struct PlaylistPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let document: LibraryDocument?
    let exclude: Set<String>
    let title: String
    let actionLabel: String
    let onPick: ([String]) -> Void
    @State private var selected: Set<String> = []

    private struct Row: Identifiable { let id: String; let name: String; let depth: Int }

    private var rows: [Row] {
        guard let document else { return [] }
        var result: [Row] = [], seen = Set<String>()
        func visit(_ id: String, _ depth: Int) {
            guard seen.insert(id).inserted, let list = document.playlist(id) else { return }
            result.append(Row(id: id, name: list.name, depth: depth))
            for child in list.childIds { visit(child, depth + 1) }
        }
        for id in document.rootPlaylistIds { visit(id, 0) }
        return result
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(rows) { row in
                    let disabled = exclude.contains(row.id)
                    Button {
                        if selected.contains(row.id) { selected.remove(row.id) } else { selected.insert(row.id) }
                    } label: {
                        HStack {
                            Image(systemName: selected.contains(row.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selected.contains(row.id) ? Theme.accent : Theme.faint)
                            Text(row.name).foregroundStyle(disabled ? Theme.faint : Theme.text).lineLimit(1)
                            Spacer()
                        }
                        .padding(.leading, CGFloat(row.depth) * 18)
                        .contentShape(Rectangle())
                    }
                    .disabled(disabled)
                    .listRowBackground(Theme.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionLabel) { onPick(rows.map(\.id).filter { selected.contains($0) }); dismiss() }.disabled(selected.isEmpty)
                }
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
    }
}

/// URLをまとめて追加（1行に1つ。最大100件）。Bilibiliの動画だけ。曲名は、1件ずつ取得する（続けて大量の要求を送らない。拒否・制限が出たら、取得は止め、動画IDの名前で追加を続ける）。
struct BulkAddSheet: View {
    @ObservedObject var store: LibraryStore
    let downloads: DownloadService?
    let playlistId: String
    let playlistName: String
    @Binding var isPresented: Bool
    @State private var text = ""
    @State private var working = false
    @State private var progress = ""
    @State private var result: String?

    static let maxLinks = 100

    /// 入力から、動画のURLを取り出す（空行・重複は除く。上限を超えた分は含めない）。
    static func links(in text: String) -> [String] {
        var seen = Set<String>(), result: [String] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            result.append(trimmed)
            if result.count >= maxLinks { break }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("追加先：\(playlistName)").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    TextEditor(text: $text).frame(minHeight: 160).font(.system(size: 13)).autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: { SectionLabel(text: "Bilibiliの動画のURL（1行に1つ）") }
                footer: { Text("最大\(Self.maxLinks)件。同じ動画がこのリストにすでにあれば、追加しません。BV番号だけでも追加できます。") }
                Section {
                    Button { add() } label: {
                        HStack { Spacer(); if working { ProgressView() } else { Label("まとめて追加", systemImage: "plus") }; Spacer() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working || Self.links(in: text).isEmpty)
                    .listRowBackground(Color.clear)
                    if working { Text(progress).font(.footnote).foregroundStyle(Theme.muted) }
                    if let result { Text(result).font(.footnote).foregroundStyle(Theme.accent) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("URLをまとめて追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false }.disabled(working) } }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(working)
    }

    private func add() {
        let links = Self.links(in: text)
        guard !links.isEmpty else { return }
        working = true
        result = nil
        Task {
            var added = 0, skipped = 0, noTitle = 0, askTitles = downloads != nil
            for (index, link) in links.enumerated() {
                progress = "\(index + 1)/\(links.count)を追加しています…"
                var title = "", duration = 0.0
                if askTitles, let downloads {
                    do { let info = try await downloads.videoInfo(url: link); title = info.title; duration = info.duration }
                    catch {
                        noTitle += 1
                        // 拒否・制限・通信できない状態は、続けて要求を送らない（回避しない）。以降は、動画IDの名前で追加する
                        if (error as? DownloadError)?.isRefusal == true || error is URLError { askTitles = false }
                    }
                }
                let before = store.document?.playlist(playlistId)?.entries.count ?? 0
                store.perform(["type": "add-video", "playlistId": playlistId, "url": link, "title": title, "duration": duration])
                await store.waitUntilIdle()
                if (store.document?.playlist(playlistId)?.entries.count ?? 0) > before { added += 1 } else { skipped += 1 }
                if askTitles { try? await Task.sleep(nanoseconds: 1_000_000_000) } // 続けて大量の要求を送らない
            }
            await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
            working = false
            progress = ""
            result = "\(added)曲を追加しました" + (skipped > 0 ? "（追加できなかったもの \(skipped)件：重複・形式の誤りなど）" : "") + (noTitle > 0 ? "。曲名を取得できなかった \(noTitle)件は、動画IDの名前です" : "")
            if skipped == 0 { text = "" }
        }
    }
}
