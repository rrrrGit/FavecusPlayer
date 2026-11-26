'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual: Same } = require('node:util');
const Journal = '.layout-migration.json';
const Saved = record => record && JSON.parse(JSON.stringify({ ...record, aliases: record.aliases || [] }));
const RecordSame = (a, b) => Same(Saved(a), Saved(b));
function Write(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}
function SafeFile(library, name) {
  const file = library.ResolvePath(name);
  let current = library.directory;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('移行対象にシンボリックリンクがあります。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
function CheckIndex(library) {
  const raw = fs.readFileSync(SafeFile(library, 'index.json'), 'utf8');
  if (raw !== library.indexBytes) throw new Error('保存一覧が並行変更されました。移行元を保持しています。');
  const data = JSON.parse(raw);
  if (data.version !== 1 || !Array.isArray(data.files) || data.files.length !== library.records.size || new Set(data.files.map(r => r?.token)).size !== library.records.size || data.files.some(r => !RecordSame(r, library.records.get(r?.token)))) throw new Error('保存された一覧が並行変更されました。移行元を保持しています。');
}
async function Digest(library, name, signal) {
  const file = SafeFile(library, name), stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('移行対象が通常のファイルではありません。');
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file, { signal })) { signal?.throwIfAborted(); hash.update(bytes); }
  return { bytes: stat.size, hash: hash.digest('hex') };
}
async function Matches(library, item, name, signal) {
  try { const value = await Digest(library, name, signal); return value.bytes === item.bytes && value.hash === item.hash; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function Validate(library, plan) {
  if (plan?.version !== 1 || !['copying', 'committed'].includes(plan.phase) || !/^index\.pre-0\.6\.7-[a-f0-9-]{36}\.json$/.test(plan.backup || '') || !Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > 2) throw new Error('移行記録の形式を確認できません。記録と元データを保持しています。');
  const { source, updated } = plan;
  if (!source || !updated || source.token !== updated.token || updated.layout !== 4 || source.url !== updated.url || source.kind !== updated.kind || source.bytes !== updated.bytes) throw new Error('移行記録の参照が正しくありません。');
  const backup = JSON.parse(fs.readFileSync(SafeFile(library, plan.backup), 'utf8'));
  const original = backup.version === 1 && Array.isArray(backup.files) && backup.files.find(r => r.token === source.token);
  if (!original || ['file', 'url', 'kind', 'bytes', 'thumbnail'].some(key => !Same(original[key], source[key]))) throw new Error('移行元のバックアップと記録が一致しません。');
  if (!Array.isArray(plan.retired) || plan.retired.length < 1 || plan.retired.length > 2) throw new Error('移行元の整理記録が正しくありません。');
  for (const item of plan.retired) {
    if (![source.file, source.thumbnail?.file].includes(item.from) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.hash || '')) throw new Error('移行元の整理対象が正しくありません。');
    SafeFile(library, item.from);
  }
  for (const item of plan.files) {
    if (!['media', 'cover'].includes(item.role) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.hash || '')) throw new Error('移行ファイルの記録が正しくありません。');
    const from = item.role === 'media' ? source.file : source.thumbnail?.file, to = item.role === 'media' ? updated.file : updated.thumbnail?.file;
    if (item.from !== from || item.to !== to || !/^media\/(av[1-9]\d*|BV[0-9A-Za-z]{10})-p[1-9]\d*\/(video|audio|thumbnail)-[a-f0-9-]{36}\.(mp4|m4a|png|jpeg|jpg|webp)$/.test(item.to)) throw new Error('移行先の記録が正しくありません。');
    SafeFile(library, item.from); SafeFile(library, item.to);
  }
  if (plan.cover && (plan.cover.file !== updated.thumbnail?.file || !Number.isSafeInteger(plan.cover.bytes) || plan.cover.bytes <= 0 || !/^[a-f0-9]{64}$/.test(plan.cover.hash || ''))) throw new Error('共用サムネイルの移行記録が正しくありません。');
  if (plan.files.filter(item => item.role === 'media').length !== 1 || plan.files.filter(item => item.role === 'cover').length > 1) throw new Error('移行対象が重複しています。');
  SafeFile(library, updated.file); if (updated.thumbnail) SafeFile(library, updated.thumbnail.file);
}
async function Finish(library, plan, signal) {
  Validate(library, plan);
  const save = () => Write(SafeFile(library, Journal), plan);
  if (plan.phase === 'copying') {
    const current = library.records.get(plan.source.token);
    if (!RecordSame(current, plan.updated)) {
      if (!RecordSame(current, plan.source)) throw new Error('移行中に保存一覧が変更されました。元データと移行記録を保持しています。');
      for (const item of plan.files) {
        signal?.throwIfAborted();
        if (!await Matches(library, item, item.to, signal)) {
          if (!await Matches(library, item, item.from, signal)) throw new Error('移行元の内容が変わったため整理を中止しました。');
          if (fs.existsSync(SafeFile(library, item.to))) {
            // 中断したコピーか外部ファイルかを断定できない実体は上書きしません。
            item.to = `${path.posix.dirname(item.to)}/${item.role === 'cover' ? 'thumbnail' : plan.source.kind}-${randomUUID()}${path.posix.extname(item.to)}`;
            if (item.role === 'media') plan.updated.file = item.to; else plan.updated.thumbnail.file = item.to;
            save();
          }
          const destination = SafeFile(library, item.to);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true }); SafeFile(library, item.to);
          await fs.promises.copyFile(SafeFile(library, item.from), destination, fs.constants.COPYFILE_EXCL);
          if (!await Matches(library, item, item.to, signal)) throw new Error('移行先の内容が元データと一致しません。');
        }
      }
      if (plan.cover && !await Matches(library, plan.cover, plan.cover.file, signal)) throw new Error('共用サムネイルを確認できないため元データを保持しています。');
      signal?.throwIfAborted();
      if (!RecordSame(library.records.get(plan.source.token), plan.source)) throw new Error('移行中に保存一覧が変更されました。');
      CheckIndex(library);
      library.CommitRecord(plan.updated);
    }
    plan.phase = 'committed'; save();
  }
  if (RecordSame(library.records.get(plan.source.token), plan.updated)) {
    for (const item of plan.files) if (!await Matches(library, item, item.to, signal)) throw new Error('確定した移行先を確認できないため旧データを保持しています。');
    if (plan.cover && !await Matches(library, plan.cover, plan.cover.file, signal)) throw new Error('共用サムネイルを確認できないため旧データを保持しています。');
  } else if (!library.File(plan.source.token)) throw new Error('現在の保存先を確認できないため旧データを保持しています。');
  if (library.cleanup?.enabled) {
    let pending = library.cleanup.Retire(library.cleanupRecords, plan.source);
    const changed = new Set();
    for (const item of plan.retired) {
      signal?.throwIfAborted();
      if (fs.existsSync(SafeFile(library, item.from)) && !await Matches(library, item, item.from, signal)) changed.add(item.from);
    }
    if (changed.size) pending = pending.map(item => item.record.token === plan.source.token && item.record.file === plan.source.file ? { ...item, files: item.files.map(value => changed.has(value.file) ? { file: value.file, blocked: true } : value) } : item);
    CheckIndex(library);
    if (pending !== library.cleanupRecords) library.CommitRecords(library.records, { cleanup: pending });
    await fs.promises.unlink(SafeFile(library, Journal)); return;
  }
  for (const item of plan.retired) {
    signal?.throwIfAborted();
    if ([...library.records.values()].some(r => r.file === item.from || r.thumbnail?.file === item.from)) continue;
    const old = SafeFile(library, item.from);
    if (!fs.existsSync(old)) continue;
    if (!await Matches(library, item, item.from, signal)) { library.warning = '移行後に内容が変わった旧ファイルは保持しています。'; continue; }
    CheckIndex(library);
    await fs.promises.unlink(old);
    let directory = path.dirname(old);
    while (directory !== library.directory) { try { await fs.promises.rmdir(directory); } catch { break; } directory = path.dirname(directory); }
  }
  await fs.promises.unlink(SafeFile(library, Journal));
}
async function MigrateShared(library, data, signal) {
  const journal = SafeFile(library, Journal);
  if (fs.existsSync(journal)) await Finish(library, JSON.parse(fs.readFileSync(journal, 'utf8')), signal);
  let backup;
  for (const source of [...library.records.values()]) {
    signal?.throwIfAborted();
    if (source.layout === 4 || !library.File(source.token)) continue;
    if (source.layout !== undefined && ![1, 2, 3].includes(source.layout)) throw new Error('未知の保存配置は移行せず保持しています。');
    CheckIndex(library);
    if (!backup) {
      backup = `index.pre-0.6.7-${randomUUID()}.json`;
      fs.copyFileSync(SafeFile(library, 'index.json'), SafeFile(library, backup), fs.constants.COPYFILE_EXCL);
    }
    const relative = library.TrackPath({ type: 'bilibili', url: source.url }, source.kind, source.height, source.playlistId, '', data);
    const updated = { ...source, file: relative.replace(/video-\d+p-/, 'video-'), layout: 4 };
    const files = [{ role: 'media', from: source.file, to: updated.file, ...await Digest(library, source.file, signal) }];
    if (files[0].bytes !== source.bytes) throw new Error('移行元のサイズが保存一覧と一致しません。');
    const retired = [{ from: source.file, bytes: files[0].bytes, hash: files[0].hash }]; let cover;
    if (source.thumbnail) {
      const folder = path.posix.dirname(updated.file);
      const shared = [...library.records.values()].find(r => r.layout === 4 && path.posix.dirname(r.file) === folder && library.Cover(r.token));
      if (library.Cover(source.token)) {
        retired.push({ from: source.thumbnail.file, ...await Digest(library, source.thumbnail.file, signal) });
      }
      if (shared) { updated.thumbnail = { ...shared.thumbnail }; cover = { file: shared.thumbnail.file, ...await Digest(library, shared.thumbnail.file, signal) }; }
      else if (library.Cover(source.token)) {
        const to = `${folder}/thumbnail-${randomUUID()}${path.posix.extname(source.thumbnail.file)}`;
        updated.thumbnail = { ...source.thumbnail, file: to };
        files.push({ role: 'cover', from: source.thumbnail.file, to, ...await Digest(library, source.thumbnail.file, signal) });
      }
    }
    const plan = { version: 1, phase: 'copying', backup, source, updated, files, retired, ...(cover ? { cover } : {}) };
    Validate(library, plan); Write(journal, plan); await Finish(library, plan, signal);
  }
}
module.exports = { MigrateShared };
