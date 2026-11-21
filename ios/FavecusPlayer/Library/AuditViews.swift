import SwiftUI

/// ライブラリの点検の結果（共通JSの Audit ＝ PC版と同じ規則）。報告だけで、自動では何も消さない。
struct LibraryAuditReport: Decodable, Equatable {
    struct Duplicate: Decodable, Equatable, Identifiable {
        struct Item: Decodable, Equatable, Identifiable { let id: String; let title: String }
        let playlistId: String
        let playlistName: String
        let title: String
        let entries: [Item]
        var id: String { playlistId + "/" + (entries.first?.id ?? title) }
    }
    struct Missing: Decodable, Equatable, Identifiable {
        let playlistId: String
        let playlistName: String
        let entryId: String
        let title: String
        let fileName: String
        var id: String { playlistId + "/" + entryId }
    }
    let duplicates: [Duplicate]
    let missing: [Missing]
    let checked: Int
}

extension PlaybackEngine {
    /// ライブラリの点検（重複・リンク切れ）。メディアの置き場にあるファイルの名前を、共通JSへ渡す。
    func libraryAudit() async -> LibraryAuditReport? {
        let request: [String: Any] = ["text": store.currentText, "existingFiles": Array(store.mediaFiles)]
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let reply = try? await core.callAsync("Audit", String(decoding: data, as: UTF8.self)) else { return nil }
        return try? JSONDecoder().decode(LibraryAuditReport.self, from: Data(reply.utf8))
    }
}

/// 設定 →「ライブラリの点検」。重複・リンク切れを報告する。外すのは、選んで「このリストから外す」（最近削除へ保管される）。
struct AuditView: View {
    @ObservedObject var store: LibraryStore
    let player: PlaybackEngine?
    @State private var report: LibraryAuditReport?
    @State private var loading = true

    var body: some View {
        List {
            if let report {
                Section { Text("\(report.checked)曲を点検しました。重複 \(report.duplicates.count)件・リンク切れ \(report.missing.count)件。自動では、何も消しません。").font(.footnote).foregroundStyle(Theme.muted) }
                Section {
                    if report.duplicates.isEmpty { Text("見つかりませんでした").font(.footnote).foregroundStyle(Theme.muted) }
                    ForEach(report.duplicates) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(group.playlistName)：\(group.title)").font(.system(size: 13, weight: .semibold)).lineLimit(2)
                            ForEach(Array(group.entries.enumerated()), id: \.element.id) { index, entry in
                                HStack {
                                    Text("\(index + 1)つ目：\(entry.title.isEmpty ? "（無題）" : entry.title)").font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                                    Spacer()
                                    Button("外す", role: .destructive) { remove(group.playlistId, entry.id) }.font(.system(size: 12))
                                }
                            }
                        }
                    }
                } header: { Text("重複（同じリストに、同じ曲が2つ以上）") }
                Section {
                    if report.missing.isEmpty { Text("見つかりませんでした").font(.footnote).foregroundStyle(Theme.muted) }
                    ForEach(report.missing) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                Text("\(item.playlistName)（\(item.fileName)）").font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                            }
                            Spacer()
                            Button("外す", role: .destructive) { remove(item.playlistId, item.entryId) }.font(.system(size: 12))
                        }
                    }
                } header: { Text("リンク切れ（ローカルの曲のファイルがない）") } footer: { Text("外した曲は、「最近削除」に、30日間、保管されます。") }
            } else if loading {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else {
                Text("点検できませんでした").foregroundStyle(Theme.warning)
            }
        }
        .buttonStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("ライブラリの点検")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
    }

    private func reload() async {
        loading = true
        report = await player?.libraryAudit()
        loading = false
    }

    private func remove(_ playlistId: String, _ entryId: String) {
        store.perform(["type": "remove", "playlistId": playlistId, "entryId": entryId])
        Task { await store.waitUntilIdle(); await reload() }
    }
}
