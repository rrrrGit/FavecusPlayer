import SwiftUI

struct PlaceholderView: View {
    @State private var benchText = ""
    @State private var running = false

    var body: some View {
        VStack(spacing: 12) {
            Text(AppInfo.name)
                .font(.largeTitle.bold())
            Text(AppInfo.versionText)
            Text(AppInfo.stage)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(running ? "計測中…" : "共通処理の速度を計測（999リスト・約1万登録）") {
                runBench()
            }
            .disabled(running)
            .padding(.top, 16)
            if !benchText.isEmpty {
                Text(benchText)
                    .font(.system(.footnote, design: .monospaced))
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
            }
        }
        .padding()
    }

    /// 実機での速度を確認するための仮機能（Step3）。画面はStep15で置き換える。
    private func runBench() {
        running = true
        benchText = ""
        DispatchQueue.global(qos: .userInitiated).async {
            let text: String
            do {
                let core = try SharedCore(bundle: .main)
                text = try core.call("Bench", "{}")
                    .replacingOccurrences(of: ",\"", with: "\n\"")
                    .replacingOccurrences(of: "{", with: "")
                    .replacingOccurrences(of: "}", with: "")
            } catch {
                text = "失敗: \(error)"
            }
            DispatchQueue.main.async { benchText = text; running = false }
        }
    }
}
