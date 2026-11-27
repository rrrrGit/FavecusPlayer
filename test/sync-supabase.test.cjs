'use strict';
// v0.7.0 Step7-2：SupabaseSyncRepositoryとサインインを、偽のSupabase（メモリ上のPostgREST/Auth）で検証する。実際のSupabaseとの通信は別の確認項目。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/core/sync-state.cjs');
const E = require('../src/core/sync-engine.cjs');
const X = require('../src/core/sync-supabase.cjs');

const DAY = 86400000, T0 = Date.UTC(2026, 10, 13);
const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => id(1, n), tid = n => id(2, n);
const url = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`;
const track = (n, title = `曲${n}`) => ({ id: tid(n), title, addedAt: '2026-11-13T00:00:00.000Z', type: 'bilibili', url: url(n) });
const list = (n, name, entries = [], childIds = []) => ({ id: pid(n), name, icon: '', entries, childIds, createdAt: '2026-11-13T00:00:00.000Z', lastAddedAt: '', includeInAll: true });
const library = (playlists, rootPlaylistIds) => ({ version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds, playlists });
const { jwt, KEY, CONFIG, FakeServer } = require('./fake-supabase.cjs');
async function Repo(server, extra = {}) {
  await X.SendCode(CONFIG, server.request, 'me@example.com');
  let session = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  return new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => session, set: value => { session = value; } }, now: () => server.now, ...extra });
}
const Base = () => library([list(1, '親', [track(1), track(2)], [pid(2)]), list(2, '子', [track(3)])], [pid(1)]);
const Playlist = (lib, n) => lib.playlists.find(p => p.id === pid(n));
const Edited = (d, change) => { const next = JSON.parse(JSON.stringify(d.view)); change(next); return next; };

test('config accepts only an https supabase URL and an anon key, never a service_role or secret key', () => {
  assert.throws(() => X.SupabaseConfig({ url: 'http://evil.example.com', anonKey: KEY }), /URL/);
  assert.throws(() => X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co.evil.com', anonKey: KEY }), /URL/);
  assert.throws(() => X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co', anonKey: jwt('service_role') }), /service_role/);
  assert.throws(() => X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co', anonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }), /秘密/);
  assert.equal(X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co/', anonKey: 'sb_publishable_abcdefghijklmnopqrst' }).url, 'https://abcdefgh.supabase.co');
});

test('email one-time code sign-in: wrong code is rejected and the session carries no extra data', async () => {
  const server = FakeServer(); await X.SendCode(CONFIG, server.request, 'me@example.com');
  await assert.rejects(() => X.VerifyCode(CONFIG, server.request, 'me@example.com', '000000'), e => e.code === 'auth');
  await assert.rejects(() => X.VerifyCode(CONFIG, server.request, 'me@example.com', 'abc'), e => e.code === 'bad');
  const session = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  assert.deepEqual(Object.keys(session).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'userId']);
});

test('two devices converge through the Supabase repository, including offline edits and retried pushes', async () => {
  const server = FakeServer(), repoA = await Repo(server), repoB = await Repo(server);
  const a = E.NewDevice('devA'), b = E.NewDevice('devB'); E.Initialize(a, Base(), T0); E.Initialize(b, Base(), T0);
  for (const [d, r] of [[a, repoA], [b, repoB], [a, repoA]]) assert.equal((await E.Sync(d, r, T0)).ok, true);
  E.Edit(a, Edited(a, n => { Playlist(n, 1).name = 'A改名'; }), T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 2).entries.push(track(9, 'B追加')); }), T0 + 2000);
  server.online = false; assert.equal((await E.Sync(a, repoA, T0 + 3000)).ok, false); assert.ok(a.outbox.length > 0); server.online = true;
  for (const [d, r] of [[a, repoA], [b, repoB], [a, repoA], [b, repoB]]) assert.equal((await E.Sync(d, r, T0 + 4000)).ok, true);
  assert.equal(JSON.stringify(a.view), JSON.stringify(b.view)); assert.equal(Playlist(a.view, 1).name, 'A改名'); assert.ok(Playlist(a.view, 2).entries.some(e => e.title === 'B追加'));
  // 応答が失われた再送：同じ変更をもう一度送っても、行は増えない
  const change = { id: S.PlaylistId(pid(1)), f: { name: a.state.records[S.PlaylistId(pid(1))].f.name } };
  await repoA.Push('devA', [change]); const count = server.rows.length; await repoA.Push('devA', [change]);
  assert.equal(server.rows.length, count);
});

test('large pushes are chunked and paged reads return everything in seq order', async () => {
  const server = FakeServer(), repo = await Repo(server, { chunk: 50, pageSize: 70 });
  const a = E.NewDevice('devA'); E.Initialize(a, library([list(1, '大', Array.from({ length: 400 }, (_, i) => track(i + 1)))], [pid(1)]), T0);
  assert.equal((await E.Sync(a, repo, T0)).ok, true); assert.ok(server.requests.filter(r => r.method === 'POST' && r.rawUrl.includes('sync_changes')).length >= 9);
  const b = E.NewDevice('devB'); assert.equal((await E.Sync(b, repo, T0)).ok, true); assert.equal(Playlist(b.view, 1).entries.length, 400);
  assert.equal(JSON.stringify(a.view), JSON.stringify(b.view));
});

test('an expired access token is refreshed before the request, and a 401 triggers one refresh and a retry', async () => {
  const server = FakeServer(), repo = await Repo(server);
  const a = E.NewDevice('devA'); E.Initialize(a, Base(), T0);
  server.now = T0 + 2 * 3600 * 1000; assert.equal((await E.Sync(a, repo, server.now)).ok, true); assert.equal(server.refreshCount, 1);
  server.failNext401 = 1; E.Edit(a, Edited(a, n => { Playlist(n, 1).name = 'x'; }), server.now + 1);
  assert.equal((await E.Sync(a, repo, server.now + 2)).ok, true); assert.equal(server.refreshCount, 2);
});

test('failures keep the outbox: paused project, a missing session and a server error', async () => {
  const server = FakeServer(), repo = await Repo(server); const a = E.NewDevice('devA'); E.Initialize(a, Base(), T0);
  server.down = 503; let r = await E.Sync(a, repo, T0); assert.equal(r.ok, false); assert.match(r.error, /一時停止/); assert.ok(a.outbox.length > 0); server.down = 0;
  const lost = new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => null, set() {} }, now: () => server.now });
  r = await E.Sync(a, lost, T0); assert.equal(r.ok, false); assert.match(r.error, /サインイン/); assert.ok(a.outbox.length > 0);
  server.down = 500; r = await E.Sync(a, repo, T0); assert.equal(r.ok, false); assert.ok(a.outbox.length > 0);
});

test('tokens and keys never appear in error messages', async () => {
  const server = FakeServer(), repo = await Repo(server); server.online = false;
  const e = await repo.Pull(0).catch(error => error); assert.ok(!String(e.message).includes('acc-') && !String(e.message).includes(KEY));
});

test('Compact removes only old tombstones; the watermark moves only when rows were removed, and a stale device resyncs', async () => {
  const server = FakeServer(), repoA = await Repo(server), repoB = await Repo(server);
  const a = E.NewDevice('devA'), b = E.NewDevice('devB'); E.Initialize(a, Base(), T0); E.Initialize(b, Base(), T0);
  for (const [d, r] of [[a, repoA], [b, repoB], [a, repoA]]) await E.Sync(d, r, T0);
  assert.equal(await repoA.Compact(T0 + DAY), 0); assert.equal(server.watermark, 0, '削除がなければ境界は進まない');
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(2)); Playlist(n, 1).childIds = []; }), T0 + 1000); await E.Sync(a, repoA, T0 + 1000);
  E.Edit(b, Edited(b, n => { Playlist(n, 1).name = 'オフラインの改名'; }), T0 + 2000);
  assert.ok(await repoA.Compact(T0 + 1000 + 91 * DAY) > 0); assert.ok(server.watermark > 0);
  const r = await E.Sync(b, repoB, T0 + 1000 + 91 * DAY); assert.equal(r.ok, true); assert.equal(r.resynced, true);
  await E.Sync(a, repoA, T0 + 1000 + 91 * DAY); await E.Sync(b, repoB, T0 + 1000 + 91 * DAY);
  assert.ok(!Playlist(b.view, 2), '削除済みは復活しない'); assert.equal(Playlist(a.view, 1).name, 'オフラインの改名'); assert.equal(JSON.stringify(a.view), JSON.stringify(b.view));
});

test('an invalid row from the server fails the sync without changing the device', async () => {
  const server = FakeServer(), repo = await Repo(server); const a = E.NewDevice('devA'); E.Initialize(a, Base(), T0);
  server.rows.push({ seq: 1, record_id: 'bad', f: {}, device_id: 'x', batch_id: 'z', idx: 0 }); server.lastSeq = 1;
  const before = JSON.stringify([a.outbox, a.state]); const r = await E.Sync(a, repo, T0);
  assert.equal(r.ok, false); assert.equal(JSON.stringify([a.outbox, a.state]), before);
});

test('a resync after Compact ends with a cursor at or above the watermark, and Compact never removes a record that received newer rows', async () => {
  const server = FakeServer(), repoA = await Repo(server), repoB = await Repo(server);
  const a = E.NewDevice('devA'), b = E.NewDevice('devB'); E.Initialize(a, Base(), T0); E.Initialize(b, Base(), T0);
  for (const [d, r] of [[a, repoA], [b, repoB], [a, repoA]]) await E.Sync(d, r, T0);
  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(2)); Playlist(n, 1).childIds = []; }), T0 + 1000); await E.Sync(a, repoA, T0 + 1000);
  assert.ok(await repoA.Compact(T0 + 1000 + 91 * DAY) > 0);
  const pulled = await repoB.Pull(0); assert.ok(pulled.cursor >= server.watermark);
  // 読み取り後に同じレコードへ届いた行がある場合は消さない
  server.rows.push({ seq: ++server.lastSeq, record_id: S.PlaylistId(pid(1)), f: { name: ['後から', 'ffffffffffff-0000-z'.replace('ffffffffffff', '00ffffffffff')] }, device_id: 'x', batch_id: 'late', idx: 0 });
  const before = server.rows.length; await repoA.Call('POST', 'rpc/sync_compact', { body: { p_ids: [S.PlaylistId(pid(1))], p_upto: server.lastSeq - 1 } }); assert.equal(server.rows.length, before);
});

test('Pull falls back to full resync when Compact advances watermark mid-pull', async () => {
  const server = FakeServer({ now: T0 });
  await X.SendCode(CONFIG, server.request, 'a@example.com');
  let session = await X.VerifyCode(CONFIG, server.request, 'a@example.com', '123456', () => server.now);
  const makeRepo = reqFn => new X.SupabaseSyncRepository({
    config: CONFIG, request: reqFn, now: () => server.now,
    session: { get: () => session, set: v => { session = v; } },
  });
  const repoA = makeRepo(server.request);
  const a = E.NewDevice('dev-a'), b = E.NewDevice('dev-b');
  E.Initialize(a, Base(), T0);
  assert.equal((await E.Sync(a, repoA, T0)).ok, true);
  assert.equal((await E.Sync(b, repoA, T0)).ok, true);
  const cursorBeforeDelete = b.cursor;

  E.Edit(a, Edited(a, n => { n.playlists = n.playlists.filter(p => p.id !== pid(2)); Playlist(n, 1).childIds = []; }), T0 + 1000);
  assert.equal((await E.Sync(a, repoA, T0 + 1000)).ok, true);
  server.now = T0 + 92 * DAY;

  let compacted = false;
  const repoB = makeRepo(async (method, reqUrl, init) => {
    if (method === 'GET' && String(reqUrl).includes('sync_changes') && String(reqUrl).includes(`seq=gt.${cursorBeforeDelete}`) && !compacted) {
      compacted = true;
      await repoA.Compact(server.now);
    }
    return server.request(method, reqUrl, init);
  });
  const pulled = await repoB.Pull(cursorBeforeDelete);
  assert.equal(compacted, true);
  assert.equal(pulled.resync, true);
  const ids = new Set(pulled.snapshot.map(r => r.id));
  assert.equal(ids.has(S.PlaylistId(pid(1))), true);
  assert.equal(ids.has(S.PlaylistId(pid(2))), false);
});

test('FakeServer skips no-op sync_counts, rejects duplicate rows (21000), PushCounts deduplicates, and cleared_at clamps', async () => {
  const server = FakeServer();
  const headers = { apikey: KEY };
  await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/otp', { headers, body: { email: 'a@example.com' } });
  const auth = await server.request('POST', 'https://abcdefgh.supabase.co/auth/v1/verify', { headers, body: { email: 'a@example.com', token: '123456' } });
  const authed = { ...headers, Authorization: `Bearer ${auth.json.access_token}` };

  const row = { device_id: 'dev1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 3 };
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authed, body: [row] });
  assert.equal(server.countsSeq, 1);
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authed, body: [row] });
  assert.equal(server.countsSeq, 1);
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authed, body: [{ ...row, n: 2 }] });
  assert.equal(server.countsSeq, 1);
  await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', { headers: authed, body: [{ ...row, n: 4 }] });
  assert.equal(server.countsSeq, 2);

  const dup = await server.request('POST', 'https://abcdefgh.supabase.co/rest/v1/sync_counts', {
    headers: authed,
    body: [
      { device_id: 'd1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 2 },
      { device_id: 'd1', epoch: 0, month: '2026-11', media_key: 'bili:BV1aaaaaaaaa:p1', n: 5 },
    ],
  });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.code, '21000');

  const repo = new X.SupabaseSyncRepository({
    config: { url: 'https://abcdefgh.supabase.co', anonKey: KEY },
    request: server.request,
    now: () => server.now,
    session: { get: () => ({ accessToken: auth.json.access_token, refreshToken: auth.json.refresh_token, userId: auth.json.user.id, expiresAt: server.now + 3600000 }), set() {} },
  });
  await repo.PushCounts('d1', [
    { epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 2 },
    { epoch: 0, month: '2026-11', key: 'bili:BV1aaaaaaaaa:p1', n: 5 },
  ]);
  const pulled = await repo.PullCounts(0, 'd2');
  assert.equal(pulled.rows.find(r => r.device === 'd1').n, 5);

  await repo.PutHistoryState({ clearedAt: server.now + 10_000_000 });
  assert.equal((await repo.GetHistoryState()).clearedAt, server.now + 599000);
});

test('PushActivityLogs upserts daily logs, deletes entries older than retentionBeforeDay, and reports missing table', async () => {
  const server = FakeServer();
  const repo = await Repo(server);
  await repo.PushActivityLogs('ios-dev1', [
    { day: '2026-11-19', entries: [{ at: '2026-11-19T09:05:00.000+09:00', kind: 'app.launch' }] },
    { day: '2026-11-27', entries: [{ at: '2026-11-27T09:05:00.000+09:00', kind: 'alarm.resync' }] },
    { day: 'invalid-day', entries: [] },
  ], '2026-11-21');
  assert.equal(server.activityLogs.has('ios-dev1|2026-11-19'), false);
  assert.equal(server.activityLogs.has('ios-dev1|2026-11-27'), true);

  server.activityTable = false;
  await assert.rejects(() => repo.PushActivityLogs('ios-dev1', [{ day: '2026-11-27', entries: [] }], '2026-11-21'), error => error.code === 'missing');
});
