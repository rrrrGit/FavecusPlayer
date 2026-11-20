import SwiftUI

// 再生画面のメニュー（再生速度・おやすみタイマー）。MiniPlayerView.swift から分けたもの（動作は同じ）。

/// 再生速度の選択（0.5〜2.0倍）。
struct SpeedMenu: View {
    @ObservedObject var player: PlaybackEngine

    var body: some View {
        Menu {
            ForEach(PlaybackSpeed.options, id: \.self) { value in
                Button { player.setSpeed(value) } label: {
                    if abs(player.speed - value) < 0.001 { Label(PlaybackSpeed.text(value), systemImage: "checkmark") } else { Text(PlaybackSpeed.text(value)) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "speedometer")
                Text(PlaybackSpeed.text(player.speed))
            }
            .font(.system(size: 13))
            .foregroundStyle(abs(player.speed - 1) < 0.001 ? Theme.muted : Theme.accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("再生速度")
        .accessibilityValue(PlaybackSpeed.text(player.speed))
    }
}

/// おやすみタイマーの入口（再生画面の操作の下）。時間か「この曲の終わりまで」を選ぶ。設定中は、残り時間を表示する。
struct SleepTimerMenu: View {
    @ObservedObject var timer: SleepTimer

    var body: some View {
        Menu {
            ForEach(SleepTimerRules.minutes, id: \.self) { minutes in
                Button("\(minutes)分") { timer.start(minutes: minutes) }
            }
            Button("この曲の終わりまで") { timer.startEndOfSong() }
            if timer.isOn {
                Divider()
                Button("解除", role: .destructive) { timer.cancel() }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: timer.isOn ? "moon.zzz.fill" : "moon.zzz")
                Text(label)
            }
            .font(.system(size: 13))
            .foregroundStyle(timer.isOn ? Theme.accent : Theme.muted)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("おやすみタイマー")
        .accessibilityValue(label)
    }

    private var label: String {
        switch timer.mode {
        case .off: return "おやすみタイマー"
        case .endOfSong: return "この曲の終わりまで"
        case .minutes:
            let total = Int(timer.remaining.rounded(.up))
            return String(format: "残り %d:%02d", total / 60, total % 60)
        }
    }
}
