'use strict';
// 共通テストデータ（shared/fixtures/cases.json）の実行器。NodeでもiOSのJavaScriptCoreでも同じものを実行する。
// 入出力はJSON文字列のみ。端末APIには依存しない。
const urls = require('../core/urls.cjs');
const bilibili = require('../core/bilibili-resolve.cjs');
const mediaIdentity = require('../core/media-identity.cjs');
const data = require('../core/library-data.cjs');
const libraryIdentity = require('../core/library-identity.cjs');
const deviceMedia = require('../core/device-media.cjs');
const syncClock = require('../core/sync-clock.cjs');
const syncOrder = require('../core/sync-order.cjs');
const syncState = require('../core/sync-state.cjs');
const syncLibrary = require('../core/sync-library.cjs');
const syncEngine = require('../core/sync-engine.cjs');
const syncStateFile = require('../core/sync-statefile.cjs');
const syncSession = require('../core/sync-session.cjs');
const syncRuntime = require('../core/sync-runtime.cjs');
const share = require('../core/library-share.cjs');
const importIdentity = require('../core/import-identity.cjs');
const iconData = require('../core/playlist-icon-data.cjs');
const actions = require('../core/library-actions.cjs');
const libraryApp = require('../core/library-app.cjs');
const tree = require('../ui/library-tree.js');
const search = require('../ui/library-search.js');

function Counter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(900000 + (n++)).padStart(12, '0')}`;
}
function Canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(Canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + Canonical(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
const Plain = value => JSON.parse(JSON.stringify(value));
const KeyOf = entry => entry.type === 'local' ? `local:${entry.fileName}` : mediaIdentity.MediaKey(entry);

const CALLS = {
  ParseBilibili: input => urls.ParseBilibili(input),
  IsAllowedRemote: (raw, kind) => urls.IsAllowedRemote(raw, kind),
  PlayerURL: (entry, details) => urls.PlayerURL(entry, details),
  VideoIdentity: (input, details) => mediaIdentity.VideoIdentity(input, details),
  MediaKey: (entry, details) => mediaIdentity.MediaKey(entry, details),
  DownloadIdentity: (entry, kind, details) => mediaIdentity.DownloadIdentity(entry, kind, details),
  SameVideo: (left, right, details) => mediaIdentity.SameVideo(left, right, details),
  ValidateLibrary: (library, freshIds) => data.ValidateLibrary(library, !!freshIds, Counter()),
  ShareData: (library, mode) => share.ShareData(library, mode),
  ReadShare: input => { const result = share.ReadShare(input); return { mode: result.mode, locals: [...result.locals.entries()] }; },
  SearchPage: (library, query, page) => {
    const result = search.Page(search.Index(library), query, page);
    return { total: result.total, page: result.page, pages: result.pages, items: result.items.map(item => ({ playlistId: item.playlistId, title: item.entry.title || '', pathText: item.pathText })) };
  },
  ImportPlan: (existing, lists, roots, options) => {
    const plan = importIdentity.PlanImportIdentity(existing, lists, roots, { keyOf: KeyOf, createId: Counter(), ...(options || {}) });
    return { playlists: plan.playlists, rootPlaylistIds: plan.rootPlaylistIds, idMap: [...plan.idMap.entries()] };
  },
  ValidateIcon: value => iconData.ValidateIcon(value),
  SyncMediaKey: (entry, aliases) => libraryIdentity.LibrarySyncKey(aliases || [])(entry),
  SyncKeyForms: (entry, aliases) => libraryIdentity.LibrarySyncKeyForms(aliases || [])(entry),
  AuditIds: playlists => libraryIdentity.AuditIds(playlists),
  RestoredState: state => deviceMedia.RestoredState(state),
  // 編集操作：操作を順に適用し、各操作の後に階層を検証（Storeと同じ）、最後に全体を検証する。IDと時刻は決定的。
  LibraryAction: spec => {
    const library = Plain(spec.library), createId = Counter(), ctx = { createId, now: () => '2026-11-13T00:00:00.000Z', cleanTitle: text => String(text).trim() }, handled = [];
    for (const action of spec.steps) { handled.push(actions.Apply(library, action, ctx)); tree.ValidateGraph(library.playlists, library.rootPlaylistIds); }
    data.ValidateLibrary(Plain(library), false, Counter());
    return { handled, library };
  },
  // 名前順などの並び（Intl.Collator('ja')）。NodeとiOSのICUの違いを検出する。
  TreeOrder: spec => ({ ids: tree.Ordered(Plain(spec.library), spec.ids, spec.mode) }),
  LibraryOpen: options => libraryApp.Open(options),
  LibraryApply: options => libraryApp.Apply(options),
  QueueRun: options => libraryApp.QueueRun(options),
  TransferPrepare: options => libraryApp.TransferPrepare(options),
  TransferImport: options => libraryApp.TransferImport(options),
  TransferExport: options => libraryApp.TransferExport(options),
  // 同期状態ファイルの検証（未知の版・壊れた内容は停止）と、書き出し→読み戻しの一致。
  SyncStateParse: text => syncStateFile.ParseState(text),
  SyncStateRoundTrip: library => { const device = syncEngine.NewDevice('devA'); syncEngine.Initialize(device, library, 1800000000000); const text = syncStateFile.SerializeState(device, { origin: { url: 'https://x.supabase.co', userId: 'u1' }, lastSyncAt: 5 }); const parsed = syncStateFile.ParseState(text); return { status: parsed.status, records: Object.keys(parsed.snapshot.state.records).length, outbox: parsed.snapshot.outbox.length, origin: parsed.snapshot.origin, same: JSON.stringify(parsed.snapshot.state) === JSON.stringify(device.state) }; },
  SyncPristine: library => ({ pristine: syncSession.IsPristine(library), hasContent: syncSession.HasContent(library) }),
  // Bilibiliの配信先の決め方（通信は含まない）。MD5・署名・配信先の許可・ストリームの選択・保護された動画の拒否。
  BiliMd5: text => bilibili.Md5(text),
  BiliSign: (query, images, now) => bilibili.SignQuery(query, images, now),
  BiliMediaURL: raw => bilibili.MediaURL(raw),
  BiliSelect: (info, kind, height) => bilibili.SelectStreams(info, kind, height),
  // 通信の順番：決まった応答を順に渡し、要求（endpoint・query）と最終結果を返す。
  BiliResolve: spec => {
    const steps = bilibili.ResolveSteps(urls.ParseBilibili(spec.url), spec.kind, spec.height || 720, spec.now || 1700000000000), requests = [];
    let step = steps.next();
    for (const response of spec.responses) { if (step.done) break; requests.push(step.value); step = steps.next(response); }
    if (!step.done) return { requests, pending: step.value };
    return { requests, resolved: step.value.resolved, verified: step.value.verified };
  },
  SyncClock: steps => steps.map(step => step.op === 'tick' ? syncClock.Tick(step.last, step.now, step.device) : syncClock.Observe(step.last, step.remote, step.now, step.device)),
  SyncOrder: spec => ({ between: (spec.pairs || []).map(([a, b]) => syncOrder.Between(a, b)), spread: syncOrder.Spread(spec.spread || 0) }),
  SyncMerge: changes => { const merged = changes.reduce((state, change) => syncState.Merge(state, [change]).state, syncState.NewState()); return JSON.parse(syncState.Canonical(merged)); },
  SyncMaterialize: (library, context) => { const state = syncState.Merge(syncState.NewState(), syncLibrary.FromLibrary(library)).state, result = syncLibrary.Materialize(state, context || {}); data.ValidateLibrary(result.library, false, Counter()); return result; },
  SyncRun: spec => SyncRun(spec),
  DeviceMediaList: (records, aliases, available) => deviceMedia.DeviceMediaList({ records, videoAliases: aliases || [], isAvailable: record => (available || []).includes(record.token) })
};

// 端末同士の同期の筋書き（同期版のリポジトリで実行する）。JavaScriptCoreでNodeと同じ結果になることを確認するための共通テストデータ用。
function SyncRun(spec) {
  const repository = new syncEngine.MemorySyncRepository(), devices = {}, context = spec.context || {}, oks = [];
  for (const name of spec.devices) devices[name] = syncEngine.NewDevice(name);
  let now = 1800000000000;
  if (spec.base) for (const name of spec.devices) syncEngine.Initialize(devices[name], spec.base, now, context);
  for (const step of spec.steps) {
    now += step.advance || 1000;
    if (step.edit) syncEngine.Edit(devices[step.edit], step.library, now, context);
    else if (step.sync) { repository.online = step.offline !== true; for (const name of step.sync) oks.push(syncEngine.SyncNow(devices[name], repository, now, context).ok); repository.online = true; }
    else if (step.compact) { now += step.compact; repository.Compact(now); }
  }
  const out = { oks, devices: {} };
  for (const name of spec.devices) {
    const device = devices[name]; data.ValidateLibrary(JSON.parse(JSON.stringify(device.view)), false, Counter());
    out.devices[name] = { library: device.view, outbox: device.outbox.length, conflicts: device.conflicts.length, held: device.lastView.held, recovered: device.lastView.recovered.map(r => r.recoveryId), cut: device.lastView.cut };
  }
  return out;
}

function Execute(testCase) {
  const call = CALLS[testCase.call];
  if (!call) return { error: `未対応の呼び出し: ${testCase.call}` };
  try { return { ok: Plain(call(...(testCase.args || []).map(Plain))) }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}

function RunCases(json) {
  const cases = JSON.parse(json), failures = [];
  for (const testCase of cases) {
    const actual = Execute(testCase);
    if (testCase.divergence === 'ios-rejects') {
      // 既知の相違：Node（Windows）は受理し、この実行環境は拒否する。polyfillの 'Invalid URL' 以外の理由で拒否された場合も失敗。
      if (!actual.error || !actual.error.includes('Invalid URL')) failures.push({ name: testCase.name, expected: 'error:Invalid URL(divergence)', actual: Canonical(actual) });
    } else if (Object.prototype.hasOwnProperty.call(testCase, 'expectError')) {
      if (!actual.error || !actual.error.includes(testCase.expectError)) failures.push({ name: testCase.name, expected: `error:${testCase.expectError}`, actual: Canonical(actual) });
    } else if (actual.error || Canonical(actual.ok) !== Canonical(testCase.expect)) {
      failures.push({ name: testCase.name, expected: Canonical(testCase.expect), actual: Canonical(actual) });
    }
  }
  return JSON.stringify({ total: cases.length, failures });
}

// 期待値の更新用（Nodeの開発者向け）：各ケースの実行結果をそのまま返す。
function Observe(json) {
  return JSON.stringify(JSON.parse(json).map(testCase => ({ name: testCase.name, ...Execute(testCase) })));
}

// 999リスト・10000登録の規模での処理時間（ミリ秒）。データは決定的に生成する。
function MakeLibrary(lists, perList) {
  const id = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const playlists = [], roots = [];
  for (let i = 0; i < lists; i++) {
    const entries = [];
    for (let j = 0; j < perList; j++) {
      const n = i * perList + j, bv = 'BV' + n.toString(36).padStart(10, '0');
      entries.push({ id: id(2, n), mediaId: id(3, n), type: 'bilibili', title: `曲${n} テスト`, url: `https://www.bilibili.com/video/${bv}/` });
    }
    playlists.push({ id: id(1, i), name: `リスト${i}`, childIds: [], entries });
    if (i < 20) roots.push(id(1, i)); else playlists[(i - 20) % 20].childIds.push(id(1, i));
  }
  return { version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: roots, playlists };
}
function Bench(json) {
  const options = JSON.parse(json || '{}'), lists = options.lists || 999, perList = options.perList || 10;
  const timed = fn => { const start = Date.now(); const value = fn(); return [Date.now() - start, value]; };
  const library = MakeLibrary(lists, perList), result = { lists, entries: lists * perList };
  let validated, output, index;
  [result.validateMs, validated] = timed(() => data.ValidateLibrary(library, false, Counter()));
  [result.shareMs, output] = timed(() => share.ShareData(library, 'information'));
  [result.searchIndexMs, index] = timed(() => search.Index(library));
  [result.searchPageMs] = timed(() => search.Page(index, '曲5 テスト', 0));
  [result.importMs] = timed(() => importIdentity.PlanImportIdentity([], output.playlists, output.rootPlaylistIds, { keyOf: KeyOf, createId: Counter() }));
  result.validatedLists = validated.length; result.searchTotal = search.Page(index, '曲5 テスト', 0).total;
  // 同期：999リスト・約1万登録の、初期変換・取り込み・導出・1回の編集の差分
  let records, state, view;
  [result.syncConvertMs, records] = timed(() => syncLibrary.FromLibrary(library));
  [result.syncMergeMs, state] = timed(() => syncState.Merge(syncState.NewState(), records).state);
  [result.syncMaterializeMs, view] = timed(() => syncLibrary.Materialize(state));
  const edited = JSON.parse(JSON.stringify(view.library)); edited.playlists[3].name = '改名'; edited.playlists[5].entries.reverse();
  let tick = 0; [result.syncDiffMs] = timed(() => syncLibrary.Diff(view.library, edited, state, () => syncClock.Format(1800000000000, ++tick, 'bench')));
  // 編集操作（改名・曲の並べ替え・リストの並べ替え＋階層の検証）。Storeと同じく、編集のたびに全体検証はしない。
  const working = JSON.parse(JSON.stringify(view.library)), actionContext = { createId: Counter(), now: () => '2026-11-13T00:00:00.000Z', cleanTitle: text => text };
  [result.actionMs] = timed(() => { actions.Apply(working, { type: 'rename', playlistId: working.playlists[3].id, name: '改名' }, actionContext); actions.Apply(working, { type: 'reorder', playlistId: working.playlists[5].id, entryId: working.playlists[5].entries[0].id, targetId: working.playlists[5].entries[9].id, after: true }, actionContext); tree.ValidateGraph(working.playlists, working.rootPlaylistIds); });
  result.syncRecords = records.length; result.syncLists = view.library.playlists.length;
  return JSON.stringify(result);
}

// iPhone版の入口（JSON文字列の入出力）。
const LibraryOpen = json => JSON.stringify(libraryApp.Open(JSON.parse(json)));
const LibraryApply = json => JSON.stringify(libraryApp.Apply(JSON.parse(json)));
const QueueStart = json => JSON.stringify(libraryApp.QueueStart(JSON.parse(json)));
const QueueMove = json => JSON.stringify(libraryApp.QueueMove(JSON.parse(json)));
// iPhone版の同期の入口（Promiseを返す。Swiftが結果を待つ）。
const Json = promise => promise.then(value => JSON.stringify(value));
const SyncOpen = json => Json(syncRuntime.Open(JSON.parse(json)));
const SyncEnable = json => Json(syncRuntime.Enable(JSON.parse(json)));
const SyncCycle = json => Json(syncRuntime.Cycle(json ? JSON.parse(json) : {}));
const SyncUnblock = json => Json(syncRuntime.Unblock(JSON.parse(json)));
const SyncChanged = () => JSON.stringify(syncRuntime.Changed());
const SyncReset = () => JSON.stringify(syncRuntime.Reset());
const SyncState = () => JSON.stringify(syncRuntime.State());
const SyncValidate = json => JSON.stringify(syncRuntime.ValidateConfig(JSON.parse(json)));
const SyncSendCode = json => Json(syncRuntime.SendCode(JSON.parse(json)));
const SyncVerifyCode = json => Json(syncRuntime.VerifyCode(JSON.parse(json)));
const QueueSync = json => JSON.stringify(libraryApp.QueueSync(JSON.parse(json)));
const QueuePeek = json => JSON.stringify(libraryApp.QueuePeek(JSON.parse(json)));
const TransferPrepare = json => JSON.stringify(libraryApp.TransferPrepare(JSON.parse(json)));
const TransferImport = json => JSON.stringify(libraryApp.TransferImport(JSON.parse(json)));
const TransferExport = json => JSON.stringify(libraryApp.TransferExport(JSON.parse(json)));
module.exports = { RunCases, Observe, Bench, LibraryOpen, LibraryApply, QueueStart, QueueMove, QueueSync, QueuePeek, SyncOpen, SyncEnable, SyncCycle, SyncUnblock, SyncChanged, SyncReset, SyncState, SyncValidate, SyncSendCode, SyncVerifyCode, TransferPrepare, TransferImport, TransferExport };
