import Foundation
import SwiftUI
import WebKit

/// Bilibiliのログイン状態。ログインは、公式のログインページ（WKWebView）で利用者が行う。パスワードは扱わない（このアプリは入力を見ない）。
/// ログイン後に得たCookieのうち、APIの利用に必要なものだけをKeychainへ保存する。
@MainActor
final class BilibiliAccount: ObservableObject {
    struct Profile: Equatable {
        var loggedIn = false
        var name = ""
    }

    @Published private(set) var profile = Profile()
    @Published private(set) var message = ""
    @Published private(set) var checking = false

    let cookies: BilibiliCookieVault
    private let core: BiliCore
    private var authGeneration = 0

    init(cookies: BilibiliCookieVault, core: BiliCore) {
        self.cookies = cookies
        self.core = core
        profile.loggedIn = cookies.isLoggedIn
    }

    /// ログイン状態をBilibiliに確認する（Cookieが期限切れなら、ログアウト扱いにして知らせる）。
    func refresh() async {
        guard cookies.isLoggedIn else { profile = Profile(); return }
        let gen = authGeneration
        checking = true
        defer { checking = false }
        do {
            let text = try await core.call("BiliProfile")
            guard gen == authGeneration else { return }
            let object = (try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
            if let error = object["error"] as? String { message = error; return }
            if object["loggedIn"] as? Bool == true {
                profile = Profile(loggedIn: true, name: (object["name"] as? String) ?? "")
                message = ""
            } else {
                cookies.clear()
                profile = Profile()
                message = "ログインの有効期限が切れました。もう一度ログインしてください。"
            }
        } catch {
            guard gen == authGeneration else { return }
            message = "ログイン状態を確認できません：\(ErrorText.safe(error))"
        }
    }

    /// WKWebViewのCookieから、必要なものを保存する（ログインページの操作が終わったときに呼ぶ）。
    func capture(from store: WKHTTPCookieStore) async -> Bool {
        let all = await store.allCookies()
        var picked: [String: String] = [:]
        for cookie in all where (cookie.domain == "bilibili.com" || cookie.domain.hasSuffix(".bilibili.com")) && BilibiliCookieVault.allowed.contains(cookie.name) { picked[cookie.name] = cookie.value }
        guard picked["SESSDATA"] != nil else { return false }
        do {
            try cookies.store(picked)
            authGeneration += 1
            profile.loggedIn = true
            message = ""
            return true
        } catch {
            message = ErrorText.safe(error)
            return false
        }
    }

    /// ログアウト：Keychainのログイン情報と、WKWebViewに残ったBilibiliのサイトデータの両方を消す。
    func signOut() async {
        authGeneration += 1
        cookies.clear()
        profile = Profile()
        let store = WKWebsiteDataStore.default()
        let records = await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: records.filter { $0.displayName.contains("bilibili") || $0.displayName.contains("hdslb") })
    }
}

extension WKHTTPCookieStore {
    func allCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in getAllCookies { continuation.resume(returning: $0) } }
    }
}

/// 公式のログインページ。WebViewの設定は既定のまま（User-Agentなどを偽装しない）。
struct BilibiliLoginView: UIViewRepresentable {
    let account: BilibiliAccount
    let onFinished: () -> Void

    /// ログインのCookieは、WebKitの保存領域に残さない（取り出してKeychainへ移した後は、この画面と一緒に捨てる）。
    private static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        return configuration
    }

    func makeCoordinator() -> Coordinator { Coordinator(account: account, onFinished: onFinished) }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: Self.configuration())
        view.navigationDelegate = context.coordinator
        if let url = URL(string: "https://passport.bilibili.com/login") { view.load(URLRequest(url: url)) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let account: BilibiliAccount
        let onFinished: () -> Void
        private var done = false

        init(account: BilibiliAccount, onFinished: @escaping () -> Void) {
            self.account = account
            self.onFinished = onFinished
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !done else { return }
            let store = webView.configuration.websiteDataStore.httpCookieStore
            Task { @MainActor in
                if await account.capture(from: store) {
                    guard !done else { return }
                    done = true
                    await account.refresh()
                    onFinished()
                }
            }
        }
    }
}

struct BilibiliSheet: View {
    @ObservedObject var account: BilibiliAccount
    @Binding var isPresented: Bool
    @State private var showLogin = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if account.profile.loggedIn {
                        Text("ログイン中\(account.profile.name.isEmpty ? "" : "：\(account.profile.name)")")
                        Button("ログアウト", role: .destructive) { Task { await account.signOut() } }
                    } else {
                        Text("ログインしていません。公開されている動画は、ログインなしでも再生・保存できる場合があります。")
                            .font(.footnote)
                        Button("Bilibiliにログイン") { showLogin = true }
                    }
                    if !account.message.isEmpty { Text(account.message).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Text("ログイン画面で貼り付け（パスワードなど）ができないときは、iPhoneの「設定」→「FavecusPlayer」→「他のAppからペースト」を「許可」にします（最初の確認で「許可しない」を選んだ場合）。")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("iPhoneの設定を開く") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                }
                Section {
                    Text("ログインは公式のページで行い、このアプリはパスワードを見ません。保存するのは、Bilibiliの利用に必要なログイン情報だけで、端末のKeychainに入ります（同期・ZIP・ログには含めません）。通常のWebで見られる動画だけを扱い、保護された動画・制限された配信は取得しません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Bilibili")
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { isPresented = false } } }
            .task { await account.refresh() }
            .sheet(isPresented: $showLogin) {
                NavigationStack {
                    BilibiliLoginView(account: account) { showLogin = false }
                        .navigationTitle("ログイン")
                        .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("閉じる") { showLogin = false } } }
                }
            }
        }
    }
}
