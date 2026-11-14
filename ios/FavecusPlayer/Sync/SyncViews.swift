import SwiftUI

/// プレイリストの同期の画面：1. 接続先 → 2. サインイン（メールのコード）→ 3. 同期。
/// 手順の前提を満たさないとき（例：サインイン前の「同期を有効にする」）は、押したときに理由を表示する。状態によって意味のないボタン（同期中の「今すぐ同期」など）だけ、薄くして押せなくする。
/// 「コードを送る」「サインイン」の前に、入力した接続先が未保存なら、自動で保存する。
struct SyncSheet: View {
    @ObservedObject var sync: SyncCoordinator
    @Binding var isPresented: Bool
    @State private var url = ""
    @State private var key = ""
    @State private var email = ""
    @State private var code = ""
    @State private var message: String?
    @State private var failed = false
    @State private var working = false
    @State private var pending: Pending?

    private var status: SyncStatus { sync.status }

    /// 確認してから行う操作（サーバーや端末の内容を置き換える・接続を消す）。
    private struct Pending: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let run: () -> Void
    }

    private func ask(_ title: String, _ message: String, _ run: @escaping () -> Void) { pending = Pending(title: title, message: message, run: run) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusCard
                    if let message {
                        HStack(alignment: .top) {
                            Text(message).font(.system(size: 13)).foregroundStyle(failed ? Theme.warning : Theme.mint).textSelection(.enabled)
                            Spacer(minLength: 0)
                            if failed { Button { Clipboard.copy(message) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).accessibilityLabel("エラーの内容をコピー") }
                        }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel))
                    }
                    card(number: "1", title: "接続先", done: status.configured) {
                        field("Project URL（https://xxxx.supabase.co）") { TextField("", text: $url).keyboardType(.URL) }
                        field(status.configured ? "anon（publishable）キー（保存済み。変えるときだけ入力）" : "anon（publishable）キー") { SecureField("", text: $key) }
                        action("接続先を保存", style: .secondary, disabled: status.enabled) { try await saveConnection() }
                        note("公開してよいキーだけを入力します。service_role・secretキーは使えません。")
                    }
                    card(number: "2", title: "サインイン（メールのワンタイムコード）", done: status.signedIn) {
                        field("メールアドレス") { TextField("", text: $email).keyboardType(.emailAddress) }
                        action("コードを送る", style: .secondary) {
                            try await ensureConnection()
                            try await sync.sendCode(email: email)
                            report("コードをメールで送りました。届いた数字を、下の欄に入力してください。")
                        }
                        field("届いたコード") { TextField("", text: $code).keyboardType(.numberPad) }
                        action("サインイン", style: .primary) {
                            try await ensureConnection()
                            try await sync.verifyCode(email: email, code: code)
                            report("サインインしました。次は、3. 同期の「同期を有効にする」を押します。")
                        }
                        if status.signedIn {
                            action("サインアウト", style: .secondary, disabled: status.enabled) { ask("サインアウトしますか？", "このiPhoneのサインイン情報を消します。同期のデータは消えません。") { sync.signOut(); report("サインアウトしました。") } }
                        }
                    }
                    card(number: "3", title: "同期", done: status.enabled) {
                        action("同期を有効にする", style: .primary, disabled: status.enabled) {
                            guard status.signedIn else { throw SyncFormError("先に、2. サインインを済ませてください。") }
                            try await sync.enable()
                            report("同期を有効にしました。")
                        }
                        action("今すぐ同期", style: .secondary, disabled: !status.enabled) { _ = await sync.syncNow() }
                        action("同期を止める", style: .secondary, disabled: !status.enabled) { sync.disable(); report("同期を止めました。") }
                        action("接続を初期化", style: .secondary, disabled: status.enabled) { ask("接続を初期化しますか？", "保存した接続先と同期の状態を消します。プレイリストや、サーバーのデータは消えません。") { sync.resetLink(); report("接続を初期化しました。") } }
                        if status.canUnblock {
                            action("サーバーの内容で復元", style: .primary) { ask("サーバーの内容で復元しますか？", "この端末のプレイリストを、サーバーの内容に置き換えます（置き換える前のバックアップを残します）。") { perform { try await sync.unblock(mode: "restore"); report("同期した内容で復元しました。") } } }
                            action("この端末の内容を正とする", style: .secondary) { ask("この端末の内容を正としますか？", "サーバーと他の端末にある、この端末にない内容を削除します。") { perform { try await sync.unblock(mode: "keep"); report("同期しました。") } } }
                            note("「この端末の内容を正とする」は、サーバーと他の端末にある、この端末にない内容を削除します。")
                        }
                        note("有効にする前に、現在の保存データのバックアップを残します。止めても、プレイリストや同期データは消えません。Supabaseの無料枠は、1週間ほど使われないと一時停止します（ダッシュボードで再開でき、データは残ります）。")
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.background)
            .confirmationDialog(pending?.title ?? "", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible, presenting: pending) { item in
                Button("実行する", role: .destructive) { item.run() }
                Button("キャンセル", role: .cancel) {}
            } message: { item in
                Text(item.message)
            }
            .navigationTitle("プレイリストの同期")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } } }
            .onAppear {
                url = status.url
                email = status.email
            }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
    }

    // MARK: 部品

    private var statusCard: some View {
        HStack(spacing: 10) {
            Circle().fill(status.enabled ? Theme.mint : Theme.faint).frame(width: 8, height: 8)
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.text)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
    }

    private func card<Content: View>(number: String, title: String, done: Bool, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text(number).font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.accentText)
                    .frame(width: 22, height: 22).background(Circle().fill(done ? Theme.mint : Theme.accent))
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                if done { Text("完了").font(.system(size: 11)).foregroundStyle(Theme.mint) }
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
    }

    private func field<Field: View>(_ placeholder: String, @ViewBuilder _ content: () -> Field) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(placeholder).font(.system(size: 11)).foregroundStyle(Theme.muted)
            content()
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 15))
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.controlLine, lineWidth: 1))
        }
    }

    private enum ActionStyle { case primary, secondary }

    private func action(_ title: String, style: ActionStyle, disabled: Bool = false, _ run: @escaping () async throws -> Void) -> some View {
        Button {
            perform(run)
        } label: {
            HStack { Spacer(); if working { ProgressView().controlSize(.small) } else { Text(title) }; Spacer() }
        }
        .buttonStyle(ActionButtonStyle(primary: style == .primary))
        .disabled(working || disabled)
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
    }

    // MARK: 操作

    private struct SyncFormError: Error, CustomStringConvertible {
        let description: String
        init(_ text: String) { description = text }
    }

    /// 入力した接続先を保存する（空欄・変更なしなら、保存済みのものを使う）。
    private func saveConnection() async throws {
        guard !url.trimmingCharacters(in: .whitespaces).isEmpty else { throw SyncFormError("Project URLを入力してください。") }
        guard !key.trimmingCharacters(in: .whitespaces).isEmpty || status.configured else { throw SyncFormError("anon（publishable）キーを入力してください。") }
        if key.trimmingCharacters(in: .whitespaces).isEmpty {
            // キーは保存済み：URLが同じなら、そのまま使う。URLを変えるときは、キーも必要。
            guard url.trimmingCharacters(in: .whitespaces) == status.url else { throw SyncFormError("接続先を変えるときは、anon（publishable）キーも入力してください。") }
            report("接続先は保存済みです。")
            return
        }
        try await sync.configure(url: url, anonKey: key)
        report("接続先を保存しました。")
    }

    private func ensureConnection() async throws {
        if !status.configured || !key.isEmpty { try await saveConnection() }
    }

    private func report(_ text: String) { message = text; failed = false }

    private func perform(_ run: @escaping () async throws -> Void) {
        working = true
        message = nil
        Task {
            do { try await run() } catch { message = ErrorText.safe(error); failed = true }
            working = false
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
}

/// 同期の画面のボタン（全幅）。押せない状態は、薄く表示する。
private struct ActionButtonStyle: ButtonStyle {
    let primary: Bool
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(primary ? Theme.accentText : Theme.text)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 8).fill(primary ? Theme.accent : Theme.control).opacity(configuration.isPressed ? 0.75 : 1))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(primary ? Color.clear : Theme.controlLine, lineWidth: 1))
            .opacity(enabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}
