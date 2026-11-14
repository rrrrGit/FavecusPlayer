'use strict';
// v0.7.1 Step4：iPhone版の同期の入口（JavaScriptCore想定）が、ライブラリの同期のあとに、再生回数・設定を同期する。
// host（Swiftの代わり）は、共通JSの台帳の入口（LedgerSyncState / LedgerMerge）で、Swiftの PlayCountStore と同じ手順を行う。Windows役の PlayCounts と、偽のSupabaseで接続する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Runtime = require('../src/core/sync-runtime.cjs');
const App = require('../src/core/library-app.cjs');
const Actions = require('../src/core/library-actions.cjs');
const { PlayCounts } = require('../src/core/play-counts.cjs');
const { ParseBilibili } = require('../src/core/urls.cjs');
const { KEY, FakeServer } = require('./fake-supabase.cjs');

const URL_ = 'https://abcdefgh.supabase.co', Pretty = value => JSON.stringify(value, null, 2);
let counter = 0;
const ctx = { createId: () => `dddddddd-0000-4000-8000-${String(++counter).padStart(12, '0')}`, now: () => '2026-11-14T00:00:00.000Z', cleanTitle: v => String(v).trim() };
const song = ParseBilibili('https://www.bilibili.com/video/BV1aaaaaaaaa/');

test('after the library sync, the iPhone host reads, applies and acknowledges counts and the preference', async t => {
  const server = FakeServer({ now: Date.now() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-rtc-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Windows役：すでに3回再生している
  const pc = new PlayCounts(path.join(root, 'pc.json'));
  let now = 1000; pc.now = () => now;
  for (let r = 0; r < 3; r++) { pc.Begin(song); for (let i = 0; i < 6; i++) { now += 1000; pc.Observe({ position: i, duration: 200, paused: false }); } }
  const pcAdapter = { Read: async () => pc.SyncRead({ weighted: false, at: 500 }), Apply: async ({ rows, epoch, cursor }) => { pc.SyncApply({ rows, epoch, cursor }); }, Pushed: async () => pc.SyncPushed() };
  const { SyncExtras } = require('../src/core/sync-counts.cjs'), X = require('../src/core/sync-supabase.cjs'), { CONFIG } = require('./fake-supabase.cjs');
  await X.SendCode(CONFIG, server.request, 'me@example.com');
  let pcSession = await X.VerifyCode(CONFIG, server.request, 'me@example.com', '123456', () => server.now);
  const pcRepo = new X.SupabaseSyncRepository({ config: CONFIG, request: server.request, session: { get: () => pcSession, set: v => { pcSession = v; } }, now: () => server.now });
  assert.equal((await SyncExtras(pcAdapter, pcRepo)).ok, true);

  // iPhone役：台帳はSwiftが持つ文字列。countsRead / countsApply / countsPushed を host が答える
  const phone = { ledger: App.LedgerOpen({ deviceId: 'phone1' }).text, prefs: { weighted: true, at: 0 }, dirty: new Set(), pushedOnce: false, applied: 0, pushed: 0 };
  const library = Actions.NewPlaylist(ctx), lib = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: library.id, rootPlaylistIds: [library.id], playlists: [library] };
  let libraryText = Pretty(lib), state = null, session = null;
  globalThis.__favecusHost = {
    library: async () => libraryText, write: async json => { libraryText = JSON.parse(json).text; }, persist: async text => { state = text; }, backup: async () => 'b', recovered: async () => false,
    request: async (method, url, init) => { const { headers, body } = JSON.parse(init); return JSON.stringify(await server.request(method, url, { headers, body: body === null ? undefined : body })); },
    saveSession: async json => { session = JSON.parse(json); },
    countsRead: async () => {
      const s = App.LedgerSyncState({ text: phone.ledger });
      const rows = s.rows.filter(row => !phone.pushedOnce || phone.dirty.has(row.id)).map(({ epoch, month, key, n }) => ({ epoch, month, key, n }));
      return JSON.stringify({ deviceId: s.deviceId, epoch: s.epoch, cursor: s.cursor, rows, prefs: phone.prefs });
    },
    countsApply: async json => {
      const v = JSON.parse(json), merged = App.LedgerMerge({ text: phone.ledger, rows: v.rows, epoch: v.epoch, cursor: v.cursor });
      phone.ledger = merged.text; if (v.prefs) phone.prefs = v.prefs; phone.applied++;
    },
    countsPushed: async () => { phone.dirty.clear(); phone.pushedOnce = true; phone.pushed++; }
  };
  const config = { url: URL_, anonKey: KEY };
  assert.equal((await Runtime.SendCode({ config, email: 'me@example.com' })).ok, true);
  const verified = await Runtime.VerifyCode({ config, email: 'me@example.com', code: '123456' });
  session = verified.session;
  assert.equal((await Runtime.Open({ stateText: null, config, session, deviceId: 'ios-test' })).status, 'none');
  assert.equal((await Runtime.Enable({ origin: { url: URL_, userId: session.userId } })).ok, true);
  const cycle = await Runtime.Cycle();
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.extras.ok, true, JSON.stringify(cycle.extras));
  assert.equal(phone.applied, 1); assert.equal(phone.pushed, 1);
  const totals = App.LedgerCounts({ text: phone.ledger, keys: ['bili:BV1aaaaaaaaa:p1'] });
  assert.equal(totals.counts['bili:BV1aaaaaaaaa:p1'], 3, 'Windowsの3回が、iPhoneにも反映される');
  assert.deepEqual(phone.prefs, { weighted: false, at: 500 }, '設定も、新しい方（Windows）が反映される');
  // iPhoneでの再生が、Windowsへ戻る
  phone.ledger = App.LedgerIncrement({ text: phone.ledger, key: 'bili:BV1aaaaaaaaa:p1', now: Date.now() }).text;
  phone.dirty.add(App.LedgerSyncState({ text: phone.ledger }).rows.find(r => r.n === 1 && r.id.startsWith('phone1')).id);
  assert.equal((await Runtime.Cycle()).extras.ok, true);
  assert.equal((await SyncExtras(pcAdapter, pcRepo)).ok, true);
  assert.equal(pc.Count(song), 4);
});

test('a missing counts table is reported in the cycle result without failing the library sync', async () => {
  const server = FakeServer({ now: Date.now() });
  server.countsTable = false;
  const library = Actions.NewPlaylist(ctx), lib = { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: library.id, rootPlaylistIds: [library.id], playlists: [library] };
  let libraryText = Pretty(lib), session = null;
  globalThis.__favecusHost = {
    library: async () => libraryText, write: async json => { libraryText = JSON.parse(json).text; }, persist: async () => {}, backup: async () => 'b', recovered: async () => false,
    request: async (method, url, init) => { const { headers, body } = JSON.parse(init); return JSON.stringify(await server.request(method, url, { headers, body: body === null ? undefined : body })); },
    saveSession: async json => { session = JSON.parse(json); },
    countsRead: async () => JSON.stringify({ deviceId: 'p', epoch: 0, cursor: 0, rows: [], prefs: { weighted: true, at: 0 } }), countsApply: async () => {}, countsPushed: async () => {}
  };
  const config = { url: URL_, anonKey: KEY };
  await Runtime.SendCode({ config, email: 'me@example.com' });
  session = (await Runtime.VerifyCode({ config, email: 'me@example.com', code: '123456' })).session;
  await Runtime.Open({ stateText: null, config, session, deviceId: 'ios-test-2' });
  await Runtime.Enable({ origin: { url: URL_, userId: session.userId } });
  const cycle = await Runtime.Cycle();
  assert.equal(cycle.ok, true, 'ライブラリの同期は成功する');
  assert.equal(cycle.extras.ok, false); assert.equal(cycle.extras.missing, true);
});
