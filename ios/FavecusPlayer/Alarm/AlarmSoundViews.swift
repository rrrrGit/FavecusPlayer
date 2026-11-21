import AVFoundation
import SwiftUI

/// アラームの音に選べる曲（保存済みで、端末で再生できるもの）。
struct AlarmSong: Identifiable, Equatable {
    var key: String
    var title: String
    var file: URL
    var id: String { key }
}

@MainActor
struct AlarmSongCatalog {
    let store: LibraryStore
    let downloads: DownloadService?

    /// ライブラリの全曲のうち、保存済み（Bilibiliは音声または動画、ローカルはファイル）のもの。同じ曲は1つにまとめる。
    func songs() -> [AlarmSong] {
        var seen = Set<String>(), result: [AlarmSong] = []
        for playlist in store.document?.playlists ?? [] {
            for entry in playlist.entries {
                guard let song = song(for: entry), seen.insert(song.key).inserted else { continue }
                result.append(song)
            }
        }
        return result
    }

    func file(forKey key: String) -> URL? { songs().first { $0.key == key }?.file }

    /// ライブラリ全曲のメディアキー → 曲名（一覧の表示用。保存済みでなくても名前が引ける）。
    func titlesByKey() -> [String: String] {
        var result: [String: String] = [:]
        for playlist in store.document?.playlists ?? [] {
            for entry in playlist.entries {
                let key: String?
                if entry.type == "bilibili" { key = downloads?.entryKeys[entry.id] }
                else { key = entry.fileName.map { "local:" + $0 } }
                if let key, result[key] == nil { result[key] = entry.title.isEmpty ? "（無題）" : entry.title }
            }
        }
        return result
    }

    /// メディアキーの曲の、登録曲ID（再生に使う）。保存の有無は問わない。
    func entryId(forKey key: String) -> String? {
        for playlist in store.document?.playlists ?? [] {
            for entry in playlist.entries {
                if entry.type == "bilibili" { if downloads?.entryKeys[entry.id] == key { return entry.id } }
                else if let name = entry.fileName, "local:" + name == key { return entry.id }
            }
        }
        return nil
    }

    private func song(for entry: EntryItem) -> AlarmSong? {
        if entry.type == "bilibili" {
            guard let downloads, let key = downloads.entryKeys[entry.id], let file = downloads.savedFile(key: key) ?? downloads.savedFile(key: key, kind: "video") else { return nil }
            return AlarmSong(key: key, title: entry.title, file: file)
        }
        guard let name = entry.fileName, store.mediaFiles.contains(name) else { return nil }
        return AlarmSong(key: "local:" + name, title: entry.title, file: store.mediaDirectory.appendingPathComponent(name))
    }
}

/// 曲を選び、続けて範囲（開始・長さ）を選ぶ。
struct AlarmSoundPicker: View {
    let catalog: AlarmSongCatalog
    let current: AlarmSound?
    /// 「ランダム」を選んでいる（保存済みの曲から、抽選で選ぶ）。
    var randomSelected = false
    let onPick: (AlarmSound?) -> Void
    let onRandom: () -> Void
    @State private var query = ""

    var body: some View {
        let songs = catalog.songs().filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
        List {
            Button { onPick(nil) } label: {
                HStack { Text("既定の音"); Spacer(); if current == nil && !randomSelected { Image(systemName: "checkmark") } }
            }
            // 保存済みの曲から、完全にランダム（お気に入りは、少しだけ選ばれやすい）。音は、選ばれた曲の最初の30秒
            Button { onRandom() } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Text("ランダム（保存済みの曲から）"); Spacer(); if randomSelected { Image(systemName: "checkmark") } }
                    Text("曲の最初の30秒。お気に入りは、少しだけ選ばれやすくなります。鳴ったあとにアプリを開くと、次の曲を選び直します。").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            Section("保存済みの曲") {
                if songs.isEmpty { Text("保存済みの曲がありません").foregroundStyle(Theme.muted) }
                ForEach(songs) { song in
                    NavigationLink {
                        AlarmRangeEditor(song: song, initial: current?.mediaKey == song.key ? current : nil) { onPick($0) }
                    } label: {
                        HStack { Text(song.title).lineLimit(1); Spacer(); if current?.mediaKey == song.key { Image(systemName: "checkmark") } }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "曲名")
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("アラームの音")
        .navigationBarTitleDisplayMode(.inline)
        .tint(Theme.accent)
    }
}

/// 範囲の指定（開始と長さを秒で。試聴つき）。長さの上限はAlarmSound.maxDuration。
struct AlarmRangeEditor: View {
    let song: AlarmSong
    let onDone: (AlarmSound) -> Void
    @State private var total: Double = 0
    @State private var start: Double
    @State private var length: Double
    @State private var player: AVAudioPlayer?
    @State private var stopTask: Task<Void, Never>?
    @State private var failed = false

    init(song: AlarmSong, initial: AlarmSound?, onDone: @escaping (AlarmSound) -> Void) {
        self.song = song
        self.onDone = onDone
        _start = State(initialValue: initial?.startSeconds ?? 0)
        _length = State(initialValue: initial?.durationSeconds ?? 15)
    }

    private var maxStart: Double { max(0, total - AlarmSound.minDuration) }
    private var maxLength: Double { max(AlarmSound.minDuration, min(AlarmSound.maxDuration, total - start)) }

    var body: some View {
        Form {
            Section {
                Text(song.title).lineLimit(2)
                if failed { Text("この曲を読み込めません").foregroundStyle(Theme.warning) }
            }
            if total > 0 {
                Section("開始位置：\(Self.clock(start))（全体 \(Self.clock(total))）") {
                    Slider(value: $start, in: 0...maxStart, step: 1) { _ in clampLength() }
                }
                Section("長さ：\(Int(length))秒（最大\(Int(AlarmSound.maxDuration))秒）") {
                    Slider(value: $length, in: AlarmSound.minDuration...maxLength, step: 1)
                }
                Section {
                    Button { preview() } label: { Label("試聴", systemImage: "play.fill") }
                    Button { stopPreview() } label: { Label("止める", systemImage: "stop.fill") }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .tint(Theme.accent)
        .navigationTitle("範囲を選ぶ")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("決定") {
                    stopPreview()
                    onDone(AlarmSound(mediaKey: song.key, startSeconds: start, durationSeconds: length).normalized())
                }
                .disabled(total <= 0)
            }
        }
        .task { await load() }
        .onDisappear { stopPreview() }
    }

    private func load() async {
        let seconds = (try? await AVURLAsset(url: song.file).load(.duration).seconds) ?? 0
        guard seconds.isFinite, seconds > 0 else { failed = true; return }
        total = seconds
        start = min(start, maxStart)
        clampLength()
    }

    private func clampLength() { length = min(max(length, AlarmSound.minDuration), maxLength) }

    private func preview() {
        stopPreview()
        guard let next = try? AVAudioPlayer(contentsOf: song.file) else { failed = true; return }
        next.currentTime = start
        next.play()
        player = next
        let seconds = length
        stopTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if !Task.isCancelled { player?.stop() }
        }
    }

    private func stopPreview() {
        stopTask?.cancel()
        player?.stop()
        player = nil
    }

    static func clock(_ seconds: Double) -> String {
        let value = Int(seconds)
        return String(format: "%d:%02d", value / 60, value % 60)
    }
}
