'use strict';
// キーボードのメディアキー（再生/一時停止・次・前・停止）で、アプリを操作する（v0.7.4）。
// Chromium の標準のメディアキー処理は、再生しているページごとに動き、二重に反応するため切り、アプリで1回だけ受ける（main.cjs で、HardwareMediaKeyHandling を無効にする）。
// 電子の globalShortcut を使う。他のアプリが同じキーを使っていて登録できなかったキーは、飛ばす。
const KEYS = Object.freeze({ MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'previous', MediaStop: 'stop' });
const REPEAT_MS = 250; // 続けて届いた同じキーは、1回として扱う（キーの押しっぱなし・二重の通知）

// globalShortcut：electron の globalShortcut（または同じ形のもの）。run(command)：'toggle' / 'next' / 'previous' / 'stop'。
// 戻り値：{ registered: 登録できたキー名の配列, Dispose() }
function Register(globalShortcut, run, { now = Date.now } = {}) {
  const registered = [], last = new Map();
  if (!globalShortcut || typeof globalShortcut.register !== 'function') return { registered, Dispose() {} };
  for (const [key, command] of Object.entries(KEYS)) {
    try {
      const ok = globalShortcut.register(key, () => {
        const at = now();
        if (at - (last.get(key) ?? -Infinity) < REPEAT_MS) return;
        last.set(key, at);
        try { const result = run(command); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch { /* 操作の失敗は、再生を妨げない */ }
      });
      if (ok) registered.push(key);
    } catch { /* このキーは、使えない */ }
  }
  return { registered, Dispose() { for (const key of registered) { try { globalShortcut.unregister(key); } catch {} } registered.length = 0; } };
}

module.exports = { KEYS, Register, REPEAT_MS };
