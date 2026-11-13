import SwiftUI
import UIKit

/// 曲の追加：Bilibiliの動画URL（またはBV番号）を貼り付けて、このリストの末尾へ加える。
/// 曲名・長さ・サムネイルは、動画の情報（view API）から取得する。取得できなくても、動画IDの名前で追加できる（あとで曲名は変えられる）。
/// 追加は共通JS（add-video）が行う（同じ動画がすでにあれば、追加しない）。曲のファイル（ローカル）は、設定の「ZIPを取り込む」から入れる。
struct AddSongSheet: View {
    @ObservedObject var store: LibraryStore
    let downloads: DownloadService?
    let playlistId: String
    let playlistName: String
    @Binding var isPresented: Bool
    @State private var url = ""
    @State private var working = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("追加先：\(playlistName)").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    TextField("https://www.bilibili.com/video/BV…", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
                    Button { if let text = UIPasteboard.general.string { url = text.trimmingCharacters(in: .whitespacesAndNewlines) } } label: {
                        Label("貼り付け", systemImage: "doc.on.clipboard")
                    }
                    .buttonStyle(.borderless)
                } header: {
                    SectionLabel(text: "BILIBILIの動画")
                } footer: {
                    Text("動画のURL、またはBV番号を貼り付けます。複数のパートがある動画は、URLの「?p=2」のように、パートを指定できます。")
                }
                Section {
                    Button {
                        add()
                    } label: {
                        HStack { Spacer(); if working { ProgressView() } else { Label("このリストへ追加", systemImage: "plus") }; Spacer() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working || url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .listRowBackground(Color.clear)
                    if let message { Text(message).font(.footnote).foregroundStyle(Theme.warning) }
                }
                Section {
                    Text("ファイル（音楽・動画）を入れるときは、設定 →「ZIPを取り込む」で、Windows版から出力したZIPを選びます。").font(.footnote).foregroundStyle(Theme.muted)
                    Text("Windows版で追加した曲は、同期を有効にしていれば、自動でこのアプリにも届きます。").font(.footnote).foregroundStyle(Theme.muted)
                } header: {
                    SectionLabel(text: "ほかの追加方法")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("曲を追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } } }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }

    private func add() {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        working = true
        message = nil
        Task {
            var title = "", duration = 0.0, thumbnail: String?
            var note: String?
            if let downloads {
                do {
                    let info = try await downloads.videoInfo(url: text)
                    title = info.title
                    duration = info.duration
                    thumbnail = info.thumbnailURL
                } catch {
                    // 拒否・制限・通信の失敗：回避せず、動画IDの名前で追加して知らせる
                    note = "曲名を取得できなかったため、動画IDの名前で追加しました：\((error as? CustomStringConvertible)?.description ?? error.localizedDescription)"
                }
            }
            let before = store.document?.playlist(playlistId)?.entries.count ?? 0
            store.perform(["type": "add-video", "playlistId": playlistId, "url": text, "title": title, "duration": duration])
            await store.waitUntilIdle()
            if let note { store.notice = note }
            // 追加できたときだけ（重複などで追加されなかったときは、別の曲に画像を付けない）、いま追加した曲のサムネイルを取得する
            if let list = store.document?.playlist(playlistId), list.entries.count > before, let added = list.entries.last?.url {
                await downloads?.fetchThumbnail(forVideoURL: added, thumbnailURL: thumbnail)
            }
            await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
            working = false
            isPresented = false
        }
    }
}
