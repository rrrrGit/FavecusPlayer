import SwiftUI

/// 曲の並べ替え・絞り込みを選ぶ画面（リストごと）。選んだ順で、そのリストを再生する（保存した順は変わらない）。
struct EntryViewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var setting: EntryViewSetting
    let onApply: (EntryViewSetting) -> Void

    init(initial: EntryViewSetting, onApply: @escaping (EntryViewSetting) -> Void) {
        _setting = State(initialValue: initial)
        self.onApply = onApply
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("このプレイリストの曲の、並べ替えと絞り込みです。選んだ順で、このリストを再生します。保存した順は変わりません。").font(.footnote).foregroundStyle(Theme.muted)
                }
                Section("並べ替え") {
                    Picker("並べ替え", selection: $setting.sort) {
                        ForEach(EntryViewSetting.sorts, id: \.self) { Text(EntryViewSetting.label(sort: $0)).tag($0) }
                    }
                }
                Section("絞り込み") {
                    Picker("お気に入り", selection: $setting.favorite) { ForEach(EntryViewSetting.favorites, id: \.self) { Text(EntryViewSetting.label(favorite: $0)).tag($0) } }
                    Picker("保存", selection: $setting.saved) { ForEach(EntryViewSetting.saveds, id: \.self) { Text(EntryViewSetting.label(saved: $0)).tag($0) } }
                    Picker("種類", selection: $setting.source) { ForEach(EntryViewSetting.sources, id: \.self) { Text(EntryViewSetting.label(source: $0)).tag($0) } }
                    Picker("再生", selection: $setting.played) { ForEach(EntryViewSetting.playeds, id: \.self) { Text(EntryViewSetting.label(played: $0)).tag($0) } }
                }
                Section {
                    Button("元に戻す", role: .destructive) { setting = EntryViewSetting() }.disabled(!setting.isActive)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("曲の並べ替え・絞り込み")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("決定") { onApply(setting); dismiss() } }
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
    }
}
