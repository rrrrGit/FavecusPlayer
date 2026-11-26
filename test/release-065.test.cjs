'use strict';
const { test } = require('node:test');
const { Needs } = require('./support-env.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Tree = require('../src/ui/library-tree.js');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { Folder } = require('../src/core/offline-layout.cjs');
const { DownloadStream } = require('../src/core/download-transfer.cjs');
const { DownloadDiagnostic } = require('../src/core/download-errors.cjs');
const { Brand } = require('../scripts/brand-runtime.cjs');
const { ImageData } = require('../src/core/thumbnail.cjs');
const image = fs.readFileSync(path.join(__dirname, '../build/music.png'));
const Entry = (number, playlistId = 'B') => ({ ...ParseBilibili(`av${number}`), title: `曲${number}`, playlistId });
function Temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-065-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function Data(entries = []) { return { rootPlaylistIds: ['A', 'D'], playlists: [
  { id: 'A', name: '親A', childIds: ['B'], entries: [] },
  { id: 'B', name: '子B', childIds: ['C'], entries },
  { id: 'C', name: '孫C', childIds: [], entries: [Entry(999, 'C')] },
  { id: 'D', name: '親D', childIds: [], entries: [] }
] }; }
function Manager(t, overrides = {}) {
  const root = Temp(t), directory = path.join(root, 'downloads'), snapshots = [], diagnostics = []; let resolves = 0;
  const options = { directory, settingsFile: path.join(root, 'settings.json'), ffmpeg: process.execPath, fetch: () => {},
    changed: value => snapshots.push(structuredClone(value)), diagnostic: value => diagnostics.push(value),
    resolve: async (entry, kind, _signal, { height }) => { resolves++; return { kind, height, url: entry.url, duration: 10, layout: 'dash', thumbnailURL: 'https://i0.hdslb.com/icon.png', streams: [{ urls: [], size: 3 }] }; },
    thumbnail: async () => ImageData(image), transfer: async (_fetch, _stream, file, _referer, _signal, progress) => { fs.writeFileSync(file, 'raw'); progress(3, 3); return 3; },
    assemble: async (_exe, _plan, _files, output) => { fs.writeFileSync(output, 'saved media'); return 10; }, ...overrides };
  return { root, directory, options, library: new OfflineLibrary(options), snapshots, diagnostics, resolves: () => resolves };
}
const Options = { playlistId: 'B', playlistName: '子B', kind: 'video', height: 360 };
async function Until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('operation did not reach the expected state'); }
test('065 tree rows start collapsed at roots and deep search retains the full ancestor path without changing expansion state', () => {
  const data = Data([Entry(100)]), expanded = new Set();
  assert.deepEqual(Tree.Rows(data, '*', expanded).map(r => r.playlist.id), ['A', 'D']);
  expanded.add('*/A'); assert.deepEqual(Tree.Rows(data, '*', expanded).filter(r => r.playlist).map(r => r.playlist.id), ['A', 'B', 'D']);
  const found = Tree.Rows(data, '*', expanded, '曲999');
  assert.deepEqual(found.filter(r => r.playlist).map(r => [r.playlist.id, r.depth]), [['A', 0], ['B', 1], ['C', 2]]);
  assert.equal(found.at(-1).entry.videoId, 'av999'); assert.deepEqual([...expanded], ['*/A']);
  assert.equal(Tree.Parent(data, 'C'), 'B'); assert.equal(Tree.Parent(data, 'A'), null);
});
test('065 three workers download concurrently, aggregate progress and drain before completion', async t => {
  let running = 0, peak = 0, releases = [], released = false;
  const entries = Array.from({ length: 5 }, (_, n) => Entry(200 + n));
  const h = Manager(t, { libraryData: () => Data(entries), transfer: async (_fetch, _stream, file, _url, _signal, progress) => {
    running++; peak = Math.max(peak, running); progress(1, 3);
    if (!released) await new Promise(resolve => releases.push(resolve));
    fs.writeFileSync(file, 'raw'); progress(3, 3); running--; return 3;
  } });
  h.library.Start(entries, Options); await Until(() => releases.length === 3);
  assert.equal(h.library.Snapshot().job.active.length, 3); assert.equal(h.library.Snapshot().job.bytes, 3);
  released = true; releases.forEach(resolve => resolve()); await h.library.done;
  const job = h.library.Snapshot().job;
  assert.equal(peak, 3); assert.equal(running, 0); assert.equal(job.status, 'completed'); assert.equal(job.completed, 5); assert.equal(job.downloadedBytes, 15); assert.equal(job.active.length, 0);
  assert.equal(h.library.records.size, 5); assert.ok([...h.library.records.values()].every(r => r.file.startsWith(`media/${ParseBilibili(r.url).videoId}-p1/`)));
});
test('065 cancelling waits for every worker and leaves neither saved records nor partial files', async t => {
  let running = 0;
  const h = Manager(t, { transfer: async (_fetch, _stream, _file, _url, signal) => {
    running++; try { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); }); } finally { running--; }
  } });
  h.library.Start([Entry(301), Entry(302), Entry(303), Entry(304)], Options); await Until(() => running === 3); h.library.Cancel(); await h.library.done;
  assert.equal(running, 0); assert.equal(h.library.controller, null); assert.equal(h.library.Snapshot().job.status, 'cancelled'); assert.equal(h.library.records.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, '.partial')), []); assert.equal(h.diagnostics.length, 0);
});
test('067 editing the playlist hierarchy during a running save leaves its shared destination fixed', async t => {
  const entry = Entry(350), data = Data([entry]), original = Folder(data, 'B'); let release, entered = false;
  const h = Manager(t, { libraryData: () => data, transfer: async (_fetch, _stream, file) => { entered = true; await new Promise(resolve => release = resolve); fs.writeFileSync(file, 'raw'); return 3; } });
  h.library.Start([entry], Options); await Until(() => entered); data.playlists[0].childIds = []; data.playlists[3].childIds = ['B']; release(); await h.library.done;
  const saved = [...h.library.records.values()][0].file; assert.match(saved, /^media\/av350-p1\//); assert.notEqual(Folder(data, 'B'), original);
  await h.library.Organize(); assert.equal([...h.library.records.values()][0].file, saved);
});
test('065 a rate limit stops peer workers and reports one coded fatal failure', async t => {
  let requests = 0;
  const h = Manager(t, { transfer: async () => { requests++; throw Object.assign(new Error('SECRET signed-url'), { httpStatus: 429, stopBatch: true }); } });
  h.library.Start([Entry(401), Entry(402), Entry(403), Entry(404)], Options); await h.library.done;
  assert.ok(requests <= 3); assert.equal(h.library.controller, null); const job = h.library.Snapshot().job;
  assert.equal(job.status, 'failed'); assert.equal(job.failures[0].code, 'FP-DOWNLOAD-LIMIT'); assert.match(job.message, /FP-DOWNLOAD-LIMIT/);
  assert.doesNotMatch(JSON.stringify(h.diagnostics), /SECRET|signed-url/);
});
test('065 a child saved first is reused when saving its parent or another membership, without duplicate files', async t => {
  const entry = Entry(701), data = Data([entry]), h = Manager(t, { libraryData: () => data });
  h.library.Start([entry], Options); await h.library.done; const record = [...h.library.records.values()][0]; assert.match(record.file, /^media\/av701-p1\//);
  data.playlists[3].entries = [{ ...entry, playlistId: 'D' }];
  for (const playlistId of ['A', 'D']) { h.library.Start([{ ...entry, playlistId: playlistId === 'A' ? 'B' : 'D' }], { ...Options, playlistId }); await h.library.done; assert.equal(h.library.Snapshot().job.skipped, 1); }
  assert.equal(h.resolves(), 1); assert.equal(h.library.records.size, 1); assert.equal(h.library.File(record.token).file, record.file);
});
test('065 interrupted transfers retry once, remove incomplete bytes and never include raw secrets in diagnostics', async t => {
  const file = path.join(Temp(t), 'stream.bin'), stream = { urls: ['https://a.bilivideo.com/media'], size: 4 }, signal = new AbortController().signal; let calls = 0;
  const interrupted = () => new TypeError('fetch failed SECRET https://a.bilivideo.com/?token=secret', { cause: Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }) });
  const size = await DownloadStream(async () => { if (++calls === 1) throw interrupted(); return new Response('good', { headers: { 'content-length': '4' } }); }, stream, file, '', signal, () => {}, async () => {});
  assert.equal(size, 4); assert.equal(calls, 2); assert.equal(fs.readFileSync(file, 'utf8'), 'good'); fs.rmSync(file); calls = 0;
  let failure; await assert.rejects(DownloadStream(async () => { calls++; throw interrupted(); }, stream, file, '', signal, () => {}, async () => {}), error => { failure = error; return true; });
  assert.equal(calls, 2); assert.equal(fs.existsSync(file), false); const details = DownloadDiagnostic(failure, 'transfer'); assert.equal(details.code, 'FP-DOWNLOAD-CONNECTION'); assert.equal(details.nativeCode, 'UND_ERR_SOCKET'); assert.doesNotMatch(JSON.stringify(details), /SECRET|token=|secret/);
});
test('065 runtime branding keeps the original, verifies reuse, repairs corruption and updates for a new donor', async t => {
  const root = Temp(t), directory = path.join(root, 'runtime'), stage = path.join(root, 'stage'), donor = path.join(root, 'launcher.exe'); fs.mkdirSync(directory); fs.mkdirSync(stage); fs.writeFileSync(path.join(directory, 'electron.exe'), 'original'); fs.writeFileSync(donor, 'donor'); let updates = 0;
  const options = { directory, stage, donor, update: async (target, source) => { updates++; fs.appendFileSync(target, fs.readFileSync(source)); } };
  const first = await Brand(options); assert.equal(first.reused, false); assert.equal(fs.readFileSync(path.join(directory, 'electron.exe'), 'utf8'), 'original');
  assert.equal((await Brand(options)).reused, true); assert.equal(updates, 1); fs.writeFileSync(first.executable, 'corrupt'); await Brand(options); assert.equal(updates, 2);
  fs.writeFileSync(donor, 'new donor'); await Brand(options); assert.equal(updates, 3); assert.equal(fs.readFileSync(first.executable, 'utf8'), 'originalnew donor'); assert.deepEqual(fs.readdirSync(stage), []);
});
test('065 runtime branding failure preserves the previous executable, and symlink targets are rejected', { skip: Needs.symlink }, async t => {
  const root = Temp(t), directory = path.join(root, 'runtime'), stage = path.join(root, 'stage'), donor = path.join(root, 'launcher.exe'); fs.mkdirSync(directory); fs.mkdirSync(stage); fs.writeFileSync(path.join(directory, 'electron.exe'), 'original'); fs.writeFileSync(donor, 'donor'); const executable = path.join(directory, 'FavecusPlayer.exe'); fs.writeFileSync(executable, 'previous');
  await assert.rejects(Brand({ directory, stage, donor, update: async target => { fs.appendFileSync(target, 'bad'); throw new Error('resource error'); } }), /resource error/);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'previous'); assert.deepEqual(fs.readdirSync(stage), []); fs.rmSync(executable); fs.symlinkSync(donor, executable);
  await assert.rejects(Brand({ directory, stage, donor, update: async () => assert.fail('must not update a link') }), /リンク/); assert.equal(fs.readFileSync(donor, 'utf8'), 'donor');
});
