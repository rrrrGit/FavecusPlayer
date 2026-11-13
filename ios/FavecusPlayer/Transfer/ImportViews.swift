import SwiftUI

/// 取り込みの仮の最小画面（Step15で置き換える）。状態の表示と、取り込むリストの選択だけ。
struct ImportSheet: View {
    @ObservedObject var coordinator: ImportCoordinator
    @Binding var isPresented: Bool
    @State private var selected: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                switch coordinator.phase {
                case .idle:
                    ProgressView()
                case .preparing:
                    ProgressView("アーカイブを確認しています…")
                case .choosing(let plan):
                    chooser(plan)
                case .importing:
                    ProgressView("取り込んでいます…（画面を閉じずにお待ちください）")
                case .done(let outcome):
                    result(outcome)
                case .failed(let message):
                    failure(message)
                }
            }
            .navigationTitle("取り込み")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("閉じる") { coordinator.cancel(); isPresented = false }
                }
            }
        }
        .interactiveDismissDisabled({ if case .importing = coordinator.phase { return true } else { return false } }())
    }

    private func chooser(_ plan: ImportPlan) -> some View {
        List {
            Section {
                Text(plan.mode == "information" ? "情報のみ（ローカル曲の実体は含まれません）" : plan.mode == "media" ? "メディア付き" : "旧形式")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("親を選ぶと、その子も一緒に取り込みます。同じ名前のリストは「（取り込みN）」を付けて追加し、既存のリストは変更しません。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("取り込むプレイリスト") {
                ForEach(plan.lists) { list in
                    Toggle(isOn: Binding(get: { selected.contains(list.id) }, set: { on in if on { selected.insert(list.id) } else { selected.remove(list.id) } })) {
                        VStack(alignment: .leading) {
                            Text(list.name)
                            Text("\(list.count)曲・子 \(list.childIds.count)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                Button("取り込む（\(selected.count)件）") {
                    let ids = plan.lists.map(\.id).filter { selected.contains($0) }
                    Task { await coordinator.commit(ids: ids) }
                }
                .disabled(selected.isEmpty)
            }
        }
        .onAppear { if selected.isEmpty { selected = Set(plan.rootPlaylistIds) } }
    }

    private func result(_ outcome: ImportOutcome) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle").font(.largeTitle)
            Text("\(outcome.imported)件のプレイリストを取り込みました").font(.headline)
            if outcome.copied > 0 { Text("ローカル曲のメディア \(outcome.copied)件を保存しました") }
            if outcome.missing > 0 { Text("実体のないローカル曲が \(outcome.missing)件あります（情報のみ取り込みました）").font(.footnote) }
            if outcome.omitted > 0 { Text("情報のみのため、ローカル曲 \(outcome.omitted)件は再生できません").font(.footnote) }
            Button("閉じる") { coordinator.cancel(); isPresented = false }.padding(.top)
        }
        .padding()
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle)
            Text("取り込めませんでした").font(.headline)
            Text(message).font(.footnote).multilineTextAlignment(.center)
            Text("保存データは変更していません。").font(.footnote).foregroundStyle(.secondary)
            Button("閉じる") { coordinator.cancel(); isPresented = false }.padding(.top)
        }
        .padding()
    }
}
