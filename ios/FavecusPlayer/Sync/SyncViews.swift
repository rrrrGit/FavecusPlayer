import SwiftUI

/// 同期の仮の最小画面（Step15で置き換える）。接続先・サインイン（メールのコード）・有効化と、状態の表示。
struct SyncSheet: View {
    @ObservedObject var sync: SyncCoordinator
    @Binding var isPresented: Bool
    @State private var url = ""
    @State private var key = ""
    @State private var email = ""
    @State private var code = ""
    @State private var message: String?
    @State private var working = false

    private var status: SyncStatus { sync.status }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(label).font(.footnote)
                    if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                Section("1. 接続先") {
                    TextField("Project URL（https://xxxx.supabase.co）", text: $url).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("anon（publishable）キー", text: $key)
                    Button("接続先を保存") { run { try await sync.configure(url: url, anonKey: key); message = "接続先を保存しました。" } }
                        .disabled(status.enabled || working)
                    Text("公開してよいキーだけを入力します。service_role・secretキーは使えません。").font(.caption).foregroundStyle(.secondary)
                }
                Section("2. サインイン（メールのワンタイムコード）") {
                    TextField("メールアドレス", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("コードを送る") { run { try await sync.sendCode(email: email); message = "コードをメールで送りました。" } }
                        .disabled(!status.configured || working)
                    TextField("届いたコード", text: $code).keyboardType(.numberPad)
                    Button("サインイン") { run { try await sync.verifyCode(email: email, code: code); message = "サインインしました。" } }
                        .disabled(!status.configured || working)
                    Button("サインアウト") { sync.signOut() }.disabled(!status.signedIn || status.enabled)
                }
                Section("3. 同期") {
                    Button("同期を有効にする") { run { try await sync.enable(); message = "同期を有効にしました。" } }
                        .disabled(status.enabled || !status.signedIn || working)
                    Button("今すぐ同期") { run { _ = await sync.syncNow() } }.disabled(!status.enabled || working)
                    Button("同期を止める") { sync.disable() }.disabled(!status.enabled)
                    Button("接続を初期化", role: .destructive) { sync.resetLink() }.disabled(status.enabled)
                    Text("有効にする前に、現在の保存データのバックアップを残します。止めても、プレイリストや同期データは消えません。Supabaseの無料枠は、1週間ほど使われないと一時停止します（ダッシュボードで再開でき、データは残ります）。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("プレイリストの同期")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } }
            }
            .onAppear {
                url = status.url
                email = status.email
            }
        }
    }

    private var label: String {
        switch status.state {
        case .blocked: return "同期を停止しています：\(status.message)"
        case .off: return status.signedIn ? "同期：オフ（サインイン済み：\(status.email)）" : "同期：オフ"
        case .syncing: return "同期しています…"
        case .error: return "同期に失敗しました：\(status.message)（変更は保持しています。つながると自動で再試行します）"
        case .idle:
            let when = status.lastSyncAt > 0 ? Date(timeIntervalSince1970: status.lastSyncAt / 1000).formatted(date: .abbreviated, time: .shortened) : "未同期"
            let extra = (status.pending > 0 ? "・未送信 \(status.pending)件" : "") + (status.conflicts > 0 ? "・保留した変更 \(status.conflicts)件" : "")
            return "同期：オン・最終 \(when)\(extra)"
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        working = true
        message = nil
        Task {
            do { try await action() } catch { message = String(describing: error) }
            working = false
        }
    }
}
