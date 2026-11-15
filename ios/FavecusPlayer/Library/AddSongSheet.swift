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
    /// 「コピーしたリンクを追加」から開いたとき：貼り付けたリンクが動画ページなら、そのまま追加する。
    var startWithPaste = false
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
                        .foregroundStyle(Theme.text)
                    // 「貼り付け」の専用ボタン（OSの部品）：押したときだけ読むため、「他のAppからペースト」の許可を求められない
                    if startWithPaste {
                        Text("下の「貼り付け」を押すと、コピーしたリンクを、このリストへ追加します。").font(.system(size: 12)).foregroundStyle(Theme.accent)
                    }
                    PasteButton(payloadType: String.self) { strings in
                        guard let text = strings.first else { return }
                        // Bilibiliアプリの「リンクをコピー」は、題名つきの短縮リンク（b23.tv）のことがある：リンクだけを取り出し、短縮なら動画ページへ置き換える
                        Task {
                            url = await ClipboardLink.normalized(text)
                            if startWithPaste, ClipboardLink.firstURL(in: url).map(ClipboardLink.isVideoPage) == true { add() }
                        }
                    }
                    .labelStyle(.titleAndIcon)
                    .tint(Theme.accent)
                } header: {
                    SectionLabel(text: "Bilibiliの動画")
                } footer: {
                    Text("動画のURL、またはBV番号を貼り付けます。複数のパートがある動画は、URLの「?p=2」のように、パートを指定できます。\n貼り付けがうまくいかないときは、入力欄を長押しして「ペースト」を選ぶか、iPhoneの「設定」→「FavecusPlayer」→「他のAppからペースト」を「許可」にします。")
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
            .listRowBackground(Theme.panel)
            .background(Theme.background)
            .navigationTitle("曲を追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } } }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }

    /// 入力から動画ID（BV…/av…）を取り出す（追加できた曲との照合用）。
    private static func videoId(of text: String) -> String? {
        text.range(of: #"(BV[0-9A-Za-z]{10}|av[0-9]{1,18})"#, options: .regularExpression).map { String(text[$0]) }
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
                    note = "曲名を取得できなかったため、動画IDの名前で追加しました：\(ErrorText.safe(error))"
                }
            }
            let before = store.document?.playlist(playlistId)?.entries.count ?? 0
            store.perform(["type": "add-video", "playlistId": playlistId, "url": text, "title": title, "duration": duration])
            await store.waitUntilIdle()
            // 追加できたときだけ（重複などで追加されなかったときは、別の曲に画像を付けない）、いま追加した曲のサムネイルを取得する
            if let list = store.document?.playlist(playlistId), list.entries.count > before, let added = list.entries.last?.url {
                // 取得した情報は、いま追加した動画のもの（別の端末の同期で末尾が入れ替わっていないこと）を確かめてから使う
                if let note { store.notice = note }
                if Self.videoId(of: text).map { added.contains($0) } == true { await downloads?.fetchThumbnail(forVideoURL: added, thumbnailURL: thumbnail) }
            }
            await downloads?.refreshKeys(entries: store.document?.playlists.flatMap(\.entries) ?? [])
            working = false
            isPresented = false
        }
    }
}
