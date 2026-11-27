import SwiftUI
import UniformTypeIdentifiers

// ライブラリ画面の小さな部品。LibraryViews.swift から分けたもの（動作は同じ）。

/// 検索の入力欄（PC版の「全登録曲を検索」と同じ：曲名・リスト名・動画ID・URL）。
struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.faint)
            TextField("曲名・リスト名・動画ID・URLで検索", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Theme.text).submitLabel(.search)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faint).frame(width: 32, height: 32) }
                    .buttonStyle(.plain).accessibilityLabel("検索を消す")
            }
        }
        .font(.system(size: 14))
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.controlLine, lineWidth: 1))
    }
}

/// 編集の説明（「編集中です。…」）。
struct EditNotice: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "pencil.circle.fill").foregroundStyle(Theme.accent)
            Text(text).font(.system(size: 12)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.currentRow))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.controlLine, lineWidth: 1))
    }
}

/// 右上の編集ボタン（ペンのマーク。編集中はチェックのマークで、押すと終わる）。
struct EditToggle: View {
    @Binding var editing: Bool

    var body: some View {
        Button { withAnimation { editing.toggle() } } label: {
            Image(systemName: editing ? "checkmark.circle.fill" : "pencil").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44)
        }
        .accessibilityLabel(editing ? "編集を終わる" : "編集")
    }
}

/// プレイリストのカードを長押しでつかみ、別のカードの上で離すと、その位置へ移す（左右の矢印は使わない）。
/// つかんだカードが、離した先より前にあったなら、その後ろへ。後ろにあったなら、その前へ入れる。
struct PlaylistReorderDrop: DropDelegate {
    let target: String
    let siblings: [String]
    @Binding var dragging: String?
    let move: (_ id: String, _ target: String, _ after: Bool) -> Void

    func validateDrop(info: DropInfo) -> Bool { dragging != nil && info.hasItemsConforming(to: [.text]) }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func performDrop(info: DropInfo) -> Bool {
        defer { dragging = nil }
        guard let id = dragging, id != target, let from = siblings.firstIndex(of: id), let to = siblings.firstIndex(of: target) else { return false }
        move(id, target, from < to)
        return true
    }
}

/// カード以外の場所で離した（またはやめた）ときも、「つかんでいる」状態を戻す。
struct ClearDrag: DropDelegate {
    @Binding var dragging: String?
    func performDrop(info: DropInfo) -> Bool { dragging = nil; return false }
}

/// ナビゲーションバーを隠したページでも、画面の左端からのスワイプで前のページへ戻れるようにする。
struct SwipeBackEnabler: UIViewControllerRepresentable {
    /// 戻るスワイプを始めてよいのは、ページが2枚以上あるときだけ（ホームで始めると、画面が固まるため）。
    final class PopDelegate: NSObject, UIGestureRecognizerDelegate {
        weak var navigationController: UINavigationController?
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { (navigationController?.viewControllers.count ?? 0) > 1 }
    }

    final class Holder: UIViewController {
        let popDelegate = PopDelegate()
        private weak var originalDelegate: UIGestureRecognizerDelegate?
        private weak var popGesture: UIGestureRecognizer?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let gesture = navigationController?.interactivePopGestureRecognizer else { return }
            if gesture.delegate !== popDelegate {
                restorePopDelegate()
                originalDelegate = gesture.delegate
                popGesture = gesture
            }
            popDelegate.navigationController = navigationController
            gesture.delegate = popDelegate
            gesture.isEnabled = true
        }

        override func viewWillDisappear(_ animated: Bool) {
            restorePopDelegate()
            super.viewWillDisappear(animated)
        }

        private func restorePopDelegate() {
            if let popGesture, popGesture.delegate === popDelegate { popGesture.delegate = originalDelegate }
            popGesture = nil
            originalDelegate = nil
        }

        deinit {
            let gesture = popGesture, original = originalDelegate, own = popDelegate
            Task { @MainActor in
                if let gesture, gesture.delegate === own { gesture.delegate = original }
            }
        }
    }

    func makeUIViewController(context: Context) -> Holder { Holder() }
    func updateUIViewController(_ controller: Holder, context: Context) {}
}

/// 右下に浮かぶ「＋」（いま開いているプレイリストへ曲を追加）。再生バーが出ているときは、その上に置く。
struct AddSongButton: View {
    let player: PlaybackEngine?
    let action: () -> Void

    var body: some View {
        if let player { Floating(player: player, action: action) } else { button(lift: 0) }
    }

    private struct Floating: View {
        @ObservedObject var player: PlaybackEngine
        let action: () -> Void
        var body: some View { AddSongButton.circle(action: action, lift: player.current != nil ? 72 : 0) }
    }

    private func button(lift: CGFloat) -> some View { Self.circle(action: action, lift: lift) }

    fileprivate static func circle(action: @escaping () -> Void, lift: CGFloat) -> some View {
        Button(action: action) {
            Image(systemName: "plus").font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.accentText)
                .frame(width: 56, height: 56).background(Circle().fill(Theme.accent))
                .shadow(color: .black.opacity(0.45), radius: 8, y: 3)
        }
        .accessibilityLabel("このプレイリストへ曲を追加")
        .padding(.trailing, 18).padding(.bottom, 14 + lift)
    }
}

/// プレイリスト画面の先頭の画像の、画面上端からの位置（上のバーの濃さに使う）。
struct HeroTopKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
