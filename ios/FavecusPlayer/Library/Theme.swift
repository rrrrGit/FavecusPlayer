import SwiftUI

/// PC版（src/ui/style.css）と同じ配色。画面の色はここだけで決める。
enum Theme {
    static let background = Color(hex: 0x11131B)
    static let panel = Color(hex: 0x171923)
    static let transport = Color(hex: 0x191C27)
    static let line = Color(hex: 0x2B2D3C)
    static let rowLine = Color(hex: 0x242837)
    static let currentRow = Color(hex: 0x242139)
    static let control = Color(hex: 0x232633)      // 副ボタン・チップの背景
    static let controlLine = Color(hex: 0x36394B)
    static let coverLine = Color(hex: 0x34394B)
    static let text = Color(hex: 0xEDF0F8)
    static let muted = Color(hex: 0x9297AD)
    static let faint = Color(hex: 0x77819C)
    static let accent = Color(hex: 0xB1A2FF)
    static let accentText = Color(hex: 0x211B36)   // 主ボタン（アクセント色の上）の文字
    static let mint = Color(hex: 0x85D9C2)
    static let mainControl = Color(hex: 0xD7CEF9)  // ミニプレイヤーの再生ボタン
    static let warning = Color(hex: 0xE5B097)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// 小見出し：通常の表記・字間なし・落ち着いた灰色（大文字・広い字間・色の点は使わない）。
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
    }
}

/// PC版の主ボタン（アクセント色）と副ボタン。
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.accentText)
            .padding(.horizontal, 18).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1)))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.control.opacity(configuration.isPressed ? 0.7 : 1)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.controlLine, lineWidth: 1))
    }
}

/// PC版の色つきの小さなボタン（「シャッフル再生」「再生」）。
struct TintedButtonStyle: ButtonStyle {
    let color: Color
    let fill: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.45), lineWidth: 1))
    }
}
