import Combine
import SwiftUI

/// 自動リストの設定（件数・条件）。この端末だけ。同期しない。
struct AutoListSettingsView: View {
    @ObservedObject var store: AutoListSettingsStore
    let player: PlaybackEngine?
    @State private var draft = AutoListSettings()
    @State private var confirmClear = false

    var body: some View {
        Form {
            Section {
                ForEach(AutoListSettings.kinds, id: \.self) { kind in
                    Picker(AutoListSettings.listName(kind), selection: Binding(get: { draft.limits[kind] ?? 50 }, set: { draft.limits[kind] = $0; store.set(draft) })) {
                        ForEach(AutoListSettings.limitChoices, id: \.self) { Text("\($0)曲").tag($0) }
                    }
                }
            } header: { Text("曲数の上限") }
            Section {
                Picker("「よく聴く曲」の最低の回数", selection: Binding(get: { draft.frequentMin }, set: { draft.frequentMin = $0; store.set(draft) })) {
                    ForEach(AutoListSettings.frequentMinChoices, id: \.self) { Text("\($0)回以上").tag($0) }
                }
                Picker("「最近追加した曲」の期間", selection: Binding(get: { draft.recentDays }, set: { draft.recentDays = $0; store.set(draft) })) {
                    ForEach(AutoListSettings.recentDaysChoices, id: \.self) { Text($0 == 0 ? "期間を限らない" : "\($0)日以内").tag($0) }
                }
            } header: { Text("条件") }
            Section {
                Button("既定に戻す") { draft = AutoListSettings(); store.set(draft) }
                Button("再生履歴を消す", role: .destructive) { confirmClear = true }
            } footer: { Text("再生履歴は、「最近聴いた曲」に使います。消しても、再生回数は変わりません。") }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("自動リスト")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { draft = store.settings }
        .confirmationDialog("再生履歴（「最近聴いた曲」）を消します。再生回数は変わりません。", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("消す", role: .destructive) { player?.history?.clear() }
            Button("キャンセル", role: .cancel) {}
        }
    }
}

/// 再生統計：月ごとの回数と、よく聴いた曲（再生回数の記録から。同期した他の端末の回数を含む）。
struct StatsView: View {
    let player: PlaybackEngine?
    @State private var stats: PlayStats?
    @State private var extrasRevision = 0

    private var extrasChanges: AnyPublisher<Int, Never> {
        guard let player else { return Empty(completeImmediately: false).eraseToAnyPublisher() }
        return player.$extrasRevision.eraseToAnyPublisher()
    }

    var body: some View {
        List {
            if let stats {
                Section {
                    Text("合計 \(stats.total) 回").font(.system(size: 15, weight: .semibold))
                    Text("この端末の再生時間 \(PlayTimeStore.formatDuration(stats.totalSeconds))").font(.system(size: 14))
                } footer: { Text("回数は同期した他の端末を含みます。再生時間はバックグラウンド再生を含み、この端末だけに記録します。") }
                Section("月ごとの再生回数（最近12か月）") {
                    let peak = max(1, stats.months.map(\.plays).max() ?? 1)
                    ForEach(stats.months) { month in
                        HStack(spacing: 8) {
                            Text(month.month).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 64, alignment: .leading)
                            GeometryReader { proxy in
                                Capsule().fill(Theme.accent).frame(width: max(2, proxy.size.width * CGFloat(month.plays) / CGFloat(peak)), height: 8).frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(height: 12)
                            Text("\(month.plays)").font(.system(size: 12).monospacedDigit()).frame(width: 44, alignment: .trailing)
                        }
                    }
                }
                Section("月ごとの再生時間（最近12か月）") {
                    let peakSeconds = max(1, stats.months.map(\.seconds).max() ?? 1)
                    ForEach(stats.months) { month in
                        HStack(spacing: 8) {
                            Text(month.month).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 64, alignment: .leading)
                            GeometryReader { proxy in
                                Capsule().fill(Theme.accent).frame(width: max(2, proxy.size.width * CGFloat(month.seconds) / CGFloat(peakSeconds)), height: 8).frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(height: 12)
                            Text(PlayTimeStore.formatDuration(month.seconds)).font(.system(size: 12).monospacedDigit()).lineLimit(1).frame(minWidth: 56, alignment: .trailing)
                        }
                    }
                }
                songs("今月よく聴いた曲", stats.thisMonthTop)
                songs("これまでによく聴いた曲（上位20）", stats.top)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("再生統計")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: extrasRevision) { stats = await player?.playStats() ?? PlayStats() }
        .onReceive(extrasChanges) { extrasRevision = $0 }
    }

    @ViewBuilder private func songs(_ title: String, _ items: [StatsSong]) -> some View {
        Section(title) {
            if items.isEmpty { Text("まだ記録がありません").font(.footnote).foregroundStyle(Theme.muted) }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack {
                    Text("\(index + 1). \(item.title)").font(.system(size: 13)).lineLimit(1)
                    Spacer()
                    Text("\(item.count)回").font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.muted)
                }
            }
        }
    }
}
