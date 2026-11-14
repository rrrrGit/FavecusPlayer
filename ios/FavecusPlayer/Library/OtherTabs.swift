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
    @State private var now = Date()
    @State private var reloading = false
    @State private var free: Int64?
    /// 一覧に出す件数の上限（超えた分は、記録だけが残り、一覧には出さない）。
    private static let problemLimit = 10
    private static let savedLimit = 50

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

    private var summary: String {
        let saved = ByteCountFormatter.string(fromByteCount: downloads.savedBytes, countStyle: .file)
        guard let free else { return "保存済み \(saved)" }
        return "保存済み \(saved)・空き \(ByteCountFormatter.string(fromByteCount: free, countStyle: .file))"
    }

    var body: some View {
        let all = items
        let active = all.filter { $0.record.state.inProgress }
        let problems = all.filter { downloads.isRecentProblem($0.record, now: now) }.sorted { $0.record.updatedAt > $1.record.updatedAt }
        let saved = all.filter { $0.record.state == .completed }.sorted { $0.record.updatedAt > $1.record.updatedAt }
        List {
            Section {
                HStack {
                    Text(summary).font(.caption).foregroundStyle(Theme.muted)
                    Spacer()
                    Button {
                        Task {
                            reloading = true
                            await downloads.reload()
                            free = downloads.freeBytes()
                            reloading = false
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise").frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(reloading)
                    .accessibilityLabel("更新")
                }
                Toggle("Wi-Fi接続時のみ保存", isOn: $wifiOnly)
            }
            if !active.isEmpty {
                Section { ForEach(active) { row($0) } } header: { SectionLabel(text: "保存中") }
            }
            if !problems.isEmpty {
                Section {
                    ForEach(problems.prefix(Self.problemLimit)) { row($0) }
                } header: {
                    SectionLabel(text: "保存できなかったもの")
                } footer: {
                    if problems.count > Self.problemLimit { Text("他 \(problems.count - Self.problemLimit) 件は表示していません（記録は残っています）。") }
                }
            }
            Section {
                if saved.isEmpty { Text("保存した曲はありません").foregroundStyle(.secondary) }
                ForEach(saved.prefix(Self.savedLimit)) { row($0) }
            } header: {
                SectionLabel(text: "保存済み")
            } footer: {
                if saved.count > Self.savedLimit { Text("新しい \(Self.savedLimit) 件を表示しています（他 \(saved.count - Self.savedLimit) 件は、曲のメニューから確認できます）。") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .onAppear { free = downloads.freeBytes(); now = Date() }
        .task {
            // 一定時間を過ぎた失敗の表示を消す。この画面を開いている間は、受信が止まった取得も検知する
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                now = Date()
                free = downloads.freeBytes()
                await downloads.reconcile()
            }
        }
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
                    Toggle("Wi-Fi接続時のみ保存", isOn: $wifiOnly)
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
