'use strict';
// v0.7.0 Step4：同期用メディアキー（SyncMediaKey）とDeviceMediaの投影。保存形式は変更せず、読み取り専用であることを確認する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { OfflineLibrary, Key } = require('../src/core/offline-library.cjs');
const { LibrarySyncKey, LibrarySyncKeyForms, AuditIds, SYNC_KEY } = require('../src/core/library-identity.cjs');
const { DeviceMediaList, RestoredState, DEVICE_MEDIA_STATES } = require('../src/core/device-media.cjs');
const { ShareData } = require('../src/core/library-share.cjs');
const { MODULES } = require('../scripts/build-shared-bundle.cjs');

const BV = 'BV1xx411c7mD', ALIAS = [{ aid: '170001', bvid: BV }];
const url = (id, part = 1) => `https://www.bilibili.com/video/${id}/${part > 1 ? `?p=${part}` : ''}`;
function Setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(path.join(dir, 'data')) };
}
function Offline(dir, videoAliases = []) {
  return new OfflineLibrary({ directory: path.join(dir, 'downloads'), settingsFile: path.join(dir, 'download-settings.json'), ffmpeg: process.execPath, libraryData: () => ({ videoAliases }), fetch: () => assert.fail('no network') });
}
function Seed(offline, entryURL, kind = 'video', height = 720) {
  const video = require('../src/core/urls.cjs').ParseBilibili(entryURL), file = `media/${video.videoId}-p${video.part}/${kind}-${randomUUID()}.${kind === 'video' ? 'mp4' : 'm4a'}`;
  const token = Key(video.url, kind) + (kind === 'video' ? '.mp4' : '.m4a');
  fs.mkdirSync(path.dirname(offline.ResolvePath(file)), { recursive: true }); fs.writeFileSync(offline.ResolvePath(file), 'saved');
  offline.CommitRecord({ token, file, kind, layout: 4, aliases: [video.url], url: video.url, bytes: 5, height });
  return { token, file };
}
const Keys = value => Object.keys(value).flatMap(key => [key, ...(value[key] && typeof value[key] === 'object' ? Keys(value[key]) : [])]);

test('sync keys depend only on the video and part, never on titles, ids, lists or file names', () => {
  const key = LibrarySyncKey(ALIAS);
  const base = key({ type: 'bilibili', url: url(BV, 2) });
  assert.equal(base, `bili:${BV}:p2`); assert.match(base, SYNC_KEY);
  for (const extra of [{ title: '別の曲名' }, { id: randomUUID(), mediaId: randomUUID() }, { playlistId: randomUUID() }, { fileName: 'ignored.mp3' }, { addedAt: '2026-01-01T00:00:00.000Z' }]) {
    assert.equal(key({ type: 'bilibili', url: url(BV, 2), ...extra }), base);
  }
  assert.equal(key({ type: 'bilibili', url: url('av170001', 2) }), base, '確認済みの対応があればavもBVのキーになる');
  assert.equal(LibrarySyncKey([])({ type: 'bilibili', url: url('av170001', 2) }), 'bili-av:170001:p2');
  assert.equal(key({ type: 'bilibili', url: url(BV, 3) }) === base, false, 'パートが違えば別のキー');
  assert.equal(key({ type: 'local', fileName: `${randomUUID()}.mp3` }), null, 'ローカル曲は端末をまたぐキーを持たない');
  assert.deepEqual(LibrarySyncKeyForms(ALIAS)({ type: 'bilibili', url: url('av170001', 2) }), [base, 'bili-av:170001:p2']);
  assert.deepEqual(LibrarySyncKeyForms([])({ type: 'bilibili', url: url('av555') }), ['bili-av:555:p1']);
  assert.throws(() => LibrarySyncKey([{ aid: '1', bvid: BV }, { aid: '2', bvid: BV }]), /矛盾/);
});

test('stored videoId/part are used only when they match the canonical URL, otherwise the URL wins', () => {
  const key = LibrarySyncKey([]), other = 'BV17x411w7KC';
  assert.equal(key({ type: 'bilibili', videoId: BV, part: 5, url: url(BV, 5) }), `bili:${BV}:p5`);
  assert.equal(key({ type: 'bilibili', videoId: BV, part: 5, url: url(other, 2) }), `bili:${other}:p2`, '食い違えばURLを正とする');
  assert.throws(() => key({ type: 'bilibili', videoId: BV, part: 2, url: 'https://evil.example/ignored' }), /通常URL/, 'URLが不正なら保存値があっても拒否');
  assert.equal(key({ type: 'bilibili', videoId: 'bad', part: 0, url: url(BV, 2) }), `bili:${BV}:p2`);
  assert.equal(key({ type: 'bilibili', videoId: BV, part: '2', url: url(BV, 2) }), `bili:${BV}:p2`);
});

test('DeviceMediaList and AuditIds tolerate malformed input without throwing, and treat availability errors as not downloaded', () => {
  assert.deepEqual(DeviceMediaList({ records: null, videoAliases: null }), { items: [], skipped: 0 });
  const record = { url: url(BV), kind: 'video', height: 720, bytes: 1 };
  assert.equal(DeviceMediaList({ records: [record], isAvailable: () => { throw new Error('io'); } }).items[0].state, 'NotDownloaded');
  assert.equal(DeviceMediaList({ records: [record], isAvailable: () => 'yes' }).items[0].state, 'NotDownloaded', 'trueそのもの以外は完成扱いにしない');
  assert.deepEqual(AuditIds([null, { id: 'x', entries: [null, { id: 5 }] }]), { lists: 2, entries: 2, media: 0, total: 4 });
});

test('sync keys are stable across restart and match for stored validated entries without reparsing', t => {
  const h = Setup(t), root = h.store.data.playlists[0].id;
  h.store.Apply({ type: 'add', playlistId: root, urls: `${url('av123', 2)}\n${url(BV)}` });
  const key = LibrarySyncKey(h.store.data.videoAliases), keys = h.store.Playlist(root).entries.map(entry => key(entry));
  assert.deepEqual(keys, ['bili-av:123:p2', `bili:${BV}:p1`]);
  const reloaded = new Store(h.store.directory), again = LibrarySyncKey(reloaded.data.videoAliases);
  assert.deepEqual(reloaded.Playlist(root).entries.map(entry => again(entry)), keys);
  for (const entry of h.store.Playlist(root).entries) assert.ok(Number.isInteger(entry.part) && typeof entry.videoId === 'string', '検証済みの項目はvideoIdとpartを持つ');
});

test('deriving keys, DeviceMedia and the ID audit write nothing and add no persisted fields', t => {
  const h = Setup(t), root = h.store.data.playlists[0].id;
  h.store.Apply({ type: 'add', playlistId: root, urls: `${url('av123')}\n${url(BV, 2)}` });
  const before = fs.readFileSync(h.store.file), offline = Offline(h.dir, ALIAS);
  Seed(offline, url(BV, 2)); const catalog = fs.readFileSync(path.join(offline.directory, 'index.json'));
  const key = LibrarySyncKey(h.store.data.videoAliases);
  for (const entry of h.store.Playlist(root).entries) key(entry);
  offline.DeviceMedia(); AuditIds(h.store.data.playlists);
  assert.deepEqual(fs.readFileSync(h.store.file), before); assert.deepEqual(fs.readFileSync(path.join(offline.directory, 'index.json')), catalog);
  const forbidden = /sync|devicemedia|collision|^state$/i;
  assert.deepEqual(Keys(JSON.parse(before.toString('utf8'))).filter(name => forbidden.test(name)), [], '保存JSONに新しいフィールドを追加しない');
  assert.deepEqual(Keys(JSON.parse(catalog.toString('utf8'))).filter(name => forbidden.test(name)), [], 'DLカタログにも追加しない');
  assert.deepEqual(Keys(ShareData(h.store.data, 'information')).filter(name => forbidden.test(name)), [], '共有出力にも追加しない');
});

test('the Windows adapter projects the catalog as DeviceMedia without paths, tokens or URLs, and never merges records', t => {
  const h = Setup(t), offline = Offline(h.dir, ALIAS);
  const a = Seed(offline, url('av170001'), 'video', 720), b = Seed(offline, url(BV), 'video', 1080), audio = Seed(offline, url(BV), 'audio', 0);
  const index = fs.readFileSync(path.join(offline.directory, 'index.json')), shown = offline.DeviceMedia();
  assert.equal(shown.skipped, 0); assert.equal(shown.items.length, 3, '保存済みの記録をどれも削除・統合しない');
  assert.deepEqual(shown.items.map(item => [item.syncKey, item.kind, item.height, item.state, item.collision]),
    [[`bili:${BV}:p1`, 'audio', 0, 'Completed', 1], [`bili:${BV}:p1`, 'video', 1080, 'Completed', 2], [`bili:${BV}:p1`, 'video', 720, 'Completed', 2]]);
  const text = JSON.stringify(shown); for (const secret of [h.dir, offline.directory, a.file, b.file, audio.file, a.token, 'http']) assert.ok(!text.includes(secret), `出力に含めない: ${secret}`);
  fs.rmSync(offline.ResolvePath(b.file));
  assert.equal(offline.DeviceMedia().items.find(item => item.height === 1080).state, 'NotDownloaded', '実体が無ければ完成扱いにしない');
  assert.deepEqual(fs.readFileSync(path.join(offline.directory, 'index.json')), index, '投影は保存データを変更しない');
  const restarted = Offline(h.dir, ALIAS); assert.deepEqual(restarted.DeviceMedia(), offline.DeviceMedia(), '再起動後も同じ結果');
  assert.equal(Offline(h.dir, []).DeviceMedia().items.map(item => item.syncKey).includes('bili-av:170001:p1'), true, '対応が未確認ならavのキーのまま別扱い');
});

test('DeviceMedia states: only Completed counts as complete after a restart', () => {
  assert.deepEqual(DEVICE_MEDIA_STATES, ['NotDownloaded', 'Preparing', 'Downloading', 'Processing', 'Validating', 'Completed', 'Failed', 'Cancelled']);
  for (const state of ['Preparing', 'Downloading', 'Processing', 'Validating', 'unknown', undefined, null, 5]) assert.equal(RestoredState(state), 'NotDownloaded');
  for (const state of ['Completed', 'Failed', 'Cancelled', 'NotDownloaded']) assert.equal(RestoredState(state), state);
  const { items } = DeviceMediaList({ records: [{ url: url(BV), kind: 'video', height: 720, bytes: 1 }], isAvailable: () => true }); assert.equal(items[0].state, 'Completed');
});

test('IDs created by this app are UUIDs, so independent libraries need no re-keying before sync', t => {
  const h = Setup(t), root = h.store.data.playlists[0].id;
  h.store.Apply({ type: 'create', name: '子', parentId: root }); h.store.Apply({ type: 'add', playlistId: root, urls: `${url('av1')}\n${url('av2')}` });
  assert.deepEqual(AuditIds(h.store.data.playlists), { lists: 0, entries: 0, media: 0, total: 4 });
  assert.deepEqual(AuditIds([{ id: 'a'.repeat(36), entries: [{ id: randomUUID(), mediaId: 'b'.repeat(36) }] }]), { lists: 1, entries: 0, media: 1, total: 2 });
});

test('every shared src module is listed in the iOS workflow paths so core edits always trigger iOS verification', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ios.yml'), 'utf8');
  for (const file of Object.values(MODULES).filter(name => name.startsWith('src/'))) assert.ok(workflow.includes(`"${file}"`), `${file} が .github/workflows/ios.yml の paths にありません`);
});
