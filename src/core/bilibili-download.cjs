'use strict';
const { createHash } = require('node:crypto');
const { ParseBilibili } = require('./urls.cjs');
const { ImageURL } = require('./thumbnail.cjs');
const MIXIN_ORDER = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function SignQuery(query, images, now = Date.now()) {
  const key = ['img_url', 'sub_url'].map(k => new URL(images[k]).pathname.split('/').at(-1).split('.')[0]).join('');
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Bilibiliの署名情報を取得できません。');
  const salt = MIXIN_ORDER.map(i => key[i]).join('').slice(0, 32), params = { ...query, wts: Math.floor(now / 1000) };
  const encoded = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${encoded}&w_rid=${createHash('md5').update(encoded + salt).digest('hex')}`;
}
function MediaURL(raw) {
  const u = new URL(raw); if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'akamaized.net'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw new Error('未対応の動画配信先のため保存できません。');
  return u.href;
}
function Stream(item) {
  const urls = [];
  for (const raw of [item.baseUrl || item.base_url || item.url, ...(item.backupUrl || item.backup_url || [])]) { try { urls.push(MediaURL(raw)); } catch {} }
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
class BilibiliDownloadSource {
  constructor(fetch) { this.fetch = fetch; }
  async Cover(entry, signal) {
    const video = ParseBilibili(entry.url), query = video.videoId.startsWith('BV') ? { bvid: video.videoId } : { aid: video.videoId.slice(2) };
    const data = this.Data(await this.Request('/x/web-interface/view', query, signal));
    const raw = data.pages?.find(p => p.page === video.part)?.first_frame || data.pic;
    return raw ? ImageURL(raw) : null;
  }
  async Request(endpoint, query, signal) {
    const params = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const response = await this.fetch(`https://api.bilibili.com${endpoint}?${params}`, { credentials: 'include', redirect: 'error', headers: { Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Bilibiliから情報を取得できません（HTTP ${response.status}）。ログイン状態を確認し、時間を置いて再実行してください。`), { httpStatus: response.status, stopBatch: [401, 412, 429].includes(response.status) }); }
    return response.json();
  }
  Data(result) {
    if (result.code === 0 && result.data) return result.data;
    throw Object.assign(new Error(result.code === -101 ? 'Bilibiliへのログインが必要です。設定からログインしてください。' : `動画を取得できません（コード ${Number(result.code) || '不明'}）。公開範囲・利用制限を確認してください。`), { apiCode: Number(result.code), stopBatch: [-101, -352, -412, -509].includes(result.code) });
  }
  async Resolve(entry, kind, signal, { height = 720 } = {}) {
    signal.throwIfAborted(); const video = ParseBilibili(entry.url), id = video.videoId.startsWith('BV') ? { bvid: video.videoId } : { avid: video.videoId.slice(2) };
    const details = this.Data(await this.Request('/x/web-interface/view', video.videoId.startsWith('BV') ? id : { aid: id.avid }, signal));
    const page = details.pages?.find(p => p.page === video.part);
    if (!page || !/^[1-9]\d{0,19}$/.test(String(page.cid))) throw new Error('指定したパートの動画を取得できません。');
    const query = { ...id, cid: String(page.cid), qn: String({ 360: 16, 720: 64, 1080: 80 }[height] || 64), fnval: '16', fnver: '0', fourk: '0' };
    let response = await this.Request('/x/player/playurl', query, signal);
    // 未対応エンドポイントだけを切り替え、認証・レート制限では再試行しない。
    if ([-400, -404].includes(response.code)) { const nav = await this.Request('/x/web-interface/nav', {}, signal); if (!nav.data?.wbi_img) this.Data(nav); response = await this.Request('/x/player/wbi/playurl', SignQuery(query, nav.data?.wbi_img || {}), signal); }
    const info = this.Data(response);
    let thumbnailURL = null; try { thumbnailURL = ImageURL(page.first_frame || details.pic); } catch {}
    const aliases = [details.bvid, details.aid ? `av${details.aid}` : null].filter(Boolean).map(id => ParseBilibili(`https://www.bilibili.com/video/${id}/?p=${video.part}`).url);
    return { ...SelectStreams(info, kind, height), kind, url: video.url, aliases, thumbnailURL, duration: Number(page.duration || details.duration || info.timelength / 1000) || 0 };
  }
}
module.exports = { BilibiliDownloadSource, SelectStreams, MediaURL, SignQuery };
