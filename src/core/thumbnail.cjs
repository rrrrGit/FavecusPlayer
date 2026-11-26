'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const LIMIT = 3 * 1024 * 1024;

const { ImageURL } = require('./bilibili-resolve.cjs'); // サムネイルの配信先の検査は共通
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
function LocalImage(executable, file, seconds = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-v', 'error', ...(seconds > 0 ? ['-ss', String(Math.floor(seconds))] : []), '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file), '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=720:720:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
// ホームのカード用。中央を正方形に切り出して最大300pxのJPEGにする（カードは正方形で、128x72では拡大でぼやけるため）。
function CoverImage(data, nativeImage) {
  const image = nativeImage.createFromDataURL(data);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize(), side = Math.min(width, height);
  if (!Number.isFinite(side) || side <= 0) return null;
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }), out = Math.min(300, side);
  return ImageData(square.resize({ width: out, height: out, quality: 'good' }).toJPEG(82));
}
// 一色に近い画像（真っ白・真っ黒・単色の背景など）の判定。何の動画か分からないサムネイルを、動画の別の場面へ置き換えるために使う。
// bitmap：小さく縮めた画像のBGRA（nativeImage.toBitmap）。輝度の標準偏差と最大・最小の差で判定する。
function FlatScore(bitmap) {
  let sum = 0, sum2 = 0, count = 0, min = 255, max = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const luma = .114 * bitmap[i] + .587 * bitmap[i + 1] + .299 * bitmap[i + 2];
    sum += luma; sum2 += luma * luma; count++; if (luma < min) min = luma; if (luma > max) max = luma;
  }
  if (!count) return { std: 255, range: 255 };
  const mean = sum / count;
  return { std: Math.sqrt(Math.max(0, sum2 / count - mean * mean)), range: max - min };
}
const IsFlatScore = ({ std, range }) => std < 6 && range < 48;
function FlatImage(data, nativeImage) {
  const image = nativeImage.createFromDataURL(data);
  if (image.isEmpty()) return false;
  return IsFlatScore(FlatScore(image.resize({ width: 32, height: 18, quality: 'good' }).toBitmap()));
}
const ImageKey = entry => entry.type === 'local' ? `file:${entry.fileName}` : `bili:${entry.videoId}`;
class Thumbnails {
  constructor(account, fetch, executable, media, options = {}) {
    this.account = account; this.fetch = fetch; this.executable = executable; this.media = media;
    this.cache = new Map(); this.pending = new Map(); this.previews = new Map(); this.resize = options.resize; this.resizeCover = options.resizeCover; this.flat = options.flat; this.crop = options.crop; this.improved = new Map(); this.now = options.now || Date.now;
  }
  async GetPreview(entry, isActive = () => true, variant = 'small') {
    const resize = variant === 'cover' ? this.resizeCover : this.resize;
    if (!isActive() || !resize) return null;
    const key = variant === 'cover' ? `${ImageKey(entry)}|cover` : ImageKey(entry), cached = this.previews.get(key);
    if (cached && cached.expires > this.now()) {
      this.previews.delete(key); this.previews.set(key, cached); return cached.image;
    }
    let image = null;
    try { const original = await this.Get(entry, isActive); if (original) image = resize(original); } catch {}
    if (!isActive()) return null;
    this.previews.delete(key); this.previews.set(key, { image, expires: image ? Infinity : this.now() + 60000 });
    while (this.previews.size > 96) this.previews.delete(this.previews.keys().next().value);
    return image;
  }
  // 動画の特定の場面（60秒付近）の画像。保存済みのファイル・ローカルファイルはffmpegで、オンラインのBilibiliは公式のプレビュー画像（videoshot）から切り出す。
  async Frame(entry, file = '') {
    const target = Number(entry.duration) > 0 ? Math.min(60, Math.max(1, Number(entry.duration) * .3)) : 60;
    if (file || entry.type === 'local') {
      for (const seconds of [target, Math.min(target, 10), 2]) {
        let image = null; try { image = await LocalImage(this.executable, file || path.join(this.media, entry.fileName), seconds); } catch { continue; }
        if (image && !this.flat?.(image)) return image;
      }
      return null;
    }
    if (entry.type !== 'bilibili' || !this.account?.Details || !this.account?.Request || !this.crop) return null;
    const details = await this.account.Details(entry.videoId), part = Number(entry.part) || 1, page = details.pages?.find(p => Number(p.page) === part) || details.pages?.[Math.max(0, part - 1)];
    if (!page?.cid || !details.bvid) return null;
    const shot = await this.account.Request('/x/player/videoshot', { bvid: details.bvid, cid: page.cid, index: 1 });
    const times = Array.isArray(shot?.index) ? shot.index : [], images = Array.isArray(shot?.image) ? shot.image : [];
    const columns = Number(shot?.img_x_len), rows = Number(shot?.img_y_len), width = Number(shot?.img_x_size), height = Number(shot?.img_y_size);
    if (![columns, rows, width, height].every(n => Number.isInteger(n) && n > 0 && n < 4000) || !times.length || !images.length) return null;
    const wanted = Math.min(target, Number(page.duration) > 0 ? Number(page.duration) * .5 : target);
    let best = 0; for (let i = 0; i < times.length; i++) if (Math.abs(times[i] - wanted) < Math.abs(times[best] - wanted)) best = i;
    const perSheet = columns * rows, sheet = images[Math.floor(best / perSheet)]; if (!sheet) return null;
    const position = best % perSheet, sheetData = await RemoteImage(this.fetch, ImageURL(sheet));
    return this.crop(sheetData, { x: (position % columns) * width, y: Math.floor(position / columns) * height, width, height });
  }
  // 一色に近いサムネイルを、動画の別の場面へ置き換える。置き換えられない・失敗したときは元の画像をそのまま返す。
  // 結果は動画ごとに覚える（保存済みの一色のカバーで、表示のたびにffmpegや通信が走らないようにする）。置き換えられなかった場合も覚え、失敗は60秒後に再試行する。
  async Improve(entry, image, file = '') {
    if (!image || !this.flat) return image;
    const key = `${ImageKey(entry)}|${file ? 'file' : 'online'}`, known = this.improved.get(key);
    if (known && known.until > this.now() && known.source === image) return known.value;
    let value = image, keep = Infinity;
    try {
      if (this.flat(image)) {
        const alternative = await this.Frame(entry, file);
        if (alternative && !this.flat(alternative)) value = alternative; else keep = this.now() + 60000;
      }
    } catch { keep = this.now() + 60000; }
    this.improved.delete(key); this.improved.set(key, { value, source: image, until: keep });
    while (this.improved.size > 48) this.improved.delete(this.improved.keys().next().value);
    return value;
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
        const improved = isActive() ? await this.Improve(entry, image) : image;
        this.cache.set(key, improved);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        return improved;
      } catch { return null; }
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task); return task;
  }
}
module.exports = { Thumbnails, ImageURL, ImageData, RemoteImage, LocalImage, SmallImage, CoverImage, FlatScore, IsFlatScore, FlatImage };
