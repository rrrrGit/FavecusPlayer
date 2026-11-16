import SwiftUI

/// アラームの一覧（設定タブから開く）。追加・編集・有効／無効・削除。
struct AlarmListView: View {
    @ObservedObject var service: AlarmService
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
                            Text(Self.summary(item)).font(.footnote).foregroundStyle(Theme.muted)
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
                Text("iOS 26以降で使えます。消音や集中モードでも鳴ります。音は、いまは既定の音です。")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("アラーム")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { editing = AlarmItem(hour: 7, minute: 0) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("アラームを追加")
            }
        }
        .sheet(item: $editing) { item in
            AlarmEditor(item: item) { saved in Task { await service.save(saved) } }
        }
        .confirmationDialog("このアラームを削除しますか", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("削除する", role: .destructive) {
                if let target = pendingDelete { Task { await service.remove(id: target.id) } }
                pendingDelete = nil
            }
            Button("キャンセル", role: .cancel) { pendingDelete = nil }
        }
        .task { await service.resync() }
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
    @State private var time: Date
    let onSave: (AlarmItem) -> Void

    init(item: AlarmItem, onSave: @escaping (AlarmItem) -> Void) {
        _item = State(initialValue: item)
        _time = State(initialValue: Calendar.current.date(from: DateComponents(hour: item.hour, minute: item.minute)) ?? Date())
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("時刻", selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                    .frame(maxWidth: .infinity)
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
                Section("ラベル") {
                    TextField("アラーム", text: $item.label)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("アラームの編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
                        var saved = item
                        saved.hour = parts.hour ?? 7
                        saved.minute = parts.minute ?? 0
                        saved.enabled = true
                        onSave(saved)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.large])
    }
}
