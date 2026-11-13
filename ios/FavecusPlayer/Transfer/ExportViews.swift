import SwiftUI

/// 出力の仮の最小画面（Step15で置き換える）。出力方式を選び、共有シート（ShareLink）で保存・送信する。
struct ExportSheet: View {
    @ObservedObject var coordinator: ExportCoordinator
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            Group {
                switch coordinator.phase {
                case .idle:
                    List {
                        Section {
                            Text("Windows版で取り込める形式のZIPを作ります。メディア付きは、この端末に保存したローカル曲の実体を含みます。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Section {
                            Button("メディア付きで出力") { Task { await coordinator.run(mode: "media") } }
                            Button("情報のみで出力") { Task { await coordinator.run(mode: "information") } }
                        }
                    }
                case .working:
                    ProgressView("出力しています…")
                case .ready(let result):
                    VStack(spacing: 12) {
                        Image(systemName: "checkmark.circle").font(.largeTitle)
                        Text("\(result.lists)件のプレイリストを出力しました").font(.headline)
                        if result.copied > 0 { Text("ローカル曲のメディア \(result.copied)件を含みます") }
                        if result.missing > 0 { Text("実体のないローカル曲 \(result.missing)件は、情報のみ含めました").font(.footnote) }
                        if result.omitted > 0 { Text("情報のみのため、ローカル曲 \(result.omitted)件の実体は含めていません").font(.footnote) }
                        ShareLink(item: result.url) { Label("共有・保存", systemImage: "square.and.arrow.up") }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding()
                case .failed(let message):
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                        Text("出力できませんでした").font(.headline)
                        Text(message).font(.footnote).multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
            .navigationTitle("出力")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("閉じる") { coordinator.cleanup(); isPresented = false }
                }
            }
        }
    }
}
