import SwiftUI

/// アラームの一覧（設定タブから開く）。追加・編集・有効／無効・削除。
struct AlarmListView: View {
    @ObservedObject var service: AlarmService
    let catalog: AlarmSongCatalog?
    /// 画面確認用：開いてすぐ、編集の画面を出す。
    var startEditing = false
    @State private var editing: AlarmItem?
    @State private var pendingDelete: AlarmItem?

    static let weekdayNames = ["日", "月", "火", "水", "木", "金", "土"]

    var body: some View {
        List {
            if service.alarms.isEmpty {
                Text("アラームはまだありません").foregroundStyle(Theme.muted)
            }
            ForEach(sorted) { item in
                HStack(spacing: 12) {
                    Button { editing = item } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Self.timeText(item)).font(.system(size: 32, weight: .regular)).monospacedDigit()
                            HStack(spacing: 6) {
                                Text(Self.summary(item))
                                if item.sound != nil { Image(systemName: "music.note").imageScale(.small) }
                            }
                            .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Toggle("有効", isOn: Binding(get: { item.enabled }, set: { value in Task { await service.setEnabled(id: item.id, value) } }))
                        .labelsHidden()
                }
                .opacity(item.enabled ? 1 : 0.5)
                .swipeActions {
                    Button("削除", role: .destructive) { pendingDelete = item }
                }
            }
            if let notice = service.notice {
                Text(notice).font(.footnote).foregroundStyle(Theme.warning)
            }
            Section {} footer: {
                Text("iOS 26以降で使えます。消音や集中モードでも鳴ります。音は、保存済みの曲と範囲を選べます（選ばないと既定の音）。")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("アラーム")
        .navigationBarTitleDisplayMode(.inline)
        .tint(Theme.accent)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { editing = AlarmItem(hour: 7, minute: 0) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("アラームを追加")
            }
        }
        .sheet(item: $editing) { item in
            AlarmEditor(item: item, catalog: catalog) { saved in Task { await service.save(saved) } }
        }
        .confirmationDialog("このアラームを削除しますか", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("削除する", role: .destructive) {
                if let target = pendingDelete { Task { await service.remove(id: target.id) } }
                pendingDelete = nil
            }
            Button("キャンセル", role: .cancel) { pendingDelete = nil }
        }
        .task {
            await service.resync()
            if startEditing, editing == nil { editing = service.alarms.first ?? AlarmItem(hour: 7, minute: 0) }
        }
    }

    private var sorted: [AlarmItem] {
        service.alarms.sorted { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
    }

    static func timeText(_ item: AlarmItem) -> String {
        String(format: "%d:%02d", item.hour, item.minute)
    }

    static func summary(_ item: AlarmItem) -> String {
        let days: String
        if item.weekdays.isEmpty { days = "1回だけ" }
        else if item.weekdays.count == 7 { days = "毎日" }
        else { days = item.weekdays.sorted().map { weekdayNames[$0 - 1] }.joined(separator: " ") }
        return item.label.isEmpty ? days : "\(item.label)・\(days)"
    }
}

/// 1件の編集（時刻・曜日・ラベル）。
struct AlarmEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var item: AlarmItem
    @State private var showSoundPicker = false
    let catalog: AlarmSongCatalog?
    let onSave: (AlarmItem) -> Void

    init(item: AlarmItem, catalog: AlarmSongCatalog?, onSave: @escaping (AlarmItem) -> Void) {
        self.catalog = catalog
        _item = State(initialValue: item)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                // 時刻は、端末の12時間／24時間の設定に関係なく、0〜23時・0〜59分の24時間表示で選ぶ
                HStack(spacing: 0) {
                    Picker("時", selection: $item.hour) {
                        ForEach(0..<24, id: \.self) { Text("\($0)").tag($0) }
                    }
                    .pickerStyle(.wheel)
                    .labelsHidden()
                    Text("時").foregroundStyle(Theme.muted)
                    Picker("分", selection: $item.minute) {
                        ForEach(0..<60, id: \.self) { Text(String(format: "%02d", $0)).tag($0) }
                    }
                    .pickerStyle(.wheel)
                    .labelsHidden()
                    Text("分").foregroundStyle(Theme.muted)
                }
                .frame(height: 160)
                .clipped()
                Section("繰り返し") {
                    HStack(spacing: 8) {
                        ForEach(1...7, id: \.self) { day in
                            let on = item.weekdays.contains(day)
                            Button {
                                if on { item.weekdays.remove(day) } else { item.weekdays.insert(day) }
                            } label: {
                                Text(AlarmListView.weekdayNames[day - 1])
                                    .font(.subheadline.weight(.medium))
                                    .frame(maxWidth: .infinity, minHeight: 40)
                                    .background(on ? Theme.accent : Theme.control, in: Circle())
                                    .foregroundStyle(on ? Theme.accentText : Theme.text)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(AlarmListView.weekdayNames[day - 1] + "曜日")
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                    Text("選ばないと、次の1回だけ鳴ります。").font(.footnote).foregroundStyle(Theme.muted)
                }
                if let catalog {
                    Section("音") {
                        // 曲・範囲を決めたら、この編集の画面に戻る（画面全体は閉じない）。アラームは「保存」で作られる。
                        Button { showSoundPicker = true } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("曲と範囲").foregroundStyle(Theme.text)
                                    Text(Self.soundText(item.sound, catalog)).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Section("ラベル") {
                    TextField("アラーム", text: $item.label)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("アラームの編集")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $showSoundPicker) {
                if let catalog {
                    AlarmSoundPicker(catalog: catalog, current: item.sound) { picked in
                        item.sound = picked
                        showSoundPicker = false
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        var saved = item
                        saved.enabled = true
                        onSave(saved)
                        dismiss()
                    }
                }
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.large])
    }

    static func soundText(_ sound: AlarmSound?, _ catalog: AlarmSongCatalog) -> String {
        guard let sound else { return "既定の音" }
        let title = catalog.songs().first { $0.key == sound.mediaKey }?.title ?? "（曲が見つかりません）"
        return "\(title)・\(AlarmRangeEditor.clock(sound.startSeconds))から\(Int(sound.durationSeconds))秒"
    }
}

/// タブ「アラーム」（保存と設定の間）。
struct AlarmTab: View {
    @ObservedObject var store: LibraryStore
    let services: Services
    @Binding var showPlayer: Bool

    var body: some View {
        NavigationStack {
            AlarmListView(service: AppEnvironment.shared.alarms, catalog: AlarmSongCatalog(store: store, downloads: services.downloads))
        }
        .miniPlayer(services, showPlayer: $showPlayer)
    }
}
