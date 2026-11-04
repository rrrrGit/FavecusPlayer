'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { ParseBilibili } = require('./urls.cjs');
const { DownloadIdentity, VideoIdentity } = require('./media-identity.cjs');
const { LibraryMediaKey } = require('./library-identity.cjs');
const { BilibiliDownloadSource } = require('./bilibili-download.cjs');
const { DownloadStream, Assemble } = require('./download-transfer.cjs');
const { RemoteImage, ImageData, ImageURL } = require('./thumbnail.cjs');
const { DownloadSelection, EstimateKey, EstimateDownloads, LiveEstimate, PlanBytes, AvailableBytes, JobTiming } = require('./download-estimate.cjs');
const { SafeName, SharedFolder, TrackFile } = require('./offline-layout.cjs');
const { DownloadDiagnostic } = require('./download-errors.cjs');
const { MigrateShared } = require('./offline-migration.cjs');
const Token = /^[a-f0-9]{64}\.(mp4|m4a)$/;
const Key = (url, kind) => createHash('sha256').update(DownloadIdentity(url, kind).key).digest('hex');
function AtomicJSON(file, value) { const tmp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx' }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); } }
function ReadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
class OfflineLibrary {
  constructor({ directory, previousDirectories = [], settingsFile, fetch, ffmpeg, changed = () => {}, diagnostic = () => {}, libraryData = () => null, identify = () => {}, resolve, cover, thumbnail = RemoteImage, assemble = Assemble, transfer = DownloadStream }) {
    Object.assign(this, { settingsFile, fetch, ffmpeg, changed, diagnostic, libraryData, assemble, transfer, thumbnail }); this.active = new Map();
    this.cover = cover || ((...args) => new BilibiliDownloadSource(fetch, identify).Cover(...args));
    this.resolve = resolve || ((...args) => new BilibiliDownloadSource(fetch, identify).Resolve(...args)); this.job = null; this.controller = null; this.done = Promise.resolve();
    let settings = {}; try { settings = ReadJSON(settingsFile, {}); } catch { this.warning = '保存先の設定を読み込めません。標準の保存先を使用します。'; }
    this.directory = path.resolve(typeof settings.directory === 'string' && path.isAbsolute(settings.directory) ? settings.directory : directory);
    this.preferSaved = settings.preferSaved !== false;
    if (!fs.existsSync(this.directory) && previousDirectories.some(p => path.resolve(p) === this.directory)) { this.directory = path.resolve(directory); this.SaveSettings(); }
    this.ReadIndex();
  }
  ReadIndex() {
    this.records = new Map(); this.indexError = '';
    try {
      const data = ReadJSON(path.join(this.directory, 'index.json'), { version: 1, files: [] });
      if (data.version !== 1 || !Array.isArray(data.files) || data.files.length > 20000) throw new Error('invalid index');
      for (const r of data.files) {
        if (!r || !['video', 'audio'].includes(r.kind) || !Token.test(r.token) || r.token !== `${Key(r.url, r.kind)}.${r.kind === 'video' ? 'mp4' : 'm4a'}` || typeof r.file !== 'string' || !Number.isSafeInteger(r.bytes) || r.bytes <= 0) throw new Error('invalid record');
        this.ResolvePath(r.file); r.aliases = (Array.isArray(r.aliases) ? r.aliases : []).slice(0, 2).filter(url => { try { return ParseBilibili(url).part === ParseBilibili(r.url).part; } catch { return false; } }); this.records.set(r.token, r);
      }
    } catch { this.records.clear(); this.indexError = '保存一覧を読み込めません。index.jsonを保持したまま、別の保存先を選択してください。'; }
  }
  ResolvePath(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('保存先の相対パスが正しくありません。');
    const full = path.resolve(this.directory, relative), rel = path.relative(this.directory, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('保存先の範囲外です。');
    if (fs.existsSync(this.directory)) {
      let existing = full; while (!fs.existsSync(existing) && existing !== this.directory) existing = path.dirname(existing);
      const real = path.relative(fs.realpathSync(this.directory), fs.realpathSync(existing));
      if (real.startsWith('..') || path.isAbsolute(real)) throw new Error('保存先の範囲外を参照しています。');
    }
    return full;
  }
  File(token) { const r = this.records.get(token); if (!r || !Token.test(token)) return null; try { const file = this.ResolvePath(r.file), stat = fs.statSync(file); return stat.isFile() && stat.size === r.bytes ? { ...r, path: file } : null; } catch { return null; } }
  Find(entry, preferred = 'video', exact = false) {
    if (entry?.type !== 'bilibili') return null;
    const url = ParseBilibili(entry.url).url, keyOf = LibraryMediaKey(this.libraryData()?.videoAliases), key = keyOf(entry);
    for (const kind of exact ? [preferred] : [preferred, preferred === 'video' ? 'audio' : 'video']) {
      const r = this.File(`${Key(url, kind)}.${kind === 'video' ? 'mp4' : 'm4a'}`); if (r) return r;
      for (const record of this.records.values()) if (record.kind === kind && (record.aliases?.includes(url) || keyOf({ type: 'bilibili', url: record.url }) === key)) {
        const alias = this.File(record.token); if (alias) return alias;
      }
    }
    return null;
  }
  Cover(entryOrToken) {
    const record = typeof entryOrToken === 'string' ? this.File(entryOrToken) : this.Find(entryOrToken);
    const cover = record?.thumbnail;
    if (!cover || !Number.isSafeInteger(cover.bytes) || cover.bytes <= 0 || cover.bytes > 3 * 1024 * 1024) return null;
    try { const file = this.ResolvePath(cover.file), stat = fs.statSync(file); return stat.isFile() && stat.size === cover.bytes ? ImageData(fs.readFileSync(file)) : null; } catch { return null; }
  }
  async SaveCover(record, rawURL, signal) {
    signal.throwIfAborted();
    if (record.layout === 4) for (const kind of ['video', 'audio']) {
      const other = this.Find({ type: 'bilibili', url: record.url }, kind, true);
      if (other?.layout === 4 && path.posix.dirname(other.file) === path.posix.dirname(record.file) && this.Cover(other.token)) {
        return { ...record, thumbnailURL: other.thumbnailURL || rawURL, thumbnail: other.thumbnail };
      }
    }
    if (!rawURL) return record;
    const url = ImageURL(rawURL), data = await this.thumbnail(this.fetch, url, signal); signal.throwIfAborted();
    const bytes = Buffer.from(data.split(',')[1] || '', 'base64'), verified = ImageData(bytes), extension = verified.match(/^data:image\/(png|jpeg|webp);/)[1];
    const relative = `${record.file.slice(0, record.file.lastIndexOf('.'))}.thumbnail-${randomUUID().slice(0, 8)}.${extension}`, target = this.ResolvePath(relative);
    const handle = await fs.promises.open(target, 'wx');
    try { await handle.writeFile(bytes); } catch (error) { await handle.close(); await fs.promises.rm(target, { force: true }).catch(() => {}); throw error; }
    await handle.close();
    return { ...record, thumbnailURL: url, thumbnail: { file: relative, bytes: bytes.length } };
  }
  Failure(entry, error, phase) {
    const details = DownloadDiagnostic(error, phase), recordId = randomUUID();
    try { this.diagnostic({ at: new Date().toISOString(), recordId, jobId: this.job?.id || null, videoId: entry?.videoId || null, part: entry?.part || null, kind: this.job?.kind || null, height: this.job?.height || null, ...details }); } catch {}
    return { title: entry?.title || entry?.videoId || '', recordId, ...details };
  }
  CoverWarning(entry, error) { this.job.thumbnailFailed++; const failure = this.Failure(entry, error, 'cover'); if (this.job.warnings.length < 200) this.job.warnings.push({ ...failure, message: `サムネイルを保存できませんでした。動画・音声は利用できます。${failure.message}` }); }
  CommitRecord(record) { const { path: _localPath, ...saved } = record; const next = new Map(this.records); next.set(record.token, saved); AtomicJSON(path.join(this.directory, 'index.json'), { version: 1, files: [...next.values()] }); this.records = next; }
  CommitRecords(records) { fs.mkdirSync(this.directory, { recursive: true }); AtomicJSON(path.join(this.directory, 'index.json'), { version: 1, files: [...records.values()] }); this.records = new Map(records); }
  Snapshot() {
    const aliases = new Map();
    for (const pair of this.libraryData()?.videoAliases || []) { aliases.set(`av${pair.aid}`, pair); aliases.set(pair.bvid, pair); }
    const available = [...this.records.values()].filter(r => this.File(r.token)).flatMap(r => {
      const video = VideoIdentity(r), urls = VideoIdentity(r, aliases.get(video.videoId)).aliases;
      return [...new Set([r.url, ...(r.aliases || []), ...urls])].map(url => ({ url, kind: r.kind, height: r.height }));
    });
    return { directory: this.directory, preferSaved: this.preferSaved, warning: this.indexError || this.warning || '', job: JobTiming(this.job), available };
  }
  Notify(catalog = false) {
    if (this.liveEstimate) this.job.estimate = this.liveEstimate.Snapshot();
    if (this.job) { this.job.active = [...this.active.values()].map(({ title, phase, bytes, totalBytes }) => ({ title, phase, bytes, totalBytes })); this.job.title = this.job.active[0]?.title || ''; this.job.phase = this.job.active[0]?.phase || ''; this.job.bytes = this.job.active.reduce((n, a) => n + a.bytes, 0); this.job.totalBytes = this.job.active.every(a => a.totalBytes) ? this.job.active.reduce((n, a) => n + a.totalBytes, 0) : 0; }
    this.changed(catalog ? this.Snapshot() : { job: JobTiming(this.job) });
  }
  SaveSettings(directory = this.directory, preferSaved = this.preferSaved) { fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true }); AtomicJSON(this.settingsFile, { directory, preferSaved }); }
  SetDirectory(directory) { if (this.controller || this.importing) throw new Error('保存・出力・取り込み中は保存先を変更できません。'); if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('保存先を選択してください。'); this.CancelEstimate(); this.SaveSettings(path.resolve(directory)); this.directory = path.resolve(directory); this.ReadIndex(); this.Notify(true); return this.Snapshot(); }
  PreferSaved(value) { if (typeof value !== 'boolean') throw new Error('設定が正しくありません。'); this.SaveSettings(this.directory, value); this.preferSaved = value; this.Notify(true); return this.Snapshot(); }
  CancelEstimate() { this.estimateController?.abort(); this.estimateController = null; this.estimate = null; }
  async Estimate(entries, options) {
    if (this.controller || this.importing) throw new Error('保存・取り込みが終わってから見積もってください。');
    this.CancelEstimate(); const selected = DownloadSelection(entries, options), controller = new AbortController(); this.estimateController = controller;
    try {
      const value = await EstimateDownloads(selected, options, { directory: this.directory, resolve: this.resolve, cached: (...args) => this.Find(...args), cover: token => this.Cover(token), signal: controller.signal,
        changed: progress => this.changed({ estimateProgress: { ...progress, playlistId: options.playlistId } }) });
      controller.signal.throwIfAborted(); this.estimate = { ...value, id: randomUUID() }; return structuredClone(this.estimate);
    } finally { if (this.estimateController === controller) this.estimateController = null; }
  }
  TrackPath(entry, kind, height, playlistId, playlistName, data = this.libraryData() || this.layoutData) {
    const url = ParseBilibili(entry.url).url, keyOf = LibraryMediaKey(data?.videoAliases), key = keyOf(entry);
    const shared = [...this.records.values()].find(r => r.layout === 4 && (r.aliases?.includes(url) || keyOf({ type: 'bilibili', url: r.url }) === key) && this.File(r.token));
    const folder = shared ? path.posix.dirname(shared.file) : SharedFolder(entry, data);
    return `${folder}/${TrackFile(kind, height)}`;
  }
  async CleanupRecord(previous, current) {
    if (!previous) return;
    const used = new Set([...this.records.values()].flatMap(r => [r.file, r.thumbnail?.file]));
    for (const name of [previous.file, previous.thumbnail?.file].filter(Boolean)) if (name !== current?.file && name !== current?.thumbnail?.file && !used.has(name)) {
      try { const file = this.ResolvePath(name); if (!fs.lstatSync(file).isSymbolicLink()) { await fs.promises.rm(file, { force: true }); let directory = path.dirname(file); while (directory !== this.directory) { try { await fs.promises.rmdir(directory); } catch { break; } directory = path.dirname(directory); } } } catch {}
    }
  }
  async Organize() {
    if (this.controller || this.importing || this.indexError) return;
    await this.ReconcileLayout(this.libraryData());
  }
  async ReconcileLayout(data, signal) {
    if (this.migrationDone) return this.migrationDone;
    if (this.indexError || this.importing || (this.controller && signal !== this.controller.signal)) return;
    if (this.warning === this.migrationWarning) this.warning = '';
    this.CancelEstimate(); this.importing = true;
    this.migrationDone = MigrateShared(this, data, signal).catch(error => {
      if (signal?.aborted) throw error;
      const failure = this.Failure(null, error, 'layout'); this.warning = `[${failure.code}] ${failure.message} 記録ID: ${failure.recordId}`;
      this.migrationWarning = this.warning;
      if (this.job?.status === 'running' && this.job.warnings.length < 200) this.job.warnings.push(failure);
      if (this.controller) throw error;
    }).finally(() => { this.importing = false; this.migrationDone = null; });
    return this.migrationDone;
  }
  Start(entries, { kind, height = 720, playlistId, playlistName, estimateId }) {
    if (this.controller || this.importing) throw new Error('別の保存・取り込み処理が進行中です。');
    const selected = DownloadSelection(entries, { kind, height });
    const estimate = this.estimate?.key === EstimateKey(selected, { kind, height }, this.directory) ? this.estimate : null;
    if (estimateId && (!estimate || estimate.id !== estimateId || Date.now() - estimate.createdAt > 600000)) throw new Error('保存対象が変わったか、見積もりが古くなりました。再計算してください。');
    if (this.indexError) throw new Error(this.indexError);
    if (!fs.existsSync(this.ffmpeg)) throw new Error('保存に必要なFFmpegがありません。セットアップの修復を実行してください。');
    try { fs.mkdirSync(this.directory, { recursive: true }); fs.accessSync(this.directory, fs.constants.W_OK); } catch { throw new Error('保存先に書き込めません。「保存先を変更」で別のフォルダーを選択してください。'); }
    const partial = this.ResolvePath('.partial');
    if (fs.existsSync(partial)) for (const name of fs.readdirSync(partial)) if (/^favecus-[a-f0-9-]{36}$/.test(name)) { const old = this.ResolvePath(`.partial/${name}`); if (!fs.lstatSync(old).isSymbolicLink()) fs.rmSync(old, { recursive: true, force: true }); }
    const data = this.libraryData(), layoutData = data ? structuredClone(data) : null;
    this.CancelEstimate(); this.controller = new AbortController(); this.cancelRequested = false; this.active.clear(); this.layoutData = layoutData;
    this.job = { id: randomUUID(), playlistId, playlistName, kind, height, status: 'running', concurrency: 3, startedAt: Date.now(), downloadedBytes: 0, estimate, total: selected.length, completed: 0, skipped: 0, failed: 0, finished: 0, title: '', phase: '準備中', bytes: 0, totalBytes: 0, failures: [], warnings: [], thumbnailFailed: 0 };
    this.liveEstimate = estimate ? null : new LiveEstimate(selected, { kind, height }, this.directory);
    this.Notify(); this.done = this.Run(selected, this.controller.signal); return this.Snapshot();
  }
  Cancel() { if (this.controller && !this.controller.signal.aborted) { this.cancelRequested = true; this.job.status = 'cancelling'; this.controller.abort(new Error('保存を中止しました。')); this.Notify(); } return this.Snapshot(); }
  async Reuse(entry, cached, signal, task) {
    this.liveEstimate?.Saved(entry, cached, !!this.Cover(cached.token));
    if (!this.Cover(cached.token)) {
      task.phase = '保存済みのサムネイルを補完中'; task.stage = 'cover'; this.Notify();
      let updated;
      try {
        updated = await this.SaveCover(cached, cached.thumbnailURL || await this.cover(entry, signal), signal);
        signal.throwIfAborted(); this.CommitRecord(updated); await this.CleanupRecord(cached, updated);
      } catch (error) { if (updated?.thumbnail && updated.thumbnail !== cached.thumbnail) await this.CleanupRecord({ file: updated.thumbnail.file }, null); if (signal.aborted) throw error; this.CoverWarning(entry, error); if (error.stopBatch || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
    this.liveEstimate?.Finished(entry); this.job.skipped++;
  }
  async Run(entries, signal) {
    let next = 0, fatal = null, fatalDetails = null; const locks = new Map();
    const stop = (error, details) => { if (!signal.aborted) { fatal = error; fatalDetails = details; this.controller.abort(error); } };
    const eligible = cached => cached && (this.job.kind === 'audio' || cached.requestedHeight === this.job.height);
    const worker = async () => {
      while (!signal.aborted && next < entries.length) {
        const entry = entries[next++], task = { title: entry.title || entry.videoId, phase: '動画情報を取得中', stage: 'metadata', bytes: 0, totalBytes: 0 };
        this.active.set(entry.url, task); this.Notify();
        try {
          const cached = this.Find(entry, this.job.kind, true); let plan = null;
          if (!eligible(cached)) {
            plan = await this.resolve(entry, this.job.kind, signal, { height: this.job.height }); signal.throwIfAborted();
            const part = ParseBilibili(entry.url).part;
            const aliases = [...new Set([entry.url, plan.url, ...(plan.aliases || [])].map(url => {
              const video = ParseBilibili(url);
              if (video.part !== part) throw new Error('保存対象とパート番号が一致しません。');
              return video.url;
            }))];
            if (aliases.length > 2) throw new Error('動画の別表記情報が正しくありません。');
            plan = { ...plan, aliases };
            this.liveEstimate?.Observe(entry, plan); this.Notify();
          }
          const urls = [...new Set([entry.url, cached?.url, ...(cached?.aliases || []), ...(plan?.aliases || [])].filter(Boolean).map(url => ParseBilibili(url).url))];
          const keyOf = LibraryMediaKey(this.libraryData()?.videoAliases);
          const keys = [...new Set(urls.flatMap(url => [url, keyOf({ type: 'bilibili', url })]).map(key => `${key}\n${this.job.kind}`))];
          const previous = keys.map(key => locks.get(key)).filter(Boolean); let unlock;
          const lock = new Promise(resolve => { unlock = resolve; });
          for (const key of keys) locks.set(key, lock);
          try {
            await Promise.all(previous); signal.throwIfAborted();
            const reused = urls.map(url => this.Find({ type: 'bilibili', url }, this.job.kind, true)).find(eligible);
            if (reused) await this.Reuse(entry, reused, signal, task);
            else {
              if (!plan) throw new Error('保存済みデータが変更されました。保存を再実行してください。');
              const free = await AvailableBytes(this.directory), bytes = PlanBytes(plan);
              if (this.liveEstimate) this.liveEstimate.freeBytes = free;
              if (free !== null && bytes !== null && free < bytes * 3.03 + (plan.thumbnailURL ? 3 * 1024 * 1024 : 0)) throw Object.assign(new Error('空き容量が不足しています。'), { code: 'ENOSPC' });
              await this.SaveEntry(entry, plan, signal, task); this.job.completed++;
            }
          } finally {
            unlock(); for (const key of keys) if (locks.get(key) === lock) locks.delete(key);
          }
          this.job.finished++;
        } catch (error) {
          if (!signal.aborted) {
            this.liveEstimate?.Failed(entry);
            this.job.failed++; this.job.finished++;
            const failure = this.Failure(entry, error, task.stage); if (this.job.failures.length < 200) this.job.failures.push(failure);
            if (error.stopBatch || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) stop(error, failure);
          }
        } finally { this.active.delete(entry.url); this.Notify(true); }
        if (!signal.aborted && next < entries.length) await delay(250, null, { signal }).catch(() => {});
      }
    };
    try {
      await this.ReconcileLayout(this.layoutData, signal); signal.throwIfAborted();
      const results = await Promise.allSettled(Array.from({ length: Math.min(this.job.concurrency, entries.length) }, () => worker().catch(error => { stop(error); throw error; })));
      fatal ||= results.find(r => r.status === 'rejected')?.reason;
      if (fatal) throw fatal; signal.throwIfAborted();
      this.job.status = this.job.failed ? 'partial' : 'completed';
    } catch (error) {
      this.job.status = this.cancelRequested ? 'cancelled' : 'failed';
      const failure = this.cancelRequested ? null : fatalDetails || this.Failure(null, error, 'layout');
      this.job.message = failure ? `[${failure.code}] ${failure.message} 記録ID: ${failure.recordId}` : '保存を中止しました。完了したファイルは残っています。';
    } finally { this.controller = null; this.layoutData = null; this.active.clear(); this.job.endedAt = Date.now(); this.Notify(true); this.liveEstimate = null; }
  }
  async SaveEntry(entry, plan, signal, task) {
    const staging = `.partial/favecus-${randomUUID()}`, directory = this.ResolvePath(staging); await fs.promises.mkdir(directory, { recursive: true }); this.ResolvePath(staging);
    let finalFile = null, coverFile = null, committed = false;
    try {
      const files = []; task.phase = 'ダウンロード中'; task.stage = 'transfer'; let offset = 0, lastNotify = 0;
      for (const [i, stream] of plan.streams.entries()) {
        const file = path.join(directory, `stream-${i}.bin`); files.push(file); let accounted = 0;
        offset += await this.transfer(this.fetch, stream, file, plan.url, signal, (bytes, total) => { task.bytes = offset + bytes; this.job.downloadedBytes += Math.max(0, bytes - accounted); accounted = Math.max(accounted, bytes); task.totalBytes = i === plan.streams.length - 1 && total ? offset + total : 0; if (Date.now() - lastNotify > 250) { lastNotify = Date.now(); this.Notify(); } });
        this.job.downloadedBytes += Math.max(0, offset - task.bytes); task.bytes = offset;
      }
      signal.throwIfAborted(); task.phase = '形式を整えて確認中'; task.stage = 'format'; this.Notify();
      const extension = plan.kind === 'video' ? 'mp4' : 'm4a', output = path.join(directory, `output.${extension}`), duration = await this.assemble(this.ffmpeg, plan, files, output, signal); signal.throwIfAborted();
      const ownerId = entry.playlistId || this.job.playlistId, ownerName = this.layoutData?.playlists.find(p => p.id === ownerId)?.name || this.job.playlistName;
      const previousMatch = this.Find(entry, plan.kind, true), recordURL = previousMatch?.url || ParseBilibili(entry.url).url;
      const token = previousMatch?.token || `${Key(recordURL, plan.kind)}.${extension}`, relative = this.TrackPath(entry, plan.kind, this.job.height, ownerId, ownerName); task.stage = 'write';
      const destination = this.ResolvePath(relative); await fs.promises.mkdir(path.dirname(destination), { recursive: true }); this.ResolvePath(relative);
      await fs.promises.copyFile(output, destination, fs.constants.COPYFILE_EXCL); finalFile = destination; signal.throwIfAborted(); const bytes = (await fs.promises.stat(finalFile)).size; if (!bytes) throw new Error('保存されたファイルが空です。');
      let record = { token, file: relative, layout: 4, playlistId: ownerId, url: recordURL, aliases: [...new Set([recordURL, ...(plan.aliases || [])])], thumbnailURL: plan.thumbnailURL || null, kind: plan.kind, bytes, duration, height: plan.height, requestedHeight: this.job.height, savedAt: new Date().toISOString() };
      if (plan.thumbnailURL) {
        task.phase = 'サムネイルを保存中'; task.stage = 'cover'; this.Notify();
        try { record = await this.SaveCover(record, plan.thumbnailURL, signal); coverFile = this.ResolvePath(record.thumbnail.file); }
        catch (error) { if (signal.aborted) throw error; this.CoverWarning(entry, error); }
      }
      signal.throwIfAborted(); const previous = this.records.get(token); this.CommitRecord(record); committed = true; await this.CleanupRecord(previous, record);
      this.liveEstimate?.Completed(entry, record.bytes, !!record.thumbnail);
    } finally {
      if (!committed) {
        if (finalFile) await fs.promises.rm(finalFile, { force: true }).catch(() => {});
        if (coverFile) await this.CleanupRecord({ file: path.relative(this.directory, coverFile).split(path.sep).join('/') }, null);
      }
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
module.exports = { OfflineLibrary, Key, SafeName };
