import SwiftUI

// 曲の情報（アーティスト・タグ・メモ・チャプター。v0.7.4）。規則は共通JS（core/song-notes.cjs ＝ PC版と同じ）。
// 曲のメディアのキー単位。この端末内だけに保存し、同期しない（ライブラリの形式は変えない）。

struct SongChapter: Codable, Equatable, Identifiable {
    var at: Int
    var title: String
    var id: Int { at }
}

struct SongNotesRecord: Codable, Equatable {
    var artist = ""
    var tags: [String] = []
    var memo = ""
    var chapters: [SongChapter] = []
    var isEmpty: Bool { artist.isEmpty && tags.isEmpty && memo.isEmpty && chapters.isEmpty }
}

/// 曲の情報のファイル保存（Application Support/FavecusPlayer/song-notes.json。原子的に書く）。キーが正しくない曲・空の記録は持たない。
@MainActor
final class SongNotesStore {
    static let maxSongs = 20000
    private struct Document: Codable { var version: Int; var records: [String: SongNotesRecord] }
    private var records: [String: SongNotesRecord] = [:]
    private let fileURL: URL

    init(directory: URL? = nil) {
        fileURL = (directory ?? FavoritesStore.defaultDirectory()).appendingPathComponent("song-notes.json")
        if let data = try? Data(contentsOf: fileURL), let document = try? JSONDecoder().decode(Document.self, from: data), document.version == 1 {
            for (key, record) in document.records.prefix(Self.maxSongs) where FavoritesStore.isValid(key) && !record.isEmpty { records[key] = record }
        }
    }

    func get(_ key: String) -> SongNotesRecord? { records[key] }

    /// 空にしたときは、記録を消す。キーが正しくない・上限を超えるときは、false。
    @discardableResult
    func set(_ key: String, _ record: SongNotesRecord) -> Bool {
        guard FavoritesStore.isValid(key) else { return false }
        if record.isEmpty { records[key] = nil } else {
            guard records[key] != nil || records.count < Self.maxSongs else { return false }
            records[key] = record
        }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Document(version: 1, records: records)) { try? data.write(to: fileURL, options: .atomic) }
        return true
    }
}

extension PlaybackEngine {
    /// 曲の情報（キー・記録・チャプターの編集用の文）。キーが分からない曲は、識別できない（nil のキー）。
    func songNotes(for entry: EntryItem) async -> (key: String?, record: SongNotesRecord, chapterText: String) {
        guard let key = await countKeys(for: [entry]).first ?? nil else { return (nil, SongNotesRecord(), "") }
        let record = notes.get(key) ?? SongNotesRecord()
        return (key, record, await chapterText(for: record.chapters))
    }

    /// チャプターの一覧 → 編集用の文（1行に「時刻 題名」。共通JS）。
    func chapterText(for chapters: [SongChapter]) async -> String {
        guard !chapters.isEmpty else { return "" }
        let request: [String: Any] = ["chapters": chapters.map { ["at": $0.at, "title": $0.title] }]
        guard let data = try? JSONSerialization.data(withJSONObject: request), let reply = try? await core.callAsync("NotesChapters", String(decoding: data, as: UTF8.self)),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any] else { return "" }
        return object["text"] as? String ?? ""
    }

    /// 保存：入力を共通JSで安全な形にして（長さ・件数・チャプターの読み取り）、キーごとに保存する。戻り値：保存できたか。
    @discardableResult
    func saveSongNotes(entry: EntryItem, artist: String, tags: [String], memo: String, chapterText: String) async -> Bool {
        guard let key = await countKeys(for: [entry]).first ?? nil else { message = "この曲は、まだ識別できないため、情報を保存できません"; return false }
        var chapters: [[String: Any]] = []
        if let data = try? JSONSerialization.data(withJSONObject: ["text": chapterText]), let reply = try? await core.callAsync("NotesChapters", String(decoding: data, as: UTF8.self)),
           let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], let list = object["chapters"] as? [[String: Any]] { chapters = list }
        let request: [String: Any] = ["record": ["artist": artist, "tags": tags, "memo": memo, "chapters": chapters]]
        guard let data = try? JSONSerialization.data(withJSONObject: request), let reply = try? await core.callAsync("NotesNormalize", String(decoding: data, as: UTF8.self)),
              let object = (try? JSONSerialization.jsonObject(with: Data(reply.utf8))) as? [String: Any], object["error"] == nil, let raw = object["record"],
              let recordData = try? JSONSerialization.data(withJSONObject: raw), let record = try? JSONDecoder().decode(SongNotesRecord.self, from: recordData) else { return false }
        let saved = notes.set(key, record)
        message = saved ? (record.isEmpty ? "曲の情報を消しました" : "曲の情報を保存しました") : "保存できませんでした"
        notesRevision += 1
        return saved
    }

    /// 再生中の曲のチャプター（なければ空）。
    func chapters(for entryId: String) async -> [SongChapter] {
        guard let entry = entry(entryId), let key = await countKeys(for: [entry]).first ?? nil else { return [] }
        return notes.get(key)?.chapters ?? []
    }
}

/// 曲の情報の編集。チャプターは、1行に「1:23 題名」（動画の説明欄の目次を、そのまま貼り付けられる）。
struct SongInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let player: PlaybackEngine
    let entry: EntryItem
    @State private var artist = ""
    @State private var tagText = ""
    @State private var memo = ""
    @State private var chapterText = ""
    @State private var identified = true
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(entry.title.isEmpty ? "（無題）" : entry.title).font(.system(size: 14, weight: .semibold)) } footer: {
                    Text("この曲の情報は、この端末だけに保存します（同期しません）。同じ動画・同じファイルの曲は、どのリストでも共通です。")
                }
                if !identified {
                    Section { Text("この曲は、まだ識別できないため、情報を保存できません。再生などで動画の情報を取得してから、もう一度お試しください。").font(.footnote).foregroundStyle(Theme.warning) }
                }
                Section("アーティスト") { TextField("アーティスト", text: $artist) }
                Section("タグ（カンマ・読点で区切る）") { TextField("歌枠, 雑談", text: $tagText).textInputAutocapitalization(.never).autocorrectionDisabled() }
                Section("メモ") { TextEditor(text: $memo).frame(minHeight: 80) }
                Section {
                    TextEditor(text: $chapterText).frame(minHeight: 120).font(.system(size: 13).monospacedDigit()).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("チャプター") } footer: { Text("1行に「1:23 題名」。動画の説明欄の目次を貼り付けると、取り込みます。") }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("曲の情報")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let tags = tagText.split(whereSeparator: { ",、，\n".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                        Task { if await player.saveSongNotes(entry: entry, artist: artist, tags: tags, memo: memo, chapterText: chapterText) { dismiss() } }
                    }
                    .disabled(!loaded || !identified)
                }
            }
            .task {
                let info = await player.songNotes(for: entry)
                identified = info.key != nil
                artist = info.record.artist; tagText = info.record.tags.joined(separator: ", "); memo = info.record.memo; chapterText = info.chapterText
                loaded = true
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.large])
    }
}

/// 再生画面の「チャプター」（再生中の曲に、チャプターがあるときだけ出す）。選ぶと、その時刻へ移る。
struct ChapterMenu: View {
    @ObservedObject var player: PlaybackEngine
    @State private var chapters: [SongChapter] = []

    var body: some View {
        Group {
            if !chapters.isEmpty {
                Menu {
                    ForEach(chapters) { chapter in
                        Button("\(Self.time(chapter.at))　\(chapter.title)") { player.seek(to: Double(chapter.at)) }
                    }
                } label: {
                    HStack(spacing: 6) { Image(systemName: "list.bullet"); Text("チャプター") }
                        .font(.system(size: 13)).foregroundStyle(Theme.muted).frame(minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("チャプター")
            }
        }
        .task(id: ChapterKey(entryId: player.current?.entryId, revision: player.notesRevision)) {
            if let id = player.current?.entryId { chapters = await player.chapters(for: id) } else { chapters = [] }
        }
    }

    private struct ChapterKey: Equatable { let entryId: String?; let revision: Int }

    static func time(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
