'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const LIMIT = 3 * 1024 * 1024;

function ImageURL(raw) {
  const url = new URL(String(raw).replace(/^http:/, 'https:').replace(/^\/\//, 'https://'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['hdslb.com', 'bilibili.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('サムネイルのURLを確認できません。');
  return url.href;
}
function ImageData(bytes) {
  if (!bytes.length || bytes.length > LIMIT) throw new Error('サムネイルのサイズが正しくありません。');
  let type;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = 'jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'webp';
  else throw new Error('サムネイルの画像形式を確認できません。');
  return `data:image/${type};base64,${bytes.toString('base64')}`;
}
async function RemoteImage(fetch, url, signal) {
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(ImageURL(url), { credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIMIT) { await response.body?.cancel(); throw new Error('サムネイルを取得できません。'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if ((size += value.length) > LIMIT) throw new Error('サムネイルが大きすぎます。');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return ImageData(Buffer.concat(chunks));
}
function LocalImage(executable, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file), '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=720:720:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let size = 0; const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('サムネイルの作成が時間内に終わりませんでした。')); }, 12000);
    child.stdout.on('data', chunk => {
      if ((size += chunk.length) > LIMIT) { child.kill(); reject(new Error('サムネイルが大きすぎます。')); }
      else chunks.push(chunk);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw new Error('このファイルには取得できるサムネイルがありません。'); resolve(ImageData(Buffer.concat(chunks))); }
      catch (error) { reject(error); }
    });
  });
}
function SmallImage(data, nativeImage) {
  const image = nativeImage.createFromDataURL(data);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize(), scale = Math.min(128 / width, 72 / height, 1);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return ImageData(image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }).toPNG());
}
const ImageKey = entry => entry.type === 'local' ? `file:${entry.fileName}` : `bili:${entry.videoId}`;
class Thumbnails {
  constructor(account, fetch, executable, media, options = {}) {
    this.account = account; this.fetch = fetch; this.executable = executable; this.media = media;
    this.cache = new Map(); this.pending = new Map(); this.previews = new Map(); this.resize = options.resize; this.now = options.now || Date.now;
  }
  async GetPreview(entry, isActive = () => true) {
    if (!isActive() || !this.resize) return null;
    const key = ImageKey(entry), cached = this.previews.get(key);
    if (cached && cached.expires > this.now()) {
      this.previews.delete(key); this.previews.set(key, cached); return cached.image;
    }
    let image = null;
    try { const original = await this.Get(entry, isActive); if (original) image = this.resize(original); } catch {}
    if (!isActive()) return null;
    this.previews.delete(key); this.previews.set(key, { image, expires: image ? Infinity : this.now() + 60000 });
    while (this.previews.size > 96) this.previews.delete(this.previews.keys().next().value);
    return image;
  }
  async Get(entry, isActive = () => true) {
    const key = ImageKey(entry);
    for (;;) {
      if (!isActive()) return null;
      if (this.cache.has(key)) return this.cache.get(key);
      if (this.pending.has(key)) return this.pending.get(key);
      if (this.pending.size < 2) break;
      await Promise.race(this.pending.values());
    }
    const task = Promise.resolve().then(async () => {
      try {
        const image = entry.type === 'local' ? await LocalImage(this.executable, path.join(this.media, entry.fileName)) : await RemoteImage(this.fetch, (await this.account.Details(entry.videoId)).pic);
        this.cache.set(key, image);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        return image;
      } catch { return null; }
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task); return task;
  }
}
module.exports = { Thumbnails, ImageURL, ImageData, RemoteImage, LocalImage, SmallImage };
