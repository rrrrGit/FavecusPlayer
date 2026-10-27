'use strict';
(function (root) {
  async function ReadWholeList(fetchPage, progress = () => {}, active = () => true) {
    const videos = [], seen = new Set(); let skipped = 0, total = 0;
    for (let page = 1; page <= 500; page++) {
      if (!active()) return null;
      const result = await fetchPage(page);
      if (!active()) return null;
      if (!result || !Array.isArray(result.videos) || typeof result.hasMore !== 'boolean') throw new Error('リスト情報の形式が正しくありません。');
      let added = 0;
      for (const video of result.videos) {
        if (!video || typeof video.url !== 'string') throw new Error('動画情報の形式が正しくありません。');
        if (!seen.has(video.url)) { seen.add(video.url); videos.push(video); added++; }
      }
      skipped += Number.isInteger(result.skipped) && result.skipped > 0 ? result.skipped : 0;
      total = Number.isFinite(result.total) ? Math.max(total, result.total) : total;
      if (videos.length + skipped > 10000 || total > 10000) throw new Error('10000件を超えるリストは取り込めません。');
      progress({ count: videos.length, total, page, title: result.title, skipped });
      if (!result.hasMore) return { videos, skipped };
      if (!added && result.videos.length) throw new Error('同じページが繰り返されたため取得を中断しました。時間を置いて再取得してください。');
      if (!result.videos.length && !result.skipped) throw new Error('リストの途中を取得できませんでした。');
    }
    throw new Error('リストが大きすぎるため取得を中断しました。');
  }
  class PlaylistBrowser {
    constructor(api, changed = () => {}) {
      this.api = api; this.changed = changed; this.sources = []; this.current = null; this.parents = [];
      this.selected = new Map(); this.metadata = new Map(); this.titles = new Map(); this.request = 0; this.busy = false; this.closed = false; this.message = '';
    }
    get ready() { return !!this.current && !this.busy; }
    Active(token) { return !this.closed && this.request === token; }
    Title(video) { return this.titles.get(video.url)?.trim() || video.title || video.videoId || ''; }
    Rename(video, value) { this.titles.set(video.url, String(value).slice(0, 180)); if (this.selected.has(video.url)) this.selected.set(video.url, this.Title(video)); }
    Notify(message = this.message) { this.message = message; if (!this.closed) this.changed(this); }
    async Job(work) {
      if (this.closed) return;
      const token = ++this.request; this.busy = true; this.Notify('リストを取得しています…');
      try { await work(token); }
      catch (error) { if (this.Active(token)) this.Notify(`${error.message} 新しい動画はまだ追加していません。`); }
      finally { if (this.Active(token)) { this.busy = false; this.Notify(); } }
    }
    async Read(source, token) {
      return ReadWholeList(page => this.api.playlistVideos(source, page), progress => {
        if (this.Active(token)) this.Notify(`${progress.title || source.title}：${progress.count}本を取得中${progress.total ? `（全${progress.total}件）` : ''}…`);
      }, () => this.Active(token));
    }
    Show(source, result) {
      for (const video of result.videos) this.metadata.set(video.url, video);
      this.current = { source, videos: result.videos, skipped: result.skipped };
      this.Notify(`${result.videos.length}本を取得しました。${result.skipped ? `削除・非公開などの${result.skipped}件を除外しました。` : '追加する動画にチェックしてください。'}`);
    }
    async Search(input) {
      this.current = null; this.parents = []; this.sources = []; this.selected.clear();
      await this.Job(async token => {
        const sources = await this.api.playlistSources(input);
        if (!this.Active(token)) return;
        if (!Array.isArray(sources) || !sources.length) throw new Error('リストが見つかりませんでした。');
        this.sources = sources;
        const result = await this.Read(sources[0], token);
        if (result && this.Active(token)) this.Show(sources[0], result);
      });
    }
    async Select(index) {
      const source = this.sources[index]; if (!source) return;
      await this.Job(async token => {
        const result = await this.Read(source, token);
        if (result && this.Active(token)) { this.parents = []; this.Show(source, result); }
      });
    }
    async Enter(video) {
      if (!this.ready || this.current.source.kind === 'parts' || !this.current.videos.some(v => v.url === video.url)) return;
      await this.Job(async token => {
        const source = await this.api.playlistParts(video.url);
        if (!this.Active(token)) return;
        if (!source) { this.Notify('この動画には複数のパートがありません。そのままチェックして追加できます。'); return; }
        const result = await this.Read(source, token);
        if (result && this.Active(token)) { this.parents.push(this.current); this.Show(source, result); }
      });
    }
    Back() {
      if (!this.parents.length) return;
      ++this.request; this.busy = false; this.current = this.parents.pop(); this.Notify('親のリストに戻りました。別の動画の「パートを開く」から中へ進めます。');
    }
    Cancel() { ++this.request; this.busy = false; this.Notify('取得を中断しました。追加済みの再生リストは変更していません。'); }
    Close() { ++this.request; this.closed = true; }
  }
  if (typeof module === 'object') module.exports = { ReadWholeList, PlaylistBrowser };
  else root.FavecusPlaylistReader = { ReadWholeList, PlaylistBrowser };
})(globalThis);
