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
                    Button("閉じる") { coordinator.cancel(); isPresented = false }.disabled(coordinator.isBusy) // 取り込み中は閉じられない
                }
            }
        }
        .onDisappear { if !coordinator.isBusy { coordinator.cancel() } } // スワイプで閉じたときも、一時コピーとアクセス権を後始末する
        .interactiveDismissDisabled(coordinator.isBusy)
    }

    private func chooser(_ plan: ImportPlan) -> some View {
        List {
            Section {
                Text(plan.mode == "information" ? "情報のみ（ローカル曲の実体は含まれません）" : plan.mode == "media" ? "メディア付き" : "旧形式")
                    .font(.footnote).foregroundStyle(.secondary)
                if !plan.downloads.isEmpty { Text("保存済みの動画・音声 \(plan.downloads.count)件を含みます（取り込むリストの曲の分を、この端末へ保存します）。").font(.footnote).foregroundStyle(.secondary) }
                Text("親を選ぶと、その子も一緒に取り込みます。すでに同じ構成のプレイリスト（同期済みのものなど）は、二重に取り込みません。名前だけが同じで中身が違うリストは「（取り込みN）」を付けて追加し、既存のリストは変更しません。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("取り込むプレイリスト") {
                ForEach(plan.lists) { list in
                    Toggle(isOn: Binding(get: { selected.contains(list.id) }, set: { on in if on { selected.insert(list.id) } else { selected.remove(list.id) } })) {
                        VStack(alignment: .leading) {
                            Text(list.name)
                            Text("\(list.count)曲・子 \(list.childIds.count)").font(.caption).foregroundStyle(.secondary)
                            if plan.identicalIds.contains(list.id) { Text("すでにあります（同じ構成）").font(.caption).foregroundStyle(Theme.mint) }
                        }
                    }
                }
            }
            if !plan.downloads.isEmpty {
                Section {
                    Button("保存済みの動画・音声だけを取り込む") { Task { await coordinator.importMediaOnly() } }
                } footer: {
                    Text("プレイリストは取り込まず、この端末にある曲の分の動画・音声だけを取り込みます。")
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
        // 初めの選択：すでに同じ構成のものがあるリストは、選ばない
        .onAppear { if selected.isEmpty { selected = Set(plan.rootPlaylistIds).subtracting(plan.identicalIds) } }
    }

    private func result(_ outcome: ImportOutcome) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle").font(.largeTitle)
            Text("\(outcome.imported)件のプレイリストを取り込みました").font(.headline)
            if outcome.skippedIdentical > 0 { Text("すでに同じ構成の \(outcome.skippedIdentical)件は、取り込みませんでした").font(.footnote) }
            if outcome.downloaded > 0 { Text("保存済みの動画・音声 \(outcome.downloaded)件を、この端末へ保存しました") }
            if outcome.downloadsFailed > 0 { Text("保存済みの動画・音声 \(outcome.downloadsFailed)件は、読み取れず、取り込めませんでした").font(.footnote).foregroundStyle(Theme.warning) }
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
            Button("エラーの内容をコピー") { Clipboard.copy(message) }.padding(.top, 8)
            Button("閉じる") { coordinator.cancel(); isPresented = false }.padding(.top)
        }
        .padding()
    }
}
