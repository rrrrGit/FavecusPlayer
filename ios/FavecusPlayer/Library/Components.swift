import Combine
import SwiftUI
import UIKit

/// 画面で共有する部品（再生・保存・サムネイル）。再生や保存が使えない起動（部品の読み込みに失敗）でも、一覧は出せるよう、どれも空にできる。
struct Services {
    let player: PlaybackEngine?
    let downloads: DownloadService?
    let artwork: ArtworkStore
}

/// 保存の状態・サムネイルの変化を、一覧へ知らせる（描き直しの合図）。進み具合は頻繁に変わるため、間引く。
@MainActor
final class ServicesObserver: ObservableObject {
    private var cancellables = Set<AnyCancellable>()

    init(downloads: DownloadService?, artwork: ArtworkStore) {
        let signals: [ObservableObjectPublisher] = [downloads?.objectWillChange, Optional(artwork.objectWillChange)].compactMap { $0 }
        Publishers.MergeMany(signals)
            .throttle(for: .milliseconds(300), scheduler: DispatchQueue.main, latest: true)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }
}

/// 曲の画像。PC版と同じ16:9の枠。サムネイルがなければ、音符の代わりの画像を出す。
struct ArtworkTile: View {
    let image: UIImage?
    let title: String
    /// 幅（高さは16:9。PC版の曲の画像枠と同じ比率で、画像は切らずに収める）。
    var side: CGFloat = 72
    var corner: CGFloat = 5

    var body: some View {
        ZStack {
            Theme.background
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "music.note").font(.system(size: side * 0.2)).foregroundStyle(Color(hex: 0x50586F))
            }
        }
        .frame(width: side, height: side * 9 / 16)
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .overlay(RoundedRectangle(cornerRadius: corner).stroke(Theme.coverLine, lineWidth: 1))
    }
}

/// 正方形のカード用の画像（ホーム）。サムネイルは中央を切り出して全面に敷く。
struct SquareCover: View {
    let image: UIImage?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Theme.panel
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: proxy.size.width, height: proxy.size.height).clipped()
                } else {
                    Image(systemName: "music.note.list").font(.system(size: proxy.size.width * 0.28)).foregroundStyle(Color(hex: 0x50586F))
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// リストの画像：そのリストの先頭の曲のサムネイル。曲がなければ（または画像がなければ）、子のリストの先頭から探す。
@MainActor
func firstCover(of list: PlaylistItem, document: LibraryDocument?, services: Services, depth: Int = 0) -> UIImage? {
    _ = services.artwork.revision
    for entry in list.entries {
        if let key = services.downloads?.entryKeys[entry.id], let image = services.artwork.image(for: key) { return image }
    }
    guard depth < 4, let document else { return nil }
    for child in document.children(of: list.id) {
        if let image = firstCover(of: child, document: document, services: services, depth: depth + 1) { return image }
    }
    return nil
}

/// 時間の表示（m:ss）。
func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    return String(format: "%d:%02d", total / 60, total % 60)
}

// MARK: 曲の行

/// 曲の「…」を押したときの操作（アイコン・名前・実行）。
struct RowAction: Identifiable {
    let id = UUID()
    let icon: String
    let title: String
    var destructive = false
    let run: () -> Void
}

/// 曲の「…」の画面：曲の画像・名前と、できる操作の一覧。
struct SongActionSheet: View {
    let title: String
    let subtitle: String
    let image: UIImage?
    let actions: [RowAction]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                ArtworkTile(image: image, title: title, side: 112, corner: 8)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title.isEmpty ? "（無題）" : title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(3)
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            Divider().overlay(Theme.line)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(actions) { action in
                        Button {
                            dismiss()
                            // シートを閉じてから実行する（閉じる途中で、一覧が変わらないように）
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { action.run() }
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: action.icon).frame(width: 26)
                                Text(action.title)
                                Spacer()
                            }
                            .font(.system(size: 16))
                            .foregroundStyle(action.destructive ? Color(hex: 0xFF8A8A) : Theme.text)
                            .padding(.horizontal, 20).padding(.vertical, 14)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider().overlay(Theme.rowLine)
                    }
                }
            }
        }
        .background(Theme.panel.ignoresSafeArea())
        .presentationDetents([.medium, .large])
    }
}

/// 画面確認用（スクリーンショット）：起動引数 -FavecusDemoMenu YES で、最初の曲の「…」の画面を1回だけ開く。通常の起動では何もしない。
@MainActor
private enum DemoMenu {
    static var consumed = false
    static func take() -> Bool {
        guard !consumed, UserDefaults.standard.bool(forKey: "FavecusDemoMenu") else { return false }
        consumed = true
        return true
    }
}

/// 曲の1行。再生できる曲は押すと再生、できない曲は薄く表示して理由を出す。Bilibiliの曲は、保存の状態を表示する。「…」で、保存・削除などの操作の画面を開く。
struct SongRow: View {
    let entry: EntryItem
    let scope: String
    let services: Services
    /// 一覧での番号（PC版と同じ「01」）。
    var number: Int?
    /// 検索結果の行で、所属のリスト名を2行目に添える。
    var context: String?
    /// このリストから曲を外す（nil なら出さない）。
    var onRemove: (() -> Void)?

    var body: some View {
        if let player = services.player {
            if entry.type == "bilibili", let downloads = services.downloads {
                BiliSongRow(entry: entry, scope: scope, number: number, context: context, player: player, downloads: downloads, artwork: services.artwork, onRemove: onRemove)
            } else {
                LocalSongRow(entry: entry, scope: scope, number: number, context: context, player: player, artwork: services.artwork, key: services.downloads?.entryKeys[entry.id], onRemove: onRemove)
            }
        } else {
            Text(entry.title.isEmpty ? "（無題）" : entry.title)
        }
    }
}

private struct RowLayout: View {
    let number: Int?
    let title: String
    /// 2行目（PC版と同じ：長さ・動画ID・パート）。
    let meta: String
    /// 保存の状態の補足（保存中・失敗など。なければnil）。
    let status: String?
    let image: UIImage?
    let current: Bool
    let playing: Bool
    let dimmed: Bool
    /// 保存済み（PC版と同じ「DL済み」の印）。
    let saved: Bool
    let progress: Double?
    let actions: [RowAction]
    let tap: () -> Void
    @State private var showActions = false

    var body: some View {
        HStack(spacing: 10) {
            if let number {
                Text(String(format: "%02d", number)).font(.system(size: 11)).foregroundStyle(current ? Theme.accent : Theme.faint).frame(width: 22)
            }
            HStack(spacing: 10) {
                ZStack {
                    ArtworkTile(image: image, title: title, side: 68)
                    if current {
                        Color.black.opacity(0.5).clipShape(RoundedRectangle(cornerRadius: 5))
                        Image(systemName: playing ? "speaker.wave.2.fill" : "speaker.fill").foregroundStyle(Theme.accent)
                    }
                }
                .frame(width: 68, height: 38)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title.isEmpty ? "（無題）" : title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(current ? Theme.accent : (dimmed ? Theme.muted : Theme.text))
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Text(meta).font(.system(size: 10)).foregroundStyle(Theme.faint).lineLimit(1)
                        if let status { Text(status).font(.system(size: 10)).foregroundStyle(Theme.warning).lineLimit(1) }
                        if let progress { ProgressView(value: progress).tint(Theme.accent).frame(width: 40) }
                    }
                }
                Spacer(minLength: 0)
                if saved {
                    Text("DL済み").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.mint)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.mint.opacity(0.7), lineWidth: 1))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: tap)
            Button { showActions = true } label: {
                Image(systemName: "ellipsis").foregroundStyle(Theme.muted).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("曲のメニュー")
        }
        .padding(.vertical, 2)
        .listRowBackground(current ? Theme.currentRow : Theme.background)
        .listRowSeparatorTint(Theme.rowLine)
        .sheet(isPresented: $showActions) {
            SongActionSheet(title: title, subtitle: meta, image: image, actions: actions)
        }
        .onAppear { if DemoMenu.take() { showActions = true } }
    }
}

/// 長さ・動画ID・パートの2行目（PC版と同じ）。
private func metaText(for entry: EntryItem) -> String {
    var parts: [String] = []
    if let duration = entry.duration, duration > 0 {
        let total = Int(duration)
        parts.append(total >= 3600 ? String(format: "%d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60) : String(format: "%02d:%02d", total / 60, total % 60))
    }
    if let id = entry.videoId { parts.append(id) }
    if let part = entry.part { parts.append("P\(part)") }
    return parts.isEmpty ? (entry.type == "bilibili" ? "Bilibili" : "ローカル") : parts.joined(separator: " · ")
}

private struct LocalSongRow: View {
    let entry: EntryItem
    let scope: String
    let number: Int?
    let context: String?
    @ObservedObject var player: PlaybackEngine
    @ObservedObject var artwork: ArtworkStore
    let key: String?
    var onRemove: (() -> Void)?

    var body: some View {
        _ = artwork.revision
        let playable = player.canPlay(entry)
        var actions: [RowAction] = []
        if playable { actions.append(RowAction(icon: "play.fill", title: "再生") { Task { await player.play(entryId: entry.id, scope: scope) } }) }
        if let onRemove { actions.append(RowAction(icon: "minus.circle", title: "このリストから外す", destructive: true, run: onRemove)) }
        return RowLayout(number: number, title: entry.title, meta: metaText(for: entry) + (context.map { " · " + $0 } ?? ""), status: playable ? nil : "この端末にファイルがありません", image: artwork.image(for: key),
                         current: player.current?.entryId == entry.id, playing: player.isPlaying, dimmed: !playable, saved: false, progress: nil, actions: actions,
                         tap: { Task { await player.play(entryId: entry.id, scope: scope) } })
    }
}

private struct BiliSongRow: View {
    let entry: EntryItem
    let scope: String
    let number: Int?
    let context: String?
    @ObservedObject var player: PlaybackEngine
    @ObservedObject var downloads: DownloadService
    @ObservedObject var artwork: ArtworkStore
    var onRemove: (() -> Void)?

    private var key: String? { downloads.entryKeys[entry.id] }
    private func record(_ kind: String) -> DeviceMediaRecord? { key.flatMap { downloads.record(key: $0, kind: kind) } }

    private var status: String? {
        let audio = record("audio"), video = record("video")
        if audio?.state.inProgress == true || video?.state.inProgress == true { return "保存中" }
        return key.flatMap { downloads.problemStatus(key: $0) }
    }

    private var actions: [RowAction] {
        var result = [RowAction(icon: "play.fill", title: "再生") { Task { await player.play(entryId: entry.id, scope: scope) } }]
        if let key {
            for (kind, label) in [("audio", "音声"), ("video", "動画")] {
                let state = record(kind)?.state
                if state?.inProgress == true {
                    result.append(RowAction(icon: "xmark.circle", title: "\(label)の保存を取り消す", destructive: true) { downloads.cancel(key: key, kind: kind) })
                } else if state == .completed {
                    result.append(RowAction(icon: "trash", title: "\(label)の保存を削除", destructive: true) { Task { await downloads.remove(key: key, kind: kind) } })
                } else {
                    result.append(RowAction(icon: kind == "video" ? "film" : "arrow.down.circle", title: "\(label)を保存") { downloads.save(entry: entry, kind: kind) })
                }
            }
        }
        if let onRemove { result.append(RowAction(icon: "minus.circle", title: "このリストから外す", destructive: true, run: onRemove)) }
        return result
    }

    var body: some View {
        _ = artwork.revision // 画像が増えたら描き直す
        let saved = record("audio")?.state == .completed || record("video")?.state == .completed
        return RowLayout(number: number, title: entry.title, meta: metaText(for: entry) + (context.map { " · " + $0 } ?? ""), status: status, image: artwork.image(for: key),
                         current: player.current?.entryId == entry.id, playing: player.isPlaying, dimmed: false, saved: saved,
                         progress: record("audio")?.state.inProgress == true ? key.flatMap { downloads.progress["\($0)|audio"] } : nil,
                         actions: actions,
                         tap: { Task { await player.play(entryId: entry.id, scope: scope) } })
    }
}
