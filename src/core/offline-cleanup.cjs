'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { LibraryMediaKey } = require('./library-identity.cjs');
function ReferenceKeys(data) {
  if (data?.version !== 3 || ![undefined, 1, 2].includes(data.identityVersion) || !Array.isArray(data.playlists) || !data.playlists.length) return null;
  const keyOf = LibraryMediaKey(data.videoAliases), keys = new Set();
  for (const p of data.playlists) {
    if (!Array.isArray(p.entries)) throw new Error('参照元の一覧が正しくありません。');
    for (const entry of p.entries) {
      if (!['bilibili', 'local'].includes(entry?.type)) throw new Error('参照元の種類が正しくありません。');
      if (entry.type === 'bilibili') keys.add(keyOf(entry));
    }
  }
  return { keyOf, keys };
}
function Referenced(record, references) {
  return references && [record.url, ...(record.aliases || [])].some(url => references.keys.has(references.keyOf({ type: 'bilibili', url })));
}
function SafeFile(library, name) {
  const file = library.ResolvePath(name); let current = library.directory;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('整理対象にシンボリックリンクがあります。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
function Stamp(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return { blocked: true };
    return { bytes: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs) };
  } catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
}
function ValidateCleanup(library, input) {
  if (!Array.isArray(input) || input.length > 40000) throw new Error('削除待ち一覧の形式が正しくありません。');
  for (const item of input) {
    if (!item || !['unused', 'replaced'].includes(item.reason) || !Array.isArray(item.files) || item.files.length < 1 || item.files.length > 2) throw new Error('削除待ち記録が正しくありません。');
    library.ValidateRecord(item.record);
    const names = new Set();
    for (const value of item.files) {
      if (!value || ![item.record.file, item.record.thumbnail?.file].includes(value.file) || names.has(value.file)) throw new Error('削除待ちの参照先が正しくありません。');
      names.add(value.file); library.ResolvePath(value.file);
      if (value.missing === true || value.blocked === true) continue;
      if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !['dev', 'ino', 'modified', 'changed'].every(key => typeof value[key] === 'string' && /^-?\d+$/.test(value[key]))) throw new Error('削除待ちファイルの識別情報が正しくありません。');
    }
  }
  return input;
}
class OfflineCleanup {
  constructor(library, referenceData) { this.library = library; this.referenceData = referenceData; this.enabled = typeof referenceData === 'function'; this.leases = new Map(); this.waiting = new Set(); }
  Retire(pending, record, reason = 'replaced') {
    if (pending.some(p => p.record.token === record.token && p.record.file === record.file && p.record.thumbnail?.file === record.thumbnail?.file)) return pending;
    const { path: _path, ...saved } = record, files = [];
    for (const [name, bytes] of [[saved.file, saved.bytes], [saved.thumbnail?.file, saved.thumbnail?.bytes]]) if (typeof name === 'string' && !files.some(f => f.file === name)) {
      try {
        const stamp = Stamp(SafeFile(this.library, name));
        files.push({ file: name, ...(!stamp.missing && (stamp.blocked || stamp.bytes !== bytes) ? { blocked: true } : stamp) });
      } catch { this.library.ResolvePath(name); files.push({ file: name, blocked: true }); }
    }
    const next = [...pending, { reason, record: saved, files }]; ValidateCleanup(this.library, next); return next;
  }
  Pin(record) {
    const paths = [record.file, record.thumbnail?.file].filter(Boolean).map(name => this.library.ResolvePath(name));
    for (const file of paths) this.leases.set(file, (this.leases.get(file) || 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; for (const file of paths) { const count = this.leases.get(file) - 1; if (count) this.leases.set(file, count); else this.leases.delete(file); } this.Request(); };
  }
  References() {
    const data = this.referenceData();
    if (data !== this.referenceSnapshot) { this.referenceSnapshot = data; this.references = ReferenceKeys(data); }
    return this.references || null;
  }
  Held(record) { return [record.file, record.thumbnail?.file].filter(Boolean).some(name => this.leases.has(this.library.ResolvePath(name))); }
  Request(continuing = false) {
    if (!this.enabled || this.disposed) return;
    if (!continuing) { this.waiting.clear(); this.retryNeeded = false; }
    if (this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; this.Flush(true); });
  }
  Retry() { if (!this.retry && !this.disposed) { this.retry = setTimeout(() => { this.retry = null; this.Request(); }, 30000); this.retry.unref?.(); } }
  Flush(continuing = false) {
    if (!continuing) { this.waiting.clear(); this.retryNeeded = false; }
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = null; }
    const library = this.library;
    if (!this.enabled || this.disposed || this.running || library.indexError || library.controller || library.importing || library.migrationDone) return;
    const previousRecords = library.records, previousPending = library.cleanupRecords, previousWarning = this.warning;
    this.running = true; let more = false, retry = false;
    try {
      if (fs.existsSync(library.ResolvePath('.layout-migration.json'))) return;
      const references = this.References();
      if (!references) { this.warning = '保存確定済みの参照情報を確認できないため整理を保留しています。'; return; }
      const index = library.ResolvePath('index.json');
      if (library.indexBytes === null ? fs.existsSync(index) : !fs.existsSync(index) || fs.readFileSync(index, 'utf8') !== library.indexBytes) throw new Error('保存一覧の先行変更を検出しました。');
      this.warning = '';
      const records = new Map(library.records); let pending = library.cleanupRecords, planned = 0;
      for (const record of records.values()) {
        if (pending.length >= 40000) break;
        if (Referenced(record, references) || this.Held(record)) continue;
        pending = this.Retire(pending, record, 'unused'); records.delete(record.token);
        if (++planned >= 100) { more = true; break; }
      }
      if (planned) library.CommitRecords(records, { cleanup: pending });
      let pathsFor, used, replacementRecords, replacementReferences, replacements; const completed = new Set();
      for (const item of library.cleanupRecords.filter(item => !this.waiting.has(item)).slice(0, 100)) {
        const currentReferences = this.References(); if (!currentReferences) break;
        if (this.Held(item.record)) { this.waiting.add(item); continue; }
        const referenced = Referenced(item.record, currentReferences);
        if (referenced && (replacementRecords !== library.records || replacementReferences !== currentReferences)) {
          replacementRecords = library.records; replacementReferences = currentReferences; replacements = new Set();
          for (const record of library.records.values()) if (library.File(record.token)) for (const url of [record.url, ...(record.aliases || [])]) replacements.add(`${currentReferences.keyOf({ type: 'bilibili', url })}\n${record.kind}`);
        }
        if (referenced && !replacements.has(`${currentReferences.keyOf({ type: 'bilibili', url: item.record.url })}\n${item.record.kind}`)) {
          const file = SafeFile(library, item.record.file), stat = Stamp(file);
          const saved = item.files.find(value => value.file === item.record.file);
          if (!stat.missing && !stat.blocked && saved && !saved.missing && !saved.blocked && ['bytes', 'dev', 'ino', 'modified', 'changed'].every(key => stat[key] === saved[key])) {
            const restored = new Map(library.records); restored.set(item.record.token, item.record);
            library.CommitRecords(restored, { cleanup: library.cleanupRecords.filter(p => p !== item && !completed.has(p)) }); completed.clear(); continue;
          }
          this.waiting.add(item); continue;
        }
        let complete = true;
        if (pathsFor !== library.records) { pathsFor = library.records; used = new Set([...library.records.values()].flatMap(r => [r.file, r.thumbnail?.file])); }
        for (const value of item.files) {
          if (used.has(value.file)) continue;
          try {
            const file = SafeFile(library, value.file), actual = Stamp(file);
            if (actual.missing) continue;
            if (value.missing || value.blocked || actual.blocked || ['bytes', 'dev', 'ino', 'modified', 'changed'].some(key => actual[key] !== value[key])) { complete = false; this.warning = '内容や所有状態が変わった整理対象は保持しています。'; continue; }
            fs.unlinkSync(file);
            let folder = path.dirname(file);
            while (folder !== library.directory) { try { fs.rmdirSync(folder); } catch { break; } folder = path.dirname(folder); }
          } catch (error) { complete = false; retry ||= ['EBUSY', 'EACCES', 'EPERM'].includes(error.code); this.warning = '使用中または確認できない保存データの整理を保留しています。'; }
        }
        if (complete) completed.add(item); else this.waiting.add(item);
      }
      if (completed.size) library.CommitRecords(library.records, { cleanup: library.cleanupRecords.filter(p => !completed.has(p)) });
      more ||= library.cleanupRecords.some(item => !this.waiting.has(item));
    } catch (error) { this.warning = '保存データの整理を完了できませんでした。元データと既存の削除待ち記録を保持しています。'; more = false; retry = true; }
    finally {
      this.running = false; this.retryNeeded ||= retry; if (more) this.Request(true); else if (this.retryNeeded) this.Retry();
      if (!this.disposed && (previousRecords !== library.records || previousPending !== library.cleanupRecords || previousWarning !== this.warning)) { try { library.Notify(true); } catch {} }
    }
  }
  Dispose() { this.disposed = true; clearImmediate(this.scheduled); clearTimeout(this.retry); }
}
module.exports = { OfflineCleanup, ValidateCleanup, ReferenceKeys, Referenced };
