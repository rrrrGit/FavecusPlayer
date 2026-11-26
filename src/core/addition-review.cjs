'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { MEDIA_EXTENSIONS } = require('./urls.cjs');
const { DuplicateIndex } = require('./duplicates.cjs');
const LIMIT = 10000, LIFETIME = 30 * 60000;
class AdditionReview {
  constructor(store, options = {}) { this.store = store; this.options = options; this.plans = new Map(); this.now = options.now || Date.now; }
  StateKey() { return createHash('sha256').update(JSON.stringify([this.store.data.settings.titleCleanupWords, this.store.data.playlists, this.store.data.videoAliases])).digest('hex'); }
  async Prepare(action) {
    const items = this.store.InputItems(action);
    this.store.Targets(action.destinationIds ?? action.playlistId);
    const warnings = [];
    if (action.type === 'add' && this.options.resolveTitle) {
      const pending = items.filter(item => !item.title); let cursor = 0, failures = 0;
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (cursor < pending.length) {
          const item = pending[cursor++];
          try { item.title = await this.options.resolveTitle(item) || ''; if (!item.title) failures++; }
          catch { failures++; }
        }
      }));
      if (failures) warnings.push(`${failures}曲の名前を取得できなかったため、その曲はURLでのみ確認しました。`);
    }
    return this.PrepareItems(action.destinationIds ?? action.playlistId, items.map(entry => ({ entry })), warnings);
  }
  // describe(file) → { title?, artist? }：ファイルに埋め込まれたタグ（フォルダから追加。曲名はファイル名より優先、アーティストは曲の情報へ）。最大4ファイルずつ並行して読む。
  async PrepareFiles(destinationIds, files, { describe } = {}) {
    this.store.Targets(destinationIds);
    if (!Array.isArray(files) || !files.length || files.length > LIMIT) throw new Error('追加するファイルを選んでください（最大10000件）。');
    const described = new Map();
    if (describe) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
        while (next < files.length) { const file = files[next++]; try { described.set(file, (await describe(file)) || {}); } catch { described.set(file, {}); } }
      }));
    }
    const candidates = [];
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext) || !(await fs.promises.stat(file)).isFile()) throw new Error('対応していないファイルです。');
      const info = described.get(file) || {};
      candidates.push({ sourceFile: file, ...(info.artist ? { artist: info.artist } : {}), entry: { type: 'local', fileName: `${randomUUID()}${ext === '.wma' ? '.flac' : ext}`, title: info.title || path.basename(file, path.extname(file)) } });
    }
    return this.PrepareItems(destinationIds, candidates);
  }
  PrepareItems(destinationIds, candidates, warnings = []) {
    const targets = this.store.Targets(destinationIds);
    if (targets.length * candidates.length > LIMIT) throw new Error('1回の追加は、曲数と追加先数の組み合わせを10000件以内にしてください。');
    const items = candidates.map(item => ({ ...item, entry: { ...item.entry, title: this.store.CleanTitle(item.entry.title) } }));
    const operations = [], conflicts = [];
    for (const target of targets) {
      const index = new DuplicateIndex(target.entries, this.store.IdentityKey());
      for (const [itemIndex, candidate] of items.entries()) {
        const id = `${target.id}:${itemIndex}`, duplicate = index.Find(candidate.entry);
        operations.push({ id, playlistId: target.id, itemIndex, duplicate: !!duplicate });
        if (duplicate) conflicts.push({ id, playlistName: target.name, title: candidate.entry.title || candidate.entry.videoId || 'ローカルファイル', url: candidate.entry.url || '', reason: duplicate.reason,
          matches: duplicate.matches.map(match => ({ title: match.entry.title || match.entry.videoId || 'ローカルファイル', url: match.entry.url || '', origin: match.origin })) });
        index.Add(candidate.entry, '今回一緒に追加する曲');
      }
    }
    const time = this.now();
    for (const [id, plan] of this.plans) if (time - plan.createdAt >= LIFETIME && !plan.busy) this.plans.delete(id);
    if (this.plans.size >= 3) { const oldest = [...this.plans.values()].find(plan => !plan.busy); if (oldest) this.Cancel(oldest.id); else throw new Error('前の追加処理が完了するまでお待ちください。'); }
    const id = randomUUID(), plan = { id, items, operations, key: this.StateKey(), createdAt: time, cancelled: false, busy: false };
    this.plans.set(id, plan);
    return { id, totalCount: operations.length, normalCount: operations.length - conflicts.length, conflicts, warnings };
  }
  Cancel(id) { const plan = this.plans.get(id); if (plan) plan.cancelled = true; this.plans.delete(id); }
  Fresh(plan) {
    if (plan.cancelled) throw new Error('追加を取りやめました。');
    if (this.now() - plan.createdAt >= LIFETIME) throw new Error('確認の有効時間が過ぎました。追加操作からやり直してください。');
    if (plan.key !== this.StateKey()) throw new Error('確認中にプレイリストが変更されました。追加操作からやり直して、重複候補を確認してください。');
  }
  async Commit(id, allowedIds = []) {
    const plan = this.plans.get(id);
    if (!plan || plan.busy) throw new Error('追加内容が見つからないか、すでに処理中です。追加操作からやり直してください。');
    if (!Array.isArray(allowedIds) || allowedIds.length > LIMIT || allowedIds.some(value => typeof value !== 'string')) throw new Error('重複しても追加する曲をチェックしてください。');
    const known = new Set(plan.operations.filter(op => op.duplicate).map(op => op.id));
    if (allowedIds.some(value => !known.has(value))) throw new Error('重複確認の指定が正しくありません。');
    this.Fresh(plan); plan.busy = true;
    const allowed = new Set(allowedIds), selected = plan.operations.filter(op => !op.duplicate || allowed.has(op.id)), copied = [];
    let before = null;
    try {
      if (this.store.data.playlists.reduce((n, p) => n + p.entries.length, 0) + selected.length > LIMIT) throw new Error('登録数の上限は全リスト合計10000件です。');
      for (const itemIndex of new Set(selected.map(op => op.itemIndex))) {
        const item = plan.items[itemIndex]; if (!item.sourceFile) continue;
        this.Fresh(plan);
        const destination = path.join(this.store.media, item.entry.fileName); copied.push(destination);
        if (path.extname(item.sourceFile).toLowerCase() === '.wma') {
          if (!this.store.options.convertWma) throw new Error('WMAの変換環境が見つかりません。セットアップを再実行してください。');
          await this.store.options.convertWma(item.sourceFile, destination);
        } else await fs.promises.copyFile(item.sourceFile, destination);
      }
      this.Fresh(plan); before = structuredClone(this.store.data);
      const nowIso = new Date().toISOString();
      for (const op of selected) {
        const list = this.store.Playlist(op.playlistId);
        list.entries.push({ ...structuredClone(plan.items[op.itemIndex].entry), id: randomUUID(), addedAt: nowIso });
        list.lastAddedAt = nowIso;
      }
      if (selected.length) this.store.Save();
      this.plans.delete(id);
      return { state: this.store.Snapshot(), added: selected.length, skipped: plan.operations.length - selected.length };
    } catch (error) {
      if (before) this.store.data = before;
      for (const file of copied) await fs.promises.rm(file, { force: true }).catch(() => {});
      throw error;
    } finally { plan.busy = false; }
  }
}
module.exports = { AdditionReview };
