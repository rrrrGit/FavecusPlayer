import SwiftUI

/// 自動リスト（v0.7.3 F3）：よく聴く曲・最近追加した曲・未再生。PC版と同じ選び方（共通JS：src/core/auto-lists.cjs）。
/// 保存せず、ライブラリと再生回数から、その都度作る（同期しない・編集しない）。
enum AutoListKind: String, CaseIterable, Hashable, Identifiable {
    case frequent, recent, unplayed
    var id: String { rawValue }
    var title: String {
        switch self {
        case .frequent: return "よく聴く曲"
        case .recent: return "最近追加した曲"
        case .unplayed: return "未再生"
        }
    }
    var note: String {
        switch self {
        case .frequent: return "再生回数の多い順（上位50曲）"
        case .recent: return "登録の新しい順（50曲）"
        case .unplayed: return "まだ聴いていない曲（登録の新しい順）"
        }
    }
    var icon: String {
        switch self {
        case .frequent: return "chart.bar"
        case .recent: return "clock"
        case .unplayed: return "sparkles"
        }
    }
    /// 再生範囲の名前（共通JSの再生キューでは、曲のIDの並びを直接渡し、この名前は表示用）。
    var scope: String { "auto:" + rawValue }
}

struct AutoListItem: Decodable, Equatable {
    let id: String
    let playlistId: String
    let count: Int
}

struct AutoListsResult: Decodable, Equatable {
    var frequent: [AutoListItem] = []
    var recent: [AutoListItem] = []
    var unplayed: [AutoListItem] = []

    func items(_ kind: AutoListKind) -> [AutoListItem] {
        switch kind {
        case .frequent: return frequent
        case .recent: return recent
        case .unplayed: return unplayed
        }
    }
}

@MainActor
final class AutoListsModel: ObservableObject {
    @Published private(set) var result = AutoListsResult()

    func reload(_ player: PlaybackEngine?) async {
        if let next = await player?.autoLists(), next != result { result = next }
    }
}

/// ホームの、自分のプレイリストの下に置く3つのカード。
struct AutoListsSection: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    @StateObject private var model = AutoListsModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "自動リスト")
            ForEach(AutoListKind.allCases) { kind in
                NavigationLink(value: kind) {
                    HStack(spacing: 12) {
                        Image(systemName: kind.icon).frame(width: 24).foregroundStyle(Theme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(kind.title).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                            Text(kind.note).font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        Text("\(model.result.items(kind).count)曲").font(.system(size: 12)).foregroundStyle(Theme.faint)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                }
                .buttonStyle(.plain)
            }
        }
        .task(id: store.document) { await model.reload(services.player) } // 表示のたびにも走るため、onAppearでの二重の読み込みはしない
    }
}

/// 自動リストの曲の一覧。曲を押すと、この一覧の順（開いた時点の並び）で再生する。
struct AutoListDetail: View {
    let kind: AutoListKind
    @ObservedObject var store: LibraryStore
    let services: Services
    @StateObject private var model = AutoListsModel()

    private var items: [AutoListItem] { model.result.items(kind) }
    private var titles: [String: String] {
        var map: [String: String] = [:]
        for list in store.document?.playlists ?? [] { for entry in list.entries where map[entry.id] == nil { map[entry.id] = entry.title.isEmpty ? "（無題）" : entry.title } }
        return map
    }

    private func play(_ entryId: String?) {
        guard let player = services.player, !items.isEmpty else { return }
        let ids = items.map(\.id)
        OpenPlayer.request(after: 0.45)
        Task { await player.play(entryId: entryId, scope: kind.scope, entryIds: ids) }
    }

    var body: some View {
        List {
            Text(kind.note).font(.system(size: 12)).foregroundStyle(Theme.muted)
                .listRowBackground(Theme.background).listRowSeparator(.hidden)
            HStack(spacing: 10) {
                Button { play(nil) } label: { Label("再生", systemImage: "play.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryButtonStyle())
                Button { shuffled() } label: { Label("シャッフル", systemImage: "shuffle").frame(maxWidth: .infinity) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .disabled(items.isEmpty)
            .listRowBackground(Theme.background).listRowSeparator(.hidden)
            if items.isEmpty {
                Text("まだ曲がありません").font(.system(size: 13)).foregroundStyle(Theme.muted).listRowBackground(Theme.background)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                Button { play(item.id) } label: {
                    HStack(spacing: 10) {
                        Text(String(format: "%02d", index + 1)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.faint).frame(width: 26, alignment: .leading)
                        Text(titles[item.id] ?? "（無題）").font(.system(size: 15)).foregroundStyle(Theme.text).lineLimit(1)
                        Spacer()
                        if kind == .frequent { Text("\(item.count)回").font(.system(size: 12)).foregroundStyle(Theme.accent) }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Theme.background)
            }
            Color.clear.frame(height: 80).listRowBackground(Theme.background).listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.document) { await model.reload(services.player) }
    }

    private func shuffled() {
        guard let player = services.player, !items.isEmpty else { return }
        let ids = items.map(\.id)
        OpenPlayer.request(after: 0.45)
        Task { await player.play(entryId: nil, scope: kind.scope, entryIds: ids) }
    }
}
