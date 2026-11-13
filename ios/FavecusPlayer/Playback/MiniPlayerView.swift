import SwiftUI

/// 曲の1行。再生できる曲（この端末に実体のあるローカル曲）は押すと再生、それ以外は薄く表示し、押すと理由を出す。
struct EntryRow: View {
    let entry: EntryItem
    let player: PlaybackEngine?
    let scope: String

    var body: some View {
        if let player {
            PlayableEntryRow(entry: entry, player: player, scope: scope)
        } else {
            Text(entry.title.isEmpty ? "（無題）" : entry.title)
        }
    }
}

private struct PlayableEntryRow: View {
    let entry: EntryItem
    @ObservedObject var player: PlaybackEngine
    let scope: String

    private var playable: Bool { player.canPlay(entry) }
    private var isCurrent: Bool { player.current?.entryId == entry.id }

    var body: some View {
        Button {
            Task { await player.play(entryId: entry.id, scope: scope) }
        } label: {
            HStack {
                if isCurrent { Image(systemName: player.isPlaying ? "speaker.wave.2.fill" : "speaker.fill").foregroundStyle(.tint) }
                Text(entry.title.isEmpty ? "（無題）" : entry.title)
                    .foregroundStyle(playable ? Color.primary : Color.secondary)
                Spacer()
                if !playable { Image(systemName: "icloud.slash").font(.caption).foregroundStyle(.secondary) }
            }
        }
        .buttonStyle(.plain)
    }
}

/// 画面下のミニプレイヤー（仮の最小画面。Step15で置き換える）。曲がないときは何も出さない。
struct MiniPlayerBar: View {
    @ObservedObject var player: PlaybackEngine

    var body: some View {
        VStack(spacing: 0) {
            if let current = player.current {
                Divider()
                VStack(spacing: 6) {
                    HStack {
                        Text(current.title).font(.subheadline).lineLimit(1)
                        Spacer()
                        Button { player.previous() } label: { Image(systemName: "backward.fill") }
                        Button { player.toggle() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").frame(width: 32) }
                        Button { player.next() } label: { Image(systemName: "forward.fill") }
                    }
                    HStack(spacing: 16) {
                        Button { player.shuffle.toggle() } label: { Image(systemName: "shuffle").foregroundStyle(player.shuffle ? Color.accentColor : Color.secondary) }
                        Slider(value: Binding(get: { min(player.position, max(player.duration, 1)) }, set: { player.seek(to: $0) }), in: 0...max(player.duration, 1))
                        Button { cycleRepeat() } label: {
                            Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat").foregroundStyle(player.repeatMode == .off ? Color.secondary : Color.accentColor)
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .alert("お知らせ", isPresented: Binding(get: { player.message != nil }, set: { if !$0 { player.message = nil } })) {
            Button("閉じる", role: .cancel) { player.message = nil }
        } message: {
            Text(player.message ?? "")
        }
    }

    private func cycleRepeat() {
        switch player.repeatMode {
        case .off: player.repeatMode = .all
        case .all: player.repeatMode = .one
        case .one: player.repeatMode = .off
        }
    }
}
