'use strict';
// Bilibiliの動画情報から、保存・再生に使う配信先（ストリーム）を決める規則（端末APIなし。Windows版・iPhone版で共通）。
// 通信は注入された request(endpoint, query) → JSON（api.bilibili.com 宛て。Cookieの扱いは端末側）で行う。
// 方針：試聴用・保護（DRM）された動画は扱わない。認証・レート制限・リスク制御の応答では、方法を変えて再試行しない（停止して知らせる）。
const { ParseBilibili } = require('./urls.cjs');
const { VideoIdentity } = require('./media-identity.cjs');

// ---- MD5（WBI署名用。端末の暗号APIに依存しないよう自前。UTF-8の文字列を扱う）
function Md5(text) {
  const bytes = [];
  for (const ch of String(text)) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  const length = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bits = length * 8;
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? (bits >>> (8 * i)) & 255 : Math.floor(length / 536870912) >>> (8 * (i - 4)) & 255);
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const M = Array.from({ length: 16 }, (_, i) => bytes[offset + i * 4] | (bytes[offset + i * 4 + 1] << 8) | (bytes[offset + i * 4 + 2] << 16) | (bytes[offset + i * 4 + 3] << 24));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map(word => { let out = ''; for (let i = 0; i < 4; i++) out += ((word >>> (8 * i)) & 255).toString(16).padStart(2, '0'); return out; }).join('');
}

function ImageURL(raw) {
  const url = new URL(String(raw).replace(/^http:/, 'https:').replace(/^\/\//, 'https://'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['hdslb.com', 'bilibili.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('未対応のサムネイル配信先です。');
  return url.href;
}
const MIXIN_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
function SignQuery(query, images, now = Date.now()) {
  const key = ['img_url', 'sub_url'].map(k => new URL(images[k]).pathname.split('/').at(-1).split('.')[0]).join('');
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Bilibiliの署名情報を取得できません。');
  const salt = MIXIN_ORDER.map(i => key[i]).join('').slice(0, 32), params = { ...query, wts: Math.floor(now / 1000) };
  const encoded = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${encoded}&w_rid=${Md5(encoded + salt)}`;
}
function MediaURL(raw) {
  const text = String(raw), u = new URL(/^http:/i.test(text) ? 'https:' + text.slice(5) : text); // httpはhttpsへ（URLのprotocolは、iOSの実行環境では書き換えられないため、文字列で）
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'akamaized.net'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw new Error('未対応の動画配信先です。');
  return u.href;
}
function Stream(item) {
  const urls = [];
  for (const raw of [item.baseUrl || item.base_url || item.url, ...(item.backupUrl || item.backup_url || [])]) { try { urls.push(MediaURL(raw)); } catch { /* 許可外の配信先は使わない */ } }
  if (!urls.length) throw new Error('保存可能な動画配信先が見つかりません。');
  return { urls: [...new Set(urls)], bandwidth: Number.isSafeInteger(item.bandwidth) && item.bandwidth > 0 ? item.bandwidth : 0, size: Number.isSafeInteger(item.size) && item.size > 0 ? item.size : 0 };
}
function SelectStreams(info, kind, height = 720) {
  if (!['video', 'audio'].includes(kind)) throw new Error('保存形式が正しくありません。');
  if (!info || Number(info.is_preview) > 0 || Number(info.is_drm) > 0 || Number(info.drm_tech_type) > 0) throw new Error('試聴用・保護された動画は保存できません。');
  const audios = (info.dash?.audio || []).filter(a => /^mp4a/i.test(a.codecs || '') && !a.drm).sort((a, b) => (a.bandwidth > 192000) - (b.bandwidth > 192000) || (a.bandwidth > 192000 ? a.bandwidth - b.bandwidth : b.bandwidth - a.bandwidth));
  const size = v => Number(v.height) || ({ 16: 360, 32: 480, 64: 720, 80: 1080 }[v.id]) || 9999;
  const videos = (info.dash?.video || []).filter(v => /^avc1/i.test(v.codecs || '') && !v.drm).sort((a, b) => (size(a) > height) - (size(b) > height) || (size(a) > height ? size(a) - size(b) : size(b) - size(a)) || (a.bandwidth || 0) - (b.bandwidth || 0));
  if (audios.length && (kind === 'audio' || videos.length)) return { layout: 'dash', streams: (kind === 'audio' ? [audios[0]] : [videos[0], audios[0]]).map(Stream), height: kind === 'video' ? size(videos[0]) : null };
  if (Array.isArray(info.durl) && info.durl.length && info.durl.length <= 100) return { layout: info.durl.length === 1 ? 'muxed' : 'segments', streams: info.durl.map(Stream), height: Number(info.quality) === 16 ? 360 : null };
  throw new Error('対応するH.264動画・AAC音声を取得できません。ログイン状態と動画の公開範囲を確認してください。');
}

// APIの応答（{code, data}）からデータを取り出す。ログイン要・リスク制御などは、方法を変えて再試行せず、停止して知らせる（stopBatch）。
function ApiData(result) {
  if (result && result.code === 0 && result.data) return result.data;
  const code = Number(result && result.code);
  throw Object.assign(new Error(code === -101 ? 'Bilibiliへのログインが必要です。設定からログインしてください。' : `動画を取得できません（コード ${code || '不明'}）。公開範囲・利用制限を確認してください。`), { apiCode: code, stopBatch: [-101, -352, -412, -509].includes(code) });
}
const IdOf = video => video.videoId.startsWith('BV') ? { bvid: video.videoId } : { avid: video.videoId.slice(2) };
const ViewQuery = video => video.videoId.startsWith('BV') ? { bvid: video.videoId } : { aid: video.videoId.slice(2) };
const QUALITY = { 360: 16, 720: 64, 1080: 80 };
function PlayQuery(video, page, height) {
  if (!page || !/^[1-9]\d{0,19}$/.test(String(page.cid))) throw new Error('指定したパートの動画を取得できません。');
  return { ...IdOf(video), cid: String(page.cid), qn: String(QUALITY[height] || 64), fnval: '16', fnver: '0', fourk: '0' };
}
// 通信の流れ（view → playurl →（未対応のときだけ）署名つきplayurl）。request(endpoint, query) → 応答のJSON。
// 戻り値：{ resolved, details, verified }。verified：動画IDの別表記（av/BV）が確認できたか（呼び出し側が記録に使う）。
// 通信の順番を決めるジェネレーター：{ endpoint, query } を yield し、応答のJSONを受け取る（通信の方法は呼び出し側。共通テストデータでは、決まった応答を順に渡して確かめる）。
function* ResolveSteps(video, kind, height = 720, now = Date.now()) {
  const details = ApiData(yield { endpoint: '/x/web-interface/view', query: ViewQuery(video) });
  const page = details.pages?.find(p => p.page === video.part), query = PlayQuery(video, page, height);
  let response = yield { endpoint: '/x/player/playurl', query };
  // 未対応エンドポイントだけを切り替え、認証・レート制限では再試行しない。
  if ([-400, -404].includes(response.code)) {
    const nav = yield { endpoint: '/x/web-interface/nav', query: {} };
    if (!nav.data?.wbi_img) ApiData(nav);
    response = yield { endpoint: '/x/player/wbi/playurl', query: SignQuery(query, nav.data?.wbi_img || {}, now) };
  }
  const info = ApiData(response);
  let thumbnailURL = null; try { thumbnailURL = ImageURL(page.first_frame || details.pic); } catch { /* サムネイルは任意 */ }
  const identity = VideoIdentity(video, details);
  const resolved = { ...SelectStreams(info, kind, height), kind, url: video.url, aliases: identity.aliases, thumbnailURL, duration: Number(page.duration || details.duration || info.timelength / 1000) || 0 };
  return { resolved, details, verified: identity.verified };
}
async function ResolveWith(request, video, kind, height = 720, now = Date.now()) {
  const steps = ResolveSteps(video, kind, height, now);
  let step = steps.next();
  while (!step.done) step = steps.next(await request(step.value.endpoint, step.value.query));
  return step.value;
}
// 動画のURL（または BV/av）から、解決する。
const ResolveEntry = (request, url, kind, height, now) => ResolveWith(request, ParseBilibili(url), kind, height, now);
module.exports = { Md5, ImageURL, SignQuery, MediaURL, Stream, SelectStreams, ApiData, ViewQuery, PlayQuery, ResolveSteps, ResolveWith, ResolveEntry };
