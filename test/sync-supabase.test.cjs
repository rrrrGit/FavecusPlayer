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
const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature-signature';
const KEY = jwt('anon');
const CONFIG = X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co', anonKey: KEY });

// 偽のSupabase。連番はコミット順（schema.sqlのトリガーと同じ）。再送（同じbatch/idx）は無視するが連番は消費する。
function FakeServer() {
  const s = { rows: [], lastSeq: 0, watermark: 0, requests: [], online: true, down: 0, ttl: 3600, now: T0, tokens: new Map(), codes: new Map(), refreshCount: 0, failNext401: 0 };
  const issue = user => {
    const n = s.tokens.size + 1, access = `acc-${n}`, refresh = `ref-${n}`;
    s.tokens.set(access, { user, exp: Math.floor(s.now / 1000) + s.ttl }); s.tokens.set(refresh, { user, refresh: true });
    return { access_token: access, refresh_token: refresh, expires_in: s.ttl, user: { id: user } };
  };
  s.request = async (method, rawUrl, { headers = {}, body } = {}) => {
    s.requests.push({ method, rawUrl, headers, body });
    if (!s.online) throw new Error('network');
    if (s.down) return { status: s.down, json: null };
    const u = new URL(rawUrl), path = u.pathname;
    if (headers.apikey !== KEY) return { status: 401, json: {} };
    if (path === '/auth/v1/otp') { s.codes.set(body.email, '123456'); return { status: 200, json: {} }; }
    if (path === '/auth/v1/verify') return s.codes.get(body.email) === body.token ? { status: 200, json: issue('user-1') } : { status: 403, json: {} };
    if (path === '/auth/v1/token') {
      const t = s.tokens.get(body.refresh_token);
      if (!t || !t.refresh) return { status: 400, json: {} };
      s.refreshCount++; return { status: 200, json: issue(t.user) };
    }
    const token = s.tokens.get(String(headers.Authorization || '').replace('Bearer ', ''));
    if (!token || token.refresh || token.exp <= Math.floor(s.now / 1000) || s.failNext401-- > 0) return { status: 401, json: {} };
    if (path === '/rest/v1/sync_meta') return { status: 200, json: [{ last_seq: s.lastSeq, watermark: s.watermark }] };
    if (path === '/rest/v1/sync_changes' && method === 'POST') {
      assert.ok(body.length <= 500, 'chunked');
      for (const row of body) { s.lastSeq++; if (!s.rows.some(r => r.batch_id === row.batch_id && r.idx === row.idx)) s.rows.push({ seq: s.lastSeq, ...row }); }
      return { status: 201, json: null };
    }
    if (path === '/rest/v1/sync_changes' && method === 'GET') {
      const after = Number(u.searchParams.get('seq').replace('gt.', '')), limit = Number(u.searchParams.get('limit'));
      return { status: 200, json: s.rows.filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map(r => ({ seq: r.seq, record_id: r.record_id, f: r.f })) };
    }
    if (path === '/rest/v1/rpc/sync_compact') {
      const before = s.rows.length; s.rows = s.rows.filter(r => !body.p_ids.includes(r.record_id));
      if (s.rows.length < before) s.watermark = s.lastSeq;
      return { status: 200, json: before - s.rows.length };
    }
    return { status: 404, json: {} };
  };
  return s;
}
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
