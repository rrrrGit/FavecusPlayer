'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Key } = require('./offline-library.cjs');
const { ParseBilibili } = require('./urls.cjs');
const { ImageData, ImageURL } = require('./thumbnail.cjs');
const { LibraryMediaKey } = require('./library-identity.cjs');
const { isDeepStrictEqual } = require('node:util');
const { SharedFolder, TrackFile } = require('./offline-layout.cjs');
async function ExportDownloads(library, playlists) {
  if (!library) return { items: [], count: 0 };
  if (library.indexError) throw new Error(library.indexError);
  const records = new Map(), items = [];
  for (const entry of playlists.flatMap(p => p.entries)) if (entry.type === 'bilibili') for (const kind of ['video', 'audio']) {
    const record = library.Find(entry, kind, true);
    if (record) records.set(record.token, { ...record, aliases: [...new Set([record.url, ParseBilibili(entry.url).url, ...(records.get(record.token)?.aliases || []), ...(record.aliases || [])])] });
  }
  const files = [];
  for (const record of records.values()) {
    const { path: local, thumbnail } = record, media = `downloads/media/${record.token}`;
    const url = ParseBilibili(record.url).url;
    const aliases = [...new Set([url, ...(record.aliases || [])].map(value => ParseBilibili(value)).filter(v => v.part === ParseBilibili(url).part).map(v => v.url))].slice(0, 2);
    items.push({ name: media, file: local });
    const saved = { token: record.token, url, aliases, media, kind: record.kind, bytes: record.bytes, duration: Number.isFinite(record.duration) && record.duration > 0 ? Math.min(record.duration, 604800) : 0,
      height: [360, 480, 720, 1080].includes(record.height) ? record.height : null, requestedHeight: [360, 720, 1080].includes(record.requestedHeight) ? record.requestedHeight : 720 };
    if (thumbnail && library.Cover(record.token)) {
      const cover = `downloads/covers/${record.token}${path.extname(thumbnail.file)}`;
      items.push({ name: cover, file: library.ResolvePath(thumbnail.file) }); saved.cover = { file: cover, bytes: thumbnail.bytes };
    }
    files.push(saved);
  }
  items.push({ name: 'downloads/catalog.json', data: Buffer.from(JSON.stringify({ version: 1, files })) });
  return { items, count: files.length };
}
async function ReadDownloads(zip) {
  if (!zip?.entries.has('downloads/catalog.json')) return [];
  const data = JSON.parse((await zip.Content('downloads/catalog.json', null, 32 * 1024 * 1024)).toString('utf8'));
  if (data.version !== 1 || !Array.isArray(data.files) || data.files.length > 20000) throw new Error('保存済みデータの一覧が正しくありません。');
  const seen = new Set();
  return data.files.map(r => {
    if (!r || !['video', 'audio'].includes(r.kind)) throw new Error('保存形式が正しくありません。');
    const url = ParseBilibili(r.url).url, token = `${Key(url, r.kind)}.${r.kind === 'video' ? 'mp4' : 'm4a'}`, media = `downloads/media/${token}`;
    if (r.token !== token || seen.has(token) || r.media !== media || !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || zip.entries.get(media)?.bytes !== r.bytes) throw new Error('保存済みデータの参照が正しくありません。');
    seen.add(token);
    const aliases = Array.isArray(r.aliases) ? r.aliases.slice(0, 2).map(value => ParseBilibili(value)).filter(v => v.part === ParseBilibili(url).part).map(v => v.url) : [];
    let cover = null;
    if (r.cover) {
      if (!['png', 'jpeg', 'jpg', 'webp'].some(ext => r.cover.file === `downloads/covers/${token}.${ext}`) || !Number.isSafeInteger(r.cover.bytes) || r.cover.bytes <= 0 || r.cover.bytes > 3 * 1024 * 1024 || zip.entries.get(r.cover.file)?.bytes !== r.cover.bytes) throw new Error('保存済みサムネイルの参照が正しくありません。');
      cover = { file: r.cover.file, bytes: r.cover.bytes };
    }
    let thumbnailURL = null; try { thumbnailURL = ImageURL(r.thumbnailURL); } catch {}
    return { token, url, aliases, media, cover, kind: r.kind, bytes: r.bytes, duration: Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0,
      height: [360, 480, 720, 1080].includes(r.height) ? r.height : null, requestedHeight: [360, 720, 1080].includes(r.requestedHeight) ? r.requestedHeight : 720, thumbnailURL };
  });
}
function DownloadMatches(record, entry, keyOf) { return entry.type === 'bilibili' && ([record.url, ...(record.aliases || [])].includes(ParseBilibili(entry.url).url) || keyOf && keyOf({ type: 'bilibili', url: record.url }) === keyOf(entry)); }
async function StageDownloads(library, zip, records, playlists, layout) {
  if (!library || !records?.length) return null;
  if (library.indexError) throw new Error(library.indexError);
  const before = new Map(library.records), next = new Map(before), copied = [], folders = new Map(), covers = new Map(), processed = new Set(); let committed = false, uncertain = false, imported = 0, staging;
  const keyOf = LibraryMediaKey(layout?.videoAliases), index = path.join(library.directory, 'index.json'), existed = fs.existsSync(index);
  const indexBefore = existed ? fs.readFileSync(index) : null, stamp = JSON.stringify([...library.records]);
  const unchanged = () => JSON.stringify([...library.records]) === stamp && (existed ? fs.existsSync(index) && fs.readFileSync(index).equals(indexBefore) : !fs.existsSync(index));
  const matchesIndex = values => { try { return isDeepStrictEqual(JSON.parse(fs.readFileSync(index, 'utf8')), JSON.parse(JSON.stringify({ version: 1, files: [...values.values()] }))); } catch { return false; } };
  const byURL = new Map(), byKey = new Map(); let order = 0;
  const available = new Set();
  for (const record of before.values()) if (library.File(record.token)) {
    for (const url of [record.url, ...(record.aliases || [])]) {
      const key = keyOf({ type: 'bilibili', url }); available.add(`${key}\n${record.kind}`);
      if (record.layout === 4 && !folders.has(key)) folders.set(key, path.posix.dirname(record.file));
    }
    const folder = path.posix.dirname(record.file);
    if (!covers.has(folder) && library.Cover(record.token)) covers.set(folder, record.thumbnail);
  }
  for (const target of playlists) for (const entry of target.entries) if (entry.type === 'bilibili') {
    const url = ParseBilibili(entry.url).url, key = keyOf(entry), value = { target, entry, key, order: order++ };
    if (!byURL.has(url)) byURL.set(url, value); if (!byKey.has(key)) byKey.set(key, value);
  }
  const publish = async (from, relative) => {
    const destination = library.ResolvePath(relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true }); library.ResolvePath(relative);
    try { await fs.promises.link(from, destination); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EACCES', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error;
      await fs.promises.copyFile(from, destination, fs.constants.COPYFILE_EXCL);
    }
    copied.push(destination); return destination;
  };
  const rollback = async () => {
    if (uncertain || committed && (!matchesIndex(next) || JSON.stringify([...library.records]) !== JSON.stringify([...next]))) throw new Error('保存一覧の確定状態を確認できないため、追加メディアを保持しています。');
    if (committed) { library.CommitRecords(before); if (!existed) await fs.promises.rm(index, { force: true }); }
    const used = new Set([...library.records.values()].flatMap(r => [r.file, r.thumbnail?.file]));
    for (const file of copied) if (!used.has(path.relative(library.directory, file).split(path.sep).join('/'))) await fs.promises.rm(file, { force: true }).catch(() => {});
    for (const folder of new Set(copied.map(file => path.dirname(file)))) await fs.promises.rmdir(folder).catch(() => {});
  };
  try {
    for (const record of records) {
      const candidates = new Set([...[record.url, ...(record.aliases || [])].map(url => byURL.get(url)), byKey.get(keyOf({ type: 'bilibili', url: record.url }))].filter(Boolean));
      for (const { target, entry, key } of [...candidates].sort((a, b) => a.order - b.order)) {
        const identity = `${key}\n${record.kind}`;
        if (processed.has(identity)) continue;
        processed.add(identity);
        if (available.has(identity)) continue;
        const canonicalURL = key.slice('bilibili:'.length);
        const token = `${Key(entry.url, record.kind)}.${record.kind === 'video' ? 'mp4' : 'm4a'}`;
        const folder = folders.get(key) || SharedFolder(entry, layout), relative = `${folder}/${TrackFile(record.kind, record.requestedHeight)}`; folders.set(key, folder);
        await fs.promises.mkdir(library.directory, { recursive: true });
        staging ||= await fs.promises.mkdtemp(path.join(library.directory, '.import-'));
        library.ResolvePath(path.relative(library.directory, staging).split(path.sep).join('/'));
        const staged = path.join(staging, `${randomUUID()}.media`); await zip.Content(record.media, staged, Number.MAX_SAFE_INTEGER); await publish(staged, relative);
        const { media, cover, ...data } = record, saved = { ...data, token, url: ParseBilibili(entry.url).url, aliases: [...new Set([ParseBilibili(entry.url).url, canonicalURL])], file: relative, layout: 4, playlistId: target.id, savedAt: new Date().toISOString() };
        if (covers.has(folder)) saved.thumbnail = covers.get(folder);
        else if (cover) {
          const bytes = await zip.Content(cover.file, null, 3 * 1024 * 1024); ImageData(bytes);
          const name = `${folder}/thumbnail-${randomUUID()}${path.extname(cover.file)}`, stagedCover = path.join(staging, `${randomUUID()}.cover`);
          await fs.promises.writeFile(stagedCover, bytes, { flag: 'wx' }); await publish(stagedCover, name);
          saved.thumbnail = { file: name, bytes: bytes.length }; covers.set(folder, saved.thumbnail);
        }
        next.set(saved.token, saved); imported++;
      }
    }
    if (!imported) return null;
    return { imported, commit: () => {
      if (!unchanged()) throw new Error('取り込み中に保存一覧が変更されました。');
      try { library.CommitRecords(next); committed = true; }
      catch (error) {
        if (matchesIndex(next)) { committed = true; library.records = new Map(next); }
        else if (!unchanged()) uncertain = true;
        throw error;
      }
    }, rollback };
  } catch (error) { await rollback(); throw error; }
  finally { if (staging) await fs.promises.rm(staging, { recursive: true, force: true }); }
}
module.exports = { ExportDownloads, ReadDownloads, StageDownloads, DownloadMatches };
