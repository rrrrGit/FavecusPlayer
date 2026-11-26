'use strict';
const { ParseBilibili } = require('./urls.cjs');
const { VideoIdentity } = require('./media-identity.cjs');
// 配信先の選択・署名・解決の規則は、iPhone版と共通の bilibili-resolve.cjs。ここはWindowsのfetch・Cookie・中断の処理。
const { ImageURL, SignQuery, MediaURL, SelectStreams, ApiData, ViewQuery, ResolveWith } = require('./bilibili-resolve.cjs');
class BilibiliDownloadSource {
  constructor(fetch, identify = () => {}) { this.fetch = fetch; this.identify = identify; }
  async Cover(entry, signal) {
    const video = ParseBilibili(entry.url), query = video.videoId.startsWith('BV') ? { bvid: video.videoId } : { aid: video.videoId.slice(2) };
    const data = this.Data(await this.Request('/x/web-interface/view', query, signal));
    if (VideoIdentity(entry, data).verified) this.identify(entry, data);
    const raw = data.pages?.find(p => p.page === video.part)?.first_frame || data.pic;
    return raw ? ImageURL(raw) : null;
  }
  async Request(endpoint, query, signal) {
    const params = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const response = await this.fetch(`https://api.bilibili.com${endpoint}?${params}`, { credentials: 'include', redirect: 'error', headers: { Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Bilibiliから情報を取得できません（HTTP ${response.status}）。ログイン状態を確認し、時間を置いて再実行してください。`), { httpStatus: response.status, stopBatch: [401, 403, 412, 429].includes(response.status) }); }
    return response.json();
  }
  Data(result) { return ApiData(result); }
  async Resolve(entry, kind, signal, { height = 720 } = {}) {
    signal.throwIfAborted(); const video = ParseBilibili(entry.url);
    const out = await ResolveWith((endpoint, query) => this.Request(endpoint, query, signal), video, kind, height);
    if (out.verified) this.identify(entry, out.details);
    return out.resolved;
  }
}
module.exports = { BilibiliDownloadSource, SelectStreams, MediaURL, SignQuery };
