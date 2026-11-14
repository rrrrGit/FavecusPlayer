import SwiftUI

// MARK: 保存

/// 保存（ダウンロード）の一覧：保存中・失敗・保存済み。取り消し・もう一度・削除ができる。
struct DownloadsTab: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    @Binding var showPlayer: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let downloads = services.downloads {
                    DownloadsList(store: store, downloads: downloads)
                } else {
                    VStack { Spacer(); Text("保存を使えません").foregroundStyle(.secondary); Spacer() }.frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("保存")
        }
        .miniPlayer(services, showPlayer: $showPlayer)
    }
}

private struct DownloadItem: Identifiable {
    let entry: EntryItem
    let key: String
    let record: DeviceMediaRecord
    var id: String { record.id }
}

private struct DownloadsList: View {
    @ObservedObject var store: LibraryStore
    @ObservedObject var downloads: DownloadService
    @AppStorage("downloadWiFiOnly") private var wifiOnly = false

    private var items: [DownloadItem] {
        var seen = Set<String>()
        var result: [DownloadItem] = []
        for entry in store.document?.playlists.flatMap(\.entries) ?? [] where entry.type == "bilibili" {
            guard let key = downloads.entryKeys[entry.id] else { continue }
            for kind in ["audio", "video"] {
                if let record = downloads.record(key: key, kind: kind), record.state != .notDownloaded, seen.insert(record.id).inserted {
                    result.append(DownloadItem(entry: entry, key: key, record: record))
                }
            }
        }
        return result
    }

    var body: some View {
        let all = items
        let active = all.filter { $0.record.state.inProgress }
        let problems = all.filter { $0.record.state == .failed || $0.record.state == .cancelled }
        let saved = all.filter { $0.record.state == .completed }
        List {
            Section {
                Toggle("Wi-Fiのときだけ保存する", isOn: $wifiOnly)
            } footer: {
                Text("画面を閉じたり、ロックしたりしても、保存は続きます。ただし、アプリを上へスワイプして終了すると、iOSの仕様で保存は止まります。")
            }
            if !active.isEmpty {
                Section { ForEach(active) { row($0) } } header: { SectionLabel(text: "保存中") }
            }
            if !problems.isEmpty {
                Section { ForEach(problems) { row($0) } } header: { SectionLabel(text: "保存できなかったもの") }
            }
            Section {
                if saved.isEmpty { Text("保存した曲はありません").foregroundStyle(.secondary) }
                ForEach(saved) { row($0) }
            } header: {
                SectionLabel(text: "保存済み")
            } footer: {
                if !saved.isEmpty { Text("合計 " + ByteCountFormatter.string(fromByteCount: saved.reduce(0) { $0 + $1.record.bytes }, countStyle: .file)) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
    }

    @ViewBuilder
    private func row(_ item: DownloadItem) -> some View {
        let record = item.record
        VStack(alignment: .leading, spacing: 4) {
            Text(item.entry.title.isEmpty ? "（無題）" : item.entry.title).lineLimit(2)
            HStack(spacing: 8) {
                Text(detail(record)).font(.caption).textSelection(.enabled).foregroundStyle(record.state == .failed ? Theme.warning : Theme.muted).lineLimit(2)
                if record.state.inProgress {
                    if let value = downloads.progress[record.id] { ProgressView(value: value).frame(maxWidth: 80) } else { ProgressView().controlSize(.mini) }
                }
            }
        }
        .contextMenu {
            if let text = record.message { Button { Clipboard.copy(text) } label: { Label("エラーの内容をコピー", systemImage: "doc.on.doc") } }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if record.state.inProgress {
                Button("取り消し", role: .destructive) { downloads.cancel(key: item.key, kind: record.kind) }
            } else if record.state == .completed {
                Button("削除", role: .destructive) { Task { await downloads.remove(key: item.key, kind: record.kind) } }
            } else {
                Button("削除", role: .destructive) { Task { await downloads.remove(key: item.key, kind: record.kind) } }
                Button("もう一度") { downloads.save(entry: item.entry, kind: record.kind) }.tint(.blue)
            }
        }
    }

    private func detail(_ record: DeviceMediaRecord) -> String {
        let kind = record.kind == "video" ? "動画" : "音声"
        switch record.state {
        case .completed: return "\(kind)・" + ByteCountFormatter.string(fromByteCount: record.bytes, countStyle: .file)
        case .failed: return "\(kind)・" + (record.message ?? "保存に失敗しました。")
        case .cancelled: return "\(kind)・取り消しました"
        case .preparing: return "\(kind)・準備中"
        case .downloading: return "\(kind)・取得中"
        case .processing, .validating: return "\(kind)・仕上げ中"
        case .notDownloaded: return kind
        }
    }
}

// MARK: 設定

struct SettingsTab: View {
    @ObservedObject var store: LibraryStore
    let hasImporter: Bool
    let hasExporter: Bool
    let hasSync: Bool
    let hasBilibili: Bool
    let services: Services
    @Binding var showPlayer: Bool
    let openPicker: () -> Void
    let openExport: () -> Void
    let openSync: () -> Void
    let openBilibili: () -> Void
    let openDiagnostics: () -> Void
    @AppStorage("downloadWiFiOnly") private var wifiOnly = false

    var body: some View {
        NavigationStack {
            List {
                Section("アカウントと同期") {
                    if hasSync { Button { openSync() } label: { Label("プレイリストの同期", systemImage: "arrow.triangle.2.circlepath") } }
                    if hasBilibili { Button { openBilibili() } label: { Label("Bilibiliのログイン", systemImage: "person.crop.circle") } }
                }
                Section("データ") {
                    if hasImporter { Button { openPicker() } label: { Label("ZIPを取り込む", systemImage: "square.and.arrow.down") } }
                    if hasExporter { Button { openExport() } label: { Label("ZIPへ出力する", systemImage: "square.and.arrow.up") } }
                }
                Section {
                    Toggle("Wi-Fiのときだけ保存する", isOn: $wifiOnly)
                } header: {
                    Text("保存")
                }
                Section("アプリ") {
                    Button { openDiagnostics() } label: { Label("診断", systemImage: "stethoscope") }
                    LabeledContent("バージョン", value: AppInfo.versionText)
                }
            }
            .buttonStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("設定")
        }
        .miniPlayer(services, showPlayer: $showPlayer)
    }
}
