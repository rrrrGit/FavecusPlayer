'use strict';
// v0.7.1 Step4：再生回数と設定の端末間同期。PC役・iPhone役の2つの台帳を、偽のSupabase（schema.sqlと同じ規則）で接続して確かめる。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const X = require('../src/core/sync-supabase.cjs');
const { SyncExtras } = require('../src/core/sync-counts.cjs');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { CONFIG, FakeServer } = require('./fake-supabase.cjs');

const song = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/'), other = ParseBilibili('https://www.bilibili.com/video/BV1bbbbbbbbb/');
const local = { type: 'local', fileName: '0a0b0c0d-0000-4000-8000-000000000001.mp3' };
function Temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-counts-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
async function Repo(server) {
  await X.SendCode(CONFIG, server.request, 'me@example.com');
  let session = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  return new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => session, set: value => { session = value; } }, now: () => server.now });
}
// 端末役：台帳（PlayCounts）と設定（優先する・変更時刻）
function Device(root, name, server) {
  const device = { counts: new PlayCounts(path.join(root, `${name}.json`)), prefs: { weighted: true, at: 0 }, now: 1000 };
  device.counts.now = () => device.now;
  device.play = entry => { device.counts.Begin(entry); for (let i = 0; i < 6; i++) { device.now += 1000; device.counts.Observe({ position: i, duration: 200, paused: false }); } };
  device.setWeighted = (value, at) => { device.prefs = { weighted: value, at }; };
  device.adapter = {
    Read: async () => device.counts.SyncRead({ ...device.prefs }),
    Apply: async ({ rows, epoch, cursor, prefs }) => { device.counts.SyncApply({ rows, epoch, cursor }); if (prefs) device.prefs = { ...prefs }; },
    Pushed: async () => device.counts.SyncPushed()
  };
  device.sync = async () => SyncExtras(device.adapter, await Repo(server));
  return device;
}

test('plays on two devices add up on both after syncing, and syncing again never counts anything twice', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  for (let i = 0; i < 3; i++) pc.play(song);
  for (let i = 0; i < 2; i++) phone.play(song);
  phone.play(other);
  assert.equal((await pc.sync()).ok, true); assert.equal((await phone.sync()).ok, true); assert.equal((await pc.sync()).ok, true);
  for (let i = 0; i < 3; i++) { await pc.sync(); await phone.sync(); }
  assert.equal(pc.counts.Count(song), 5); assert.equal(phone.counts.Count(song), 5);
  assert.equal(pc.counts.Count(other), 1); assert.equal(phone.counts.Count(other), 1);
  // 続きの再生は、変わった行だけが送られる
  pc.play(song);
  const result = await pc.sync();
  assert.equal(result.pushed, 1);
  await phone.sync();
  assert.equal(phone.counts.Count(song), 6);
});

test('local songs are never uploaded', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  pc.play(local); pc.play(song);
  await pc.sync();
  assert.deepEqual([...server.counts.values()].map(row => row.media_key), ['bili:BV1aaaaaaaaa:p1']);
  assert.equal(pc.counts.Count(local), 1, '端末の中の回数は、そのまま');
});

test('a reset on one device moves every device to the new epoch; plays after the reset count again; old rows stay as history', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  pc.play(song); phone.play(song);
  await pc.sync(); await phone.sync(); await pc.sync();
  assert.equal(pc.counts.Count(song), 2);
  pc.counts.Reset();
  await pc.sync(); await phone.sync();
  assert.equal(phone.counts.Count(song), 0, 'リセットが、iPhoneにも届く');
  assert.equal(server.prefs.epoch, 1);
  phone.play(song);
  await phone.sync(); await pc.sync();
  assert.equal(pc.counts.Count(song), 1); assert.equal(phone.counts.Count(song), 1);
  assert.ok([...server.counts.values()].some(row => row.epoch === 0), '古い世代の行は、履歴として残る');
});

test('the preference follows the newest change and an older change never overrides it', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server), phone = Device(root, 'phone', server);
  pc.setWeighted(false, 100);
  await pc.sync(); await phone.sync();
  assert.deepEqual(phone.prefs, { weighted: false, at: 100 });
  phone.setWeighted(true, 200);
  await phone.sync(); await pc.sync();
  assert.deepEqual(pc.prefs, { weighted: true, at: 200 });
  // 古い時刻の変更（オフライン中に行った変更が、あとで届く）は、新しい設定を上書きしない
  const late = Device(root, 'late', server); late.setWeighted(false, 150);
  await late.sync();
  assert.deepEqual(late.prefs, { weighted: true, at: 200 });
  assert.equal(server.prefs.weighted_shuffle, true);
});

test('the server keeps the larger count when an older, smaller row arrives later', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  pc.play(song); pc.play(song); pc.play(song);
  await pc.sync();
  const repo = await Repo(server);
  const [row] = [...server.counts.values()];
  assert.equal(row.n, 3);
  await repo.PushCounts(pc.counts.ledger.deviceId, [{ epoch: row.epoch, month: row.month, key: row.media_key, n: 1 }]); // 古い・小さい値
  assert.equal([...server.counts.values()][0].n, 3, '減らない');
});

test('when the extra tables have not been created yet, syncing reports it and changes nothing', async t => {
  const server = FakeServer(), root = Temp(t), pc = Device(root, 'pc', server);
  server.countsTable = false; pc.play(song);
  const result = await pc.sync();
  assert.equal(result.ok, false); assert.equal(result.missing, true); assert.match(result.error, /schema\.sql/);
  assert.equal(pc.counts.Count(song), 1, '端末の回数は、そのまま');
  server.countsTable = true;
  assert.equal((await pc.sync()).ok, true, 'SQLを実行したあとは、そのまま使える');
  assert.equal(server.counts.size, 1);
});
