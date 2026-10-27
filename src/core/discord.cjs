'use strict';

const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { ImageURL } = require('./thumbnail.cjs');
const { ParseBilibili } = require('./urls.cjs');

function EncodeFrame(opcode, data) {
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

class FrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); }
  Push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0), length = this.buffer.readUInt32LE(4);
      if (length > 1024 * 1024) throw new Error('Discordの応答が大きすぎます。');
      if (this.buffer.length < 8 + length) break;
      const body = this.buffer.subarray(8, 8 + length).toString('utf8');
      frames.push({ opcode, data: body ? JSON.parse(body) : null });
      this.buffer = this.buffer.subarray(8 + length);
    }
    return frames;
  }
}

function MediaTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minute = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const second = String(seconds % 60).padStart(2, '0');
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${minute}:${second}` : `${minute}:${second}`;
}

function BuildActivity(media, hidePaused, now = Date.now(), imageKey = 'favecus_player_music', thumbnailSize = 'small') {
  if (!media?.title || !['bilibili', 'local'].includes(media.source) || media.ended || (media.paused && hidePaused) || media.isAd) return null;
  const label = media.source === 'local' ? 'ローカルファイル' : 'Bilibili';
  const truncate = value => {
    let result = String(value || '');
    while (Buffer.byteLength(result, 'utf8') > 120) result = Array.from(result).slice(0, -1).join('');
    return result.length < 2 ? `${result} ` : result;
  };
  const activity = {
    type: 2,
    status_display_type: 2,
    details: truncate(media.title),
    state: truncate(media.paused ? `一時停止 · ${MediaTime(Math.min(media.position || 0, media.duration || Infinity))} / ${media.duration > 0 ? MediaTime(media.duration) : '--:--'} · ${label}` : media.artist || label),
    assets: { large_image: imageKey, large_text: 'Favecus Player · Music' },
    instance: false
  };
  let thumbnail;
  if (media.thumbnailURL) { try { thumbnail = ImageURL(media.thumbnailURL); } catch {} }
  if (thumbnail) {
    if (thumbnailSize === 'large') Object.assign(activity.assets, { large_image: thumbnail, large_text: truncate(media.title), small_image: imageKey, small_text: 'Favecus Player' });
    else Object.assign(activity.assets, { small_image: thumbnail, small_text: truncate(media.title) });
    if (media.source === 'bilibili' && media.videoURL) { try { activity.assets[thumbnailSize === 'large' ? 'large_url' : 'small_url'] = ParseBilibili(media.videoURL).url; } catch {} }
  }
  if (!media.paused && media.duration > 0 && media.position >= 0 && Math.abs((media.playbackRate || 1) - 1) < 0.01) {
    const start = Math.floor(now / 1000 - media.position);
    activity.timestamps = { start, end: start + Math.ceil(media.duration) };
  }
  return activity;
}

class DiscordPresence {
  constructor(onStatus, options = {}) {
    this.onStatus = onStatus; this.options = options;
    this.enabled = false; this.clientId = ''; this.socket = null; this.ready = false;
    this.timer = null; this.flushTimer = null; this.lastSent = 0; this.lastKey = undefined;
    this.activity = null; this.epoch = 0;
  }
  Configure(enabled, clientId) {
    if (this.enabled === enabled && this.clientId === clientId) return;
    this.Disconnect(); this.enabled = enabled; this.clientId = clientId;
    if (!enabled) { this.onStatus('off', 'Discord連携はオフです'); return; }
    this.Connect();
  }
  Candidates() {
    if (this.options.paths) return this.options.paths;
    if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
    const roots = [...new Set([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir(), '/tmp'].filter(Boolean))];
    return roots.flatMap(root => Array.from({ length: 10 }, (_, i) => path.join(root, `discord-ipc-${i}`)));
  }
  Connect() {
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    const candidates = this.Candidates(); let index = 0;
    this.onStatus('connecting', 'Discordデスクトップ版を探しています');
    const attempt = () => {
      if (epoch !== this.epoch || !this.enabled) return;
      if (index >= candidates.length) {
        this.onStatus('waiting', 'Discordデスクトップ版の起動を待っています');
        this.timer = setTimeout(() => this.Connect(), 10000); this.timer.unref?.(); return;
      }
      const socket = net.createConnection(candidates[index++]); this.socket = socket;
      const decoder = new FrameDecoder(); let connected = false;
      const timeout = setTimeout(() => socket.destroy(), 2500); timeout.unref?.();
      socket.on('connect', () => socket.write(EncodeFrame(0, { v: 1, client_id: this.clientId })));
      socket.on('data', chunk => {
        if (epoch !== this.epoch) return;
        try {
          for (const frame of decoder.Push(chunk)) {
            if (frame.opcode === 3) socket.write(EncodeFrame(4, frame.data));
            else if (frame.opcode === 2) { this.onStatus('error', 'Discordが接続を閉じました。Application IDを確認してください'); socket.destroy(); }
            else if (frame.data?.evt === 'READY') {
              clearTimeout(timeout); connected = true; this.ready = true; this.lastKey = undefined; this.lastSent = 0;
              this.onStatus('connected', 'Discordに接続しました'); this.Flush();
            } else if (frame.data?.evt === 'ERROR') {
              this.onStatus('error', `Discord: ${String(frame.data.data?.message || '設定を確認してください').slice(0, 140)}`);
              this.lastKey = undefined;
            }
          }
        } catch { socket.destroy(); }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timeout);
        if (epoch !== this.epoch) return;
        this.ready = false; this.socket = null;
        if (connected) {
          this.onStatus('waiting', 'Discordとの再接続を待っています');
          this.timer = setTimeout(() => this.Connect(), 10000); this.timer.unref?.();
        } else attempt();
      });
    };
    attempt();
  }
  SetActivity(activity) { this.activity = activity; this.Flush(); }
  Flush() {
    if (!this.ready || !this.socket || this.socket.destroyed) return;
    const key = JSON.stringify(this.activity);
    if (key === this.lastKey) return;
    clearTimeout(this.flushTimer);
    // 時間表示はDiscord側に進めさせ、連続した操作による更新をまとめる。
    const wait = this.activity === null ? 0 : Math.max(0, 15000 - (Date.now() - this.lastSent));
    if (wait > 0) { this.flushTimer = setTimeout(() => this.Flush(), wait); this.flushTimer.unref?.(); return; }
    this.socket.write(EncodeFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity }, nonce: randomUUID() }));
    this.lastKey = key; this.lastSent = Date.now();
  }
  Disconnect() {
    ++this.epoch; clearTimeout(this.timer); clearTimeout(this.flushTimer);
    if (this.socket && !this.socket.destroyed) {
      if (this.ready) this.socket.end(EncodeFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: randomUUID() }));
      else this.socket.destroy();
    }
    this.socket = null; this.ready = false; this.lastKey = undefined;
  }
  Stop() { this.enabled = false; this.Disconnect(); }
}

module.exports = { DiscordPresence, FrameDecoder, EncodeFrame, BuildActivity };
