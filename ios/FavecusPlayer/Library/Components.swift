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

/// 曲・リストの画像。サムネイルがなければ、名前から決めた色の代わりの画像（先頭の1文字）を出す。
struct ArtworkTile: View {
    let image: UIImage?
    let title: String
    var side: CGFloat = 48
    var corner: CGFloat = 6

    static func color(_ title: String) -> Color {
        let hue = title.unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) % 360 }
        return Color(hue: Double(hue) / 360, saturation: 0.45, brightness: 0.55)
    }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                LinearGradient(colors: [Self.color(title), Self.color(title).opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing)
                Text(String(title.prefix(1))).font(.system(size: side * 0.42, weight: .bold)).foregroundStyle(.white.opacity(0.9))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: corner))
    }
}

/// 時間の表示（m:ss）。
func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// 曲の1行。再生できる曲は押すと再生、できない曲は薄く表示して理由を出す。Bilibiliの曲は、保存の状態を表示し、メニューから保存・削除できる。
struct SongRow: View {
    let entry: EntryItem
    let scope: String
    let services: Services
    /// このリストから曲を外す（nil なら出さない）。
    var onRemove: (() -> Void)?

    var body: some View {
        if let player = services.player {
            if entry.type == "bilibili", let downloads = services.downloads {
                BiliSongRow(entry: entry, scope: scope, player: player, downloads: downloads, artwork: services.artwork, onRemove: onRemove)
            } else {
                LocalSongRow(entry: entry, scope: scope, player: player, artwork: services.artwork, onRemove: onRemove)
            }
        } else {
            Text(entry.title.isEmpty ? "（無題）" : entry.title)
        }
    }
}

private struct RowLayout<Actions: View>: View {
    let title: String
    let subtitle: String
    let image: UIImage?
    let current: Bool
    let playing: Bool
    let dimmed: Bool
    let progress: Double?
    let tap: () -> Void
    @ViewBuilder let menu: () -> Actions

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    ArtworkTile(image: image, title: title)
                    if current {
                        Color.black.opacity(0.45).clipShape(RoundedRectangle(cornerRadius: 6))
                        Image(systemName: playing ? "speaker.wave.2.fill" : "speaker.fill").foregroundStyle(.white)
                    }
                }
                .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title.isEmpty ? "（無題）" : title)
                        .font(.body)
                        .foregroundStyle(current ? Color.accentColor : (dimmed ? Color.secondary : Color.primary))
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        if let progress { ProgressView(value: progress).frame(width: 48) }
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: tap)
            Menu { menu() } label: {
                Image(systemName: "ellipsis").foregroundStyle(.secondary).frame(width: 36, height: 44).contentShape(Rectangle())
            }
        }
    }
}

private struct LocalSongRow: View {
    let entry: EntryItem
    let scope: String
    @ObservedObject var player: PlaybackEngine
    @ObservedObject var artwork: ArtworkStore
    var onRemove: (() -> Void)?

    var body: some View {
        let playable = player.canPlay(entry)
        RowLayout(title: entry.title, subtitle: playable ? "この端末のファイル" : "この端末にファイルがありません", image: nil,
                  current: player.current?.entryId == entry.id, playing: player.isPlaying, dimmed: !playable, progress: nil,
                  tap: { Task { await player.play(entryId: entry.id, scope: scope) } }) {
            if let onRemove { Button("このリストから外す", role: .destructive, action: onRemove) }
        }
    }
}

private struct BiliSongRow: View {
    let entry: EntryItem
    let scope: String
    @ObservedObject var player: PlaybackEngine
    @ObservedObject var downloads: DownloadService
    @ObservedObject var artwork: ArtworkStore
    var onRemove: (() -> Void)?

    private var key: String? { downloads.entryKeys[entry.id] }
    private var record: DeviceMediaRecord? { key.flatMap { downloads.record(key: $0) } }

    private var subtitle: String {
        guard let record else { return "Bilibili・オンライン" }
        switch record.state {
        case .completed: return "Bilibili・保存済み"
        case .failed: return "Bilibili・保存に失敗"
        case .cancelled, .notDownloaded: return "Bilibili・オンライン"
        default: return "Bilibili・保存中"
        }
    }

    var body: some View {
        _ = artwork.revision // 画像が増えたら描き直す
        return RowLayout(title: entry.title, subtitle: subtitle, image: artwork.image(for: key),
                         current: player.current?.entryId == entry.id, playing: player.isPlaying, dimmed: false,
                         progress: record?.state.inProgress == true ? key.flatMap { downloads.progress["\($0)|audio"] } : nil,
                         tap: { Task { await player.play(entryId: entry.id, scope: scope) } }) {
            if let key {
                if record?.state.inProgress == true {
                    Button("保存を取り消す", role: .destructive) { downloads.cancel(key: key) }
                } else if record?.state == .completed {
                    Button("保存を削除", role: .destructive) { Task { await downloads.remove(key: key) } }
                } else {
                    Button("音声を保存") { downloads.save(entry: entry) }
                }
            }
            if let onRemove { Button("このリストから外す", role: .destructive, action: onRemove) }
        }
    }
}
