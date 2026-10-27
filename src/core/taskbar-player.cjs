'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const COMMANDS = new Set(['previous', 'toggle', 'next', 'stop', 'restore', 'floating']);
const ERRORS = {
  'notify-not-found': 'タスクバーの通知領域を見つけられませんでした。',
  'no-space': 'このタスクバーの向き・幅では配置できません。幅と左への移動量を小さくしてください。',
  'dpi-error': 'タスクバーの表示倍率に合わせられませんでした。',
  'parent-error': 'Windowsがタスクバーへの接続を受け付けませんでした。',
  'create-error': '埋め込み用ウィンドウを作成できませんでした。',
  'position-error': '埋め込み用ウィンドウを配置できませんでした。',
  'geometry-error': 'タスクバーの位置・大きさを取得できませんでした。',
  'render-error': '埋め込み用プレイヤーの描画に失敗しました。',
  occluded: '埋め込み用プレイヤーがタスクバーの別の表示に隠れています。',
  timeout: 'タスクバーへの接続が時間内に完了しませんでした。',
  'protocol-error': '小型プレイヤーとの通信形式が一致しません。',
  'parent-process-error': '起動元のアプリを確認できませんでした。'
};
const Clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
function Packet(state, settings = {}, close = false) {
  const packet = Buffer.alloc(1024);
  packet.write('FPB1', 0, 'ascii'); packet.writeUInt32LE(1024, 4); packet.writeUInt32LE(close ? 2 : 1, 8);
  packet.writeUInt32LE((state.paused ? 1 : 0) | (state.canToggle ? 2 : 0) | (state.canStop ? 4 : 0) | (state.canStep ? 8 : 0), 12);
  packet.writeUInt32LE(Clamp(state.volume * 100, 0, 100, 100), 16);
  packet.writeUInt32LE(Clamp(settings.taskbarWidth, 260, 520, 500), 20);
  packet.writeUInt32LE(Clamp(settings.taskbarOffset, 0, 1200, 0), 24);
  const text = (value, offset, count) => {
    let s = String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, count - 1);
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    packet.write(s, offset, (count - 1) * 2, 'utf16le');
  };
  text(state.title, 32, 180); text(`${state.artist || ''}${state.paused && state.canStop ? ' · 一時停止' : ''}`, 392, 100);
  return packet;
}
class TaskbarPlayer {
  constructor(executable, state, settings, action, status, failure, options = {}) {
    this.executable = executable; this.state = state; this.settings = settings; this.action = action; this.status = status; this.failure = failure;
    this.options = options; this.connection = null; this.log = options.log;
  }
  Log(record) {
    if (!this.log) return;
    try {
      fs.mkdirSync(path.dirname(this.log), { recursive: true });
      if (fs.existsSync(this.log) && fs.statSync(this.log).size > 256 * 1024) fs.renameSync(this.log, `${this.log}.old`);
      fs.appendFileSync(this.log, `${new Date().toISOString()} ${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {}
  }
  async Show() {
    if (this.connection) { this.Update(); return this.connection.started; }
    let child;
    try {
      if (!(this.options.exists || fs.existsSync)(this.executable)) throw new Error('埋め込み用ファイルがありません。0.4.3以降のPatchを適用してください。');
      // GUI専用EXEなのでコンソールは作られない。表示を隠す起動指定は渡さない。
      child = (this.options.spawn || spawn)(this.executable, ['--parent-pid', String(process.pid)], { windowsHide: false, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { this.Log({ error: error.message }); this.status('error', error.message); throw error; }
    const c = { child, ready: false, intentional: false, buffer: '', decoder: new StringDecoder('utf8'), sent: null, blocked: false };
    this.connection = c;
    c.started = new Promise((resolve, reject) => { c.resolve = resolve; c.reject = reject; });
    const failed = error => {
      if (this.connection !== c || c.intentional) return;
      this.Log({ error: error.message });
      const wasReady = c.ready; this.Stop(error);
      this.status('error', error.message);
      if (wasReady) this.failure(error);
    };
    c.timer = setTimeout(() => failed(new Error(ERRORS.timeout)), this.options.timeout ?? 8000); c.timer.unref?.();
    child.once('error', failed);
    child.once('exit', (code, signal) => {
      clearTimeout(c.killTimer);
      if (!c.intentional) failed(new Error(`埋め込み用プレイヤーが終了しました（${code ?? signal}）。`));
    });
    child.stdin.on('error', failed);
    child.stdin.on('drain', () => { c.blocked = false; this.Update(); });
    child.stdout.on('data', chunk => {
      if (this.connection !== c) return;
      c.buffer += c.decoder.write(chunk);
      if (c.buffer.length > 8192) { failed(new Error('埋め込み用プレイヤーの応答が大きすぎます。')); return; }
      let at;
      while ((at = c.buffer.indexOf('\n')) >= 0) {
        const line = c.buffer.slice(0, at); c.buffer = c.buffer.slice(at + 1); if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { failed(new Error('埋め込み用プレイヤーの応答を読み取れません。')); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { failed(new Error(ERRORS['protocol-error'])); return; }
        if (message.event === 'status') {
          this.Log(message);
          if (message.code === 'attached' && Number.isSafeInteger(message.parent) && message.parent > 0 && message.width > 0 && message.height > 0 && message.rendered === true && message.visible === true && message.hitCount === 3) {
            c.ready = true; clearTimeout(c.timer); this.status('embedded', 'タスクバーの内部へ接続しました'); c.resolve(true);
          } else if (message.code === 'waiting-taskbar') this.status('connecting', 'タスクバーの再表示を待っています');
          else if (message.code === 'waiting-visible') this.status('connecting', 'プレイヤーの表示を確認しています。自動非表示の場合はタスクバーへマウスを移動してください');
          else { failed(new Error(`${ERRORS[message.code] || '埋め込みに失敗しました。'}${message.win32 ? `（Windows ${message.win32}）` : ''}`)); return; }
        } else if (c.ready && message.event === 'command' && COMMANDS.has(message.command)) {
          Promise.resolve().then(() => this.connection === c && this.action(message.command)).catch(error => this.failure(error));
        } else if (c.ready && message.event === 'volume' && Number.isInteger(message.value) && message.value >= 0 && message.value <= 100) {
          Promise.resolve().then(() => this.connection === c && this.action('volume', message.value / 100)).catch(error => this.failure(error));
        }
      }
    });
    child.stderr.on('data', chunk => this.Log({ nativeError: String(chunk).slice(0, 500) }));
    this.status('connecting', 'タスクバーへ接続しています'); this.Update();
    return c.started;
  }
  Update() {
    const c = this.connection;
    if (!c || c.intentional || c.blocked || c.child.stdin.destroyed) return;
    const packet = Packet(this.state(), this.settings());
    if (c.sent?.equals(packet)) return;
    c.sent = packet; c.blocked = !c.child.stdin.write(packet);
  }
  Stop(error = new Error('埋め込み表示を閉じました。')) {
    const c = this.connection; if (!c) return;
    this.connection = null; c.intentional = true; clearTimeout(c.timer); if (!c.ready) c.reject(error);
    if (!c.child.stdin.destroyed) c.child.stdin.end(Packet(this.state(), this.settings(), true));
    c.killTimer = setTimeout(() => { if (c.child.exitCode === null && !c.child.killed) c.child.kill(); }, 2000); c.killTimer.unref?.();
  }
}
module.exports = { TaskbarPlayer, Packet };
