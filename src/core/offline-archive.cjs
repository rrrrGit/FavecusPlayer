'use strict';
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Key } = require('./offline-library.cjs');
const { ParseBilibili } = require('./urls.cjs');
const { ImageData, ImageURL } = require('./thumbnail.cjs');
async function ExportDownloads(library, playlists) {
  if (!library) return { items: [], count: 0 };
  if (library.indexError) throw new Error(library.indexError);
  const records = new Map(), items = [];
  for (const entry of playlists.flatMap(p => p.entries)) if (entry.type === 'bilibili') for (const kind of ['video', 'audio']) {
    const record = library.Find(entry, kind, true); if (record) records.set(record.token, record);
  }
  const files = [];
  for (const record of records.values()) {
    const { path: local, file, thumbnail, ...data } = record, media = `downloads/media/${record.token}`;
    items.push({ name: media, file: local }); const saved = { ...data, media };
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
function DownloadMatches(record, entry) { return entry.type === 'bilibili' && [record.url, ...record.aliases].includes(ParseBilibili(entry.url).url); }
async function StageDownloads(library, zip, records, playlists, layout) {
  if (!library || !records?.length) return null;
  if (library.indexError) throw new Error(library.indexError);
  const before = new Map(library.records), next = new Map(before), copied = [], folders = new Map(); let committed = false, imported = 0;
  const index = path.join(library.directory, 'index.json'), existed = fs.existsSync(index);
  const rollback = async () => {
    if (committed) { library.CommitRecords(before); if (!existed) await fs.promises.rm(index, { force: true }); }
    for (const file of copied) await fs.promises.rm(file, { force: true }).catch(() => {});
    for (const folder of new Set(copied.map(file => path.dirname(file)))) await fs.promises.rmdir(folder).catch(() => {});
  };
  try {
    for (const record of records) {
      let target, entry;
      for (const playlist of playlists) { const match = playlist.entries.find(e => DownloadMatches(record, e)); if (match) { target = playlist; entry = match; break; } }
      if (!target || library.File(record.token)) continue;
      let relative = library.TrackPath(entry, record.kind, record.requestedHeight, target.id, target.name, layout);
      const key = ParseBilibili(entry.url).url;
      if (folders.has(key)) relative = `${folders.get(key)}/${path.posix.basename(relative)}`; else folders.set(key, path.posix.dirname(relative));
      const destination = library.ResolvePath(relative); await fs.promises.mkdir(path.dirname(destination), { recursive: true }); library.ResolvePath(relative);
      copied.push(destination); await zip.Content(record.media, destination, Number.MAX_SAFE_INTEGER);
      const { media, cover, ...data } = record, saved = { ...data, file: relative, layout: layout ? 3 : 2, playlistId: target.id, savedAt: new Date().toISOString() };
      if (cover) {
        const bytes = await zip.Content(cover.file, null, 3 * 1024 * 1024); ImageData(bytes);
        const coverName = `${path.posix.dirname(relative)}/thumbnail-${randomUUID().slice(0, 8)}${path.extname(cover.file)}`, file = library.ResolvePath(coverName);
        await fs.promises.writeFile(file, bytes, { flag: 'wx' }); copied.push(file); saved.thumbnail = { file: coverName, bytes: bytes.length };
      }
      next.set(saved.token, saved); imported++;
    }
    return { imported, commit: () => { library.CommitRecords(next); committed = true; }, rollback };
  } catch (error) { await rollback(); throw error; }
}
module.exports = { ExportDownloads, ReadDownloads, StageDownloads, DownloadMatches };
