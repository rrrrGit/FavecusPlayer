'use strict';
const { CleanText } = require('./store.cjs');
const { ParseBilibili, SharedURL } = require('./urls.cjs');
const MAX_VIDEOS = 10000, PAGE_SIZE = 30;
const Numeric = value => /^[1-9]\d{0,19}$/.test(String(value || ''));
function Video(item) {
  const id = item.bvid || item.arc?.bvid || (item.aid ? `av${item.aid}` : '');
  return { ...ParseBilibili(id), title: CleanText(item.title || item.arc?.title), artist: CleanText(item.upper?.name || item.owner?.name, 80), duration: Number(item.duration || item.arc?.duration) || 0 };
}
function CollectionURL(input) {
  let url;
  try { url = SharedURL(input); } catch { return null; }
  const q = url.searchParams, pathname = url.pathname;
  const favorite = q.get('fid') || pathname.match(/^\/medialist\/play\/ml(\d+)/)?.[1] || pathname.match(/^\/list\/ml(\d+)/)?.[1];
  if (Numeric(favorite)) return { kind: 'favorite', id: favorite, title: '收藏夹' };
  const mid = pathname.match(/^\/(?:(?:list|medialist\/play)\/)?(\d+)(?:\/|$)/)?.[1];
  const id = q.get('sid') || q.get('season_id') || q.get('series_id') || q.get('business_id') || pathname.match(/^\/\d+\/lists\/(\d+)\/?$/)?.[1];
  const type = q.get('type') || q.get('business');
  if (Numeric(mid) && Numeric(id)) {
    if (type === 'favorite') return { kind: 'favorite', id, title: '收藏夹' };
    if (type === 'season' || type === 'space_collection' || q.has('season_id') || pathname.endsWith('/collectiondetail')) return { kind: 'season', mid, id, title: '合集' };
    if (type === 'series' || type === 'space_series' || q.has('series_id') || pathname.endsWith('/seriesdetail')) return { kind: 'series', mid, id, title: '系列' };
  }
  return null;
}

class BilibiliAccount {
  constructor(fetch) { this.fetch = fetch; this.cache = new Map(); }
  async Request(endpoint, query = {}) {
    const url = new URL(`https://api.bilibili.com${endpoint}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await this.fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(12000), headers: { Referer: 'https://www.bilibili.com/' } });
    if (!response.ok) throw new Error(`Bilibiliに接続できません（HTTP ${response.status}）。ログイン状態を確認し、時間を置いて再取得してください。`);
    const value = await response.json();
    if (value.code === -101) return null;
    if (value.code !== 0) throw new Error(`Bilibili: ${CleanText(value.message || '情報を取得できません', 120)}`);
    return value.data;
  }
  async Profile() {
    const p = await this.Request('/x/web-interface/nav');
    return p?.isLogin && Number.isSafeInteger(p.mid) ? { loggedIn: true, uid: String(p.mid), name: CleanText(p.uname, 60) } : { loggedIn: false };
  }
  async Folders() {
    const p = await this.Profile();
    if (!p.loggedIn) throw new Error('設定からBilibiliにログインしてください。');
    const data = await this.Request('/x/v3/fav/folder/created/list-all', { up_mid: p.uid });
    return (data?.list || []).slice(0, 100).filter(x => Number.isSafeInteger(x.id)).map(x => ({ id: String(x.id), title: CleanText(x.title, 80), count: x.media_count || 0 }));
  }
  async Videos(id, page) {
    if (!/^\d{1,20}$/.test(id) || !Number.isInteger(page) || page < 1 || page > 500) throw new Error('リストの指定が正しくありません。');
    const data = await this.Request('/x/v3/fav/resource/list', { media_id: id, pn: page, ps: 20, order: 'mtime', type: 0, tid: 0, platform: 'web' });
    const videos = [];
    for (const item of data?.medias || []) {
      try { videos.push(Video(item)); } catch {}
    }
    if (!data) throw new Error('この保存リストを取得できません。ログインとリストの公開範囲を確認してください。');
    return { videos, hasMore: data.has_more === true || data.has_more === 1, total: data.info?.media_count || 0, title: CleanText(data.info?.title, 80) || '收藏夹', skipped: (data.medias || []).length - videos.length };
  }
  async Details(id) {
    const video = ParseBilibili(id), key = video.videoId;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const data = await this.Request('/x/web-interface/view', key.startsWith('BV') ? { bvid: key } : { aid: key.slice(2) });
    if (!data || !Array.isArray(data.pages)) throw new Error('この動画のリスト情報を取得できません。動画が公開されているか確認してください。');
    if (this.cache.size >= 10) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { at: Date.now(), value: data });
    return data;
  }
  async Resolve(input) {
    const lines = String(input || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length > 1) {
      if (lines.length > 100) throw new Error('一度に読み込めるURLは100件までです。');
      if (lines.some(line => CollectionURL(line))) throw new Error('再生リストURLは1件ずつ読み込んでください。');
      const videos = new Array(lines.length); let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, lines.length) }, async () => { while (cursor < lines.length) { const index = cursor++; videos[index] = (await this.Resolve(lines[index])).video; } }));
      return { kind: 'videos', videos, sources: [] };
    }
    const direct = CollectionURL(input);
    if (direct) return { kind: 'playlist', sources: [direct], url: String(input) };
    const video = ParseBilibili(input), data = await this.Details(video.videoId);
    const page = data.pages.find(p => p.page === video.part);
    if (!page) throw new Error('指定したパートが見つかりません。');
    const title = data.pages.length > 1 ? page.part || data.title : data.title;
    const sources = await this.Lists(input).catch(() => []);
    return { kind: sources.length ? 'playlist' : 'video', video: { ...video, title: CleanText(title), duration: Number(page.duration || data.duration) || 0 }, sources };
  }
  async Lists(input) {
    const direct = CollectionURL(input);
    if (direct) return [direct];
    const video = ParseBilibili(input), data = await this.Details(video.videoId), sources = [];
    const id = ParseBilibili(data.bvid || video.videoId).videoId;
    if (data.pages.length > 1) sources.push({ kind: 'parts', id, title: `${CleanText(data.title, 80) || id} · 全パート`, total: data.pages.length });
    const season = data.ugc_season, mid = season?.mid || data.owner?.mid;
    if (Numeric(season?.id) && Numeric(mid)) sources.push({ kind: 'season', id: String(season.id), mid: String(mid), videoId: video.videoId, title: `${CleanText(season.title, 80) || '合集'} · 合集`, total: season.ep_count || 0 });
    if (!sources.length) throw new Error('この動画から全パート・合集を見つけられませんでした。收藏夹や系列の一覧URLがある場合は、そのURLを貼り付けてください。単体の動画は「URLから追加」から登録できます。');
    return sources;
  }
  async Parts(input) {
    const video = ParseBilibili(input), data = await this.Details(video.videoId);
    if (data.pages.length < 2) return null;
    return { kind: 'parts', id: ParseBilibili(data.bvid || video.videoId).videoId, title: `${CleanText(data.title, 80) || video.videoId} · 全パート`, total: data.pages.length };
  }
  async ListVideos(source, page = 1) {
    if (!source || !['parts', 'season', 'series', 'favorite'].includes(source.kind) || !Number.isInteger(page) || page < 1 || page > 500) throw new Error('再生リストの指定が正しくありません。');
    if (source.kind === 'favorite') return this.Videos(String(source.id), page);
    if (source.kind === 'parts') {
      const data = await this.Details(source.id), id = ParseBilibili(data.bvid || source.id).videoId;
      if (data.pages.length > MAX_VIDEOS) throw new Error('10000件を超えるリストは取り込めません。');
      const offset = (page - 1) * PAGE_SIZE;
      const videos = data.pages.slice(offset, offset + PAGE_SIZE).map(p => {
        if (!Number.isInteger(p.page) || p.page < 1 || p.page > MAX_VIDEOS) throw new Error('パート情報の形式が変わったため取得を中断しました。');
        return { ...ParseBilibili(`https://www.bilibili.com/video/${id}/?p=${p.page}`), title: CleanText(p.part || data.title), artist: CleanText(data.owner?.name, 80), duration: Number(p.duration) || 0 };
      });
      return { videos, title: CleanText(data.title, 80), hasMore: offset + PAGE_SIZE < data.pages.length, total: data.pages.length, skipped: 0 };
    }
    if (!Numeric(source.id) || !Numeric(source.mid)) throw new Error('再生リストの番号が正しくありません。');
    // 動画詳細に全件含まれていれば、その投稿者の並び順をそのまま使う。
    if (source.kind === 'season' && source.videoId) {
      const details = await this.Details(source.videoId), season = details.ugc_season;
      if (String(season?.id) !== String(source.id)) throw new Error('合集が変更されています。URLから再取得してください。');
      const episodes = (season.sections || []).flatMap(s => s.episodes || []);
      if (Number.isInteger(season.ep_count) && season.ep_count > 0 && episodes.length === season.ep_count) {
        const offset = (page - 1) * PAGE_SIZE, items = episodes.slice(offset, offset + PAGE_SIZE);
        return this.Page(items, offset + PAGE_SIZE < episodes.length, episodes.length, season.title);
      }
    }
    const data = source.kind === 'season'
      ? await this.Request('/x/polymer/web-space/seasons_archives_list', { mid: source.mid, season_id: source.id, sort_reverse: false, page_num: page, page_size: PAGE_SIZE })
      : await this.Request('/x/series/archives', { mid: source.mid, series_id: source.id, only_normal: true, sort: 'asc', pn: page, ps: PAGE_SIZE });
    if (!data || !Array.isArray(data.archives)) throw new Error('このリストを取得できません。ログイン・公開範囲・一覧URLを確認してください。');
    const total = Number(data.page?.total || data.meta?.total || 0);
    const hasMore = total > 0 ? page * PAGE_SIZE < total : data.archives.length === PAGE_SIZE;
    return this.Page(data.archives, hasMore, total, data.meta?.name || source.title);
  }
  Page(items, hasMore, total, title) {
    if (total > MAX_VIDEOS) throw new Error('10000件を超えるリストは取り込めません。');
    const videos = [];
    for (const item of items) { try { videos.push(Video(item)); } catch {} }
    if (hasMore && !items.length) throw new Error('リストの途中を取得できませんでした。時間を置いて再取得してください。');
    return { videos, hasMore, total, title: CleanText(title, 80), skipped: items.length - videos.length };
  }
}
module.exports = { BilibiliAccount, CollectionURL };
