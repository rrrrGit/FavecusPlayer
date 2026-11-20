'use strict';
// iPhone版（JavaScriptCore）が使うライブラリの入口。保存ファイルの読み込み判定と編集操作を、Swiftへ規則を持たせずに共通JSで行う。
// 端末APIなし。ID・時刻は呼び出し側が渡す（ids：新しいIDの予備、now：ISO文字列）。入出力はJSON文字列で扱いやすいよう、結果は { text } または { error } にそろえる。
const Actions = require('./library-actions.cjs');
const Tree = require('../ui/library-tree.js');
const { ValidateLibrary, CleanText } = require('./library-data.cjs');
const { ValidateIdentityVersion, LibrarySyncKey } = require('./library-identity.cjs');
const Transfer = require('./library-transfer.cjs');
const { Queue } = require('./queue.cjs');
const Ledger = require('./play-ledger.cjs');
const AutoListsCore = require('./auto-lists.cjs');
const LibrarySearch = require('../ui/library-search.js');
const Trash = require('./trash.cjs');

const ID = /^[a-f0-9-]{36}$/;
function Context(options) {
  const pool = Array.isArray(options?.ids) ? [...options.ids] : [];
  return {
    createId: () => { const id = pool.shift(); if (!ID.test(id || '')) throw new Error('新しい識別番号を用意できません。'); return id; },
    now: () => (typeof options?.now === 'string' && Number.isFinite(Date.parse(options.now)) ? new Date(options.now).toISOString() : '1970-01-01T00:00:00.000Z'),
    cleanTitle: value => CleanText(value)
  };
}
function EmptyLibrary(ctx) {
  const first = Actions.NewPlaylist(ctx);
  return { version: 3, identityVersion: 2, videoAliases: [], activePlaylistId: first.id, rootPlaylistIds: [first.id], playlists: [first] };
}
const Pretty = value => JSON.stringify(value, null, 2);

// 保存ファイルの内容（なければnull）を読む。status：
//   'new'         ファイルがない（textがnull/未指定）→ 既定のライブラリ（まだ保存していない）。空文字は壊れた内容として 'invalid'
//   'ok'          読み込めた（全体を検証済み）
//   'unsupported' この版では扱えない形式・識別情報の不整合（上書きせず、バックアップへも戻さない。Windows版が読み込みを止める場合と同じ）
//   'invalid'     壊れている・検証に失敗（上書きしないこと）
function Open(options) {
  const ctx = Context(options), text = options?.text;
  if (text === null || text === undefined) return { status: 'new', text: Pretty(EmptyLibrary(ctx)) };
  let value;
  try { value = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return { status: 'invalid', message: '保存データを読み取れません。' }; }
  if (!value || typeof value !== 'object' || value.version !== 3) return { status: 'unsupported', message: 'この版では扱えない形式の保存データです。保存データは変更していません。' };
  try { ValidateIdentityVersion(value); } catch (error) { return { status: 'unsupported', message: error.message }; }
  // identityVersionのない旧形式は、Windows版の移行（メディア識別番号の付与とバックアップ）を経ていない。曲があるときは扱わない。
  const hasEntries = Array.isArray(value.playlists) && value.playlists.some(p => Array.isArray(p?.entries) && p.entries.length > 0);
  if (!Object.hasOwn(value, 'identityVersion') && hasEntries) return { status: 'unsupported', message: 'メディア識別情報のない古い形式です。先にWindows版（v0.6.7以降）で開いて保存してください。保存データは変更していません。' };
  try {
    const playlists = ValidateLibrary(value, false, ctx.createId);
    const active = playlists.some(p => p.id === value.activePlaylistId) ? value.activePlaylistId : playlists[0].id; // Windows版のStoreと同じ
    return { status: 'ok', text: Pretty({ ...value, version: 3, identityVersion: 2, playlists, activePlaylistId: active }) };
  } catch (error) {
    // 識別・上限のエラーはWindows版も読み込みを止める（古いバックアップへ黙って戻さない）。
    if (error.identityDataInvalid || error.playlistLimitExceeded) return { status: 'unsupported', message: error.message };
    return { status: 'invalid', message: `保存データを検証できません：${error.message}` };
  }
}
// 編集操作を1つ適用する。失敗したときは { error } を返し、元のライブラリは変えない（呼び出し側は保存しない）。
function Apply(options) {
  try {
    const library = JSON.parse(options.text), ctx = Context(options), before = JSON.parse(options.text);
    if (!Actions.Apply(library, options.action, ctx)) throw new Error('対応していない操作です。');
    Tree.ValidateGraph(library.playlists, library.rootPlaylistIds);
    if (!library.playlists.some(p => p.id === library.activePlaylistId)) library.activePlaylistId = library.rootPlaylistIds[0] || library.playlists[0].id;
    // 削除（プレイリスト・曲）は、最近削除へ保管する内容を添える（保管は、保存に成功したあとに、呼び出し側が行う）。JSON文字列で返す。
    const trash = options.keepTrash === true ? Trash.Capture(before, library, options.action, ctx.now()) : null; // keepTrash を渡した呼び出し（iPhone版）だけ。共通テストデータの出力は変えない
    return trash ? { text: Pretty(library), trash: JSON.stringify(trash) } : { text: Pretty(library) };
  } catch (error) { return { error: error instanceof TypeError || error instanceof SyntaxError ? '編集を適用できません（保存データの形式が正しくありません）。' : String(error && error.message || error) }; }
}
// ---- ZIPの出力・取り込み（入れ物・暗号・ファイル操作はSwift、規則はlibrary-transfer.cjs）
const Text = value => String(value).replace(/^\uFEFF/, '');
// 取り込み候補の検証。options：{ identity（identity.jsonの文字列またはnull）, records（playlists/*.jsonの文字列）, outerNames, innerNames }
function TransferPrepare(options) {
  try {
    for (const name of [...options.innerNames, ...options.outerNames]) if (!Transfer.SafeName(name)) throw new Error('ZIP内のファイル名が正しくありません。');
    Transfer.CheckInnerNames(options.innerNames);
    const input = Transfer.BuildShareInput(options.identity === null || options.identity === undefined ? null : JSON.parse(Text(options.identity)), options.records.map(text => JSON.parse(Text(text))));
    const prepared = Transfer.Prepare(input);
    // 端末のライブラリ（options.text）を渡されたら、すでに同じ構成のリストのIDを添える（取り込みの画面で「すでにあります」と示す）
    // 判定に失敗しても（別表記の対応が食い違うなど）、取り込みの準備そのものは止めない
    if (typeof options.text === 'string') { try { prepared.identicalIds = Transfer.IdenticalIds(JSON.parse(options.text), prepared.plan); } catch { prepared.identicalIds = []; } }
    Transfer.CheckOuterNames(prepared.plan.share, options.outerNames);
    return prepared;
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 選んだリストを取り込む。options：{ text（現在のライブラリ）, plan, ids, parentId, available, idsのプールはnewIds, now }
function TransferImport(options) {
  try {
    const library = JSON.parse(options.text), ctx = Context({ ids: options.newIds, now: options.now });
    const result = Transfer.Import({ library, plan: options.plan, ids: options.ids, parentId: options.parentId, available: options.available, skipIdentical: options.skipIdentical === true, createId: ctx.createId, cleanTitle: ctx.cleanTitle, now: ctx.now() });
    return { text: Pretty(result.library), imported: result.imported, skippedIdentical: result.skippedIdentical, missing: result.missing, omitted: result.omitted, files: result.files, skipped: result.skipped, activePlaylistId: result.library.activePlaylistId };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 出力の内容。options：{ text（現在のライブラリ）, mode, available }
function TransferExport(options) {
  try { return Transfer.Export({ library: JSON.parse(options.text), mode: options.mode, available: options.available }); }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// ---- 再生順（Windows版と同じQueue。端末で再生できる曲だけを渡し、再生できない曲は順番に入れない）
// 再生の道具（AVPlayerなど）は端末側。ここは「次に何を再生するか」だけを決める。シャッフルの重み（再生回数）はWindows版のみ（iPhone版は均等）。
function Rng(seed) { // テスト用の決定的な乱数（mulberry32）
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let queue = new Queue();
function PlayableEntries(options) {
  const library = JSON.parse(options.text), playable = new Set(options.playable || []);
  // entryIds：自動リスト（よく聴く曲など）の再生。リストの曲のID（順番どおり）を直接指定する。scope は、表示用の名前（auto:…）として使う。
  if (Array.isArray(options.entryIds)) {
    const owners = new Map();
    for (const list of library.playlists || []) for (const entry of list.entries || []) if (!owners.has(entry.id)) owners.set(entry.id, { ...entry, playlistId: list.id });
    return options.entryIds.map(id => owners.get(id)).filter(entry => entry && playable.has(entry.id));
  }
  return Tree.Entries(library, options.scope).filter(entry => playable.has(entry.id));
}
// 自動リストの選び方（共通：src/core/auto-lists.cjs）。options：{ text（ライブラリのJSON）, keys, counts, limits }
// 検索（PC版の一覧と同じ規則：全角半角・大小・ひらがな/カタカナを同一視、空白区切りのAND、所属リストの経路も対象、50件ごと）。
function Search(options) {
  try {
    const result = LibrarySearch.Page(LibrarySearch.Index(JSON.parse(options.text)), String(options.query || ''), options.page);
    return { total: result.total, page: result.page, pages: result.pages, items: result.items.map(item => ({ playlistId: item.playlistId, entryId: item.entry.id, path: item.pathText })) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
function AutoLists(options) {
  try { return AutoListsCore.Select({ library: JSON.parse(options.text), keys: options.keys, counts: options.counts, limits: options.limits }); }
  catch (error) { return { error: String(error && error.message || error) }; }
}
const Found = (entries, id) => { const entry = entries.find(e => e.id === id); return { id: id || null, playlistId: entry ? entry.playlistId : null }; };
function QueueApply(target, options) {
  const entries = PlayableEntries(options);
  // randomStart：シャッフル再生で、最初の曲もランダムに選ぶ（entryIdを指定しない。重みがあれば、重みに従う）
  const id = options.randomStart ? target.ShuffleStart(options.scope, entries) : target.Start(options.scope, entries, options.entryId, options.shuffle);
  return id === null ? { id: null, playlistId: null } : Found(entries, id);
}
// ライブラリの変更を再生順へ反映する（Windows版の SyncPlayingQueue と同じ規則）。
//   現在の曲が再生範囲に残っている → 通常の同期。範囲からは外れたが自分のリスト（ownScope）にはある → 自分のリストで組み直す（全体再生を除く）。
//   曲そのもの（またはメディア）がなくなった → 再生を止める（stopped）。
function QueueSyncState(target, sync) {
  let entries = PlayableEntries(sync);
  if (entries.some(e => e.id === sync.entryId)) { target.Sync(sync.scope, entries, sync.entryId, sync.shuffle); return { entries, stopped: false }; }
  if (sync.scope !== '*' && sync.ownScope) {
    const own = PlayableEntries({ ...sync, scope: sync.ownScope });
    if (own.some(e => e.id === sync.entryId)) { target.Start(sync.ownScope, own, sync.entryId, sync.shuffle); return { entries: own, stopped: false }; }
  }
  target.Clear();
  return { entries: [], stopped: true };
}
// 再生を始める。entryIdが再生できる曲の中にないとき（メディアがない等）は { id: null }。
function QueueStart(options) {
  try {
    // weights：{ 曲のID: 重み }（再生回数が少ない曲を優先するとき。なければ均等）。重みの計算（1/(1+回数)）は、共通の Ledger.Weight
    const weights = options.weights && typeof options.weights === 'object' ? options.weights : null;
    const next = new Queue(options.seed === undefined ? null : Rng(options.seed), weights ? entry => weights[entry && entry.id] ?? 1 : null), result = QueueApply(next, options);
    if (result.id !== null) queue = next; // 失敗したときは、再生中の順番を変えない
    return result;
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// ライブラリの変更の反映だけを行う。stopped:true なら、現在の曲はもう再生できない（止める）。
function QueueSync(options) {
  try { return { stopped: QueueSyncState(queue, options).stopped }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// 前後へ。options.sync（Start と同じ形）があれば、移動の前にライブラリの変更を反映する。
function QueueMove(options) { return QueueStep(queue, options); }
function QueueStep(target, options) {
  try {
    let entries = null;
    if (options.sync) {
      const synced = QueueSyncState(target, options.sync);
      if (synced.stopped) return { id: null, playlistId: null, stopped: true };
      entries = synced.entries;
    }
    const id = target.Move(options.direction, options.repeat, options.automatic === true);
    if (id === null) return { id: null, playlistId: null };
    return { id, playlistId: entries ? Found(entries, id).playlistId : (target.catalog.get(id) || {}).playlistId || null };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 再生キューの表示：再生中の曲と、これから再生する曲（いまの周の分）。
function QueueList() {
  try { return { current: queue.index < 0 ? null : queue.ids[queue.index], upcoming: queue.Upcoming() }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// 再生キューの並べ替え：これから再生する曲の from 番目を to 番目へ。
function QueueReorder(options) {
  try { return { ok: queue.Reorder(options.from, options.to), upcoming: queue.Upcoming() }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// 再生キューの曲を選んだ：その曲へ移る。
function QueueJump(options) {
  try {
    const id = queue.JumpTo(options.id);
    return id === null ? { id: null, playlistId: null } : { id, playlistId: (queue.catalog.get(id) || {}).playlistId || null };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
function QueuePeek(options) {
  try {
    const id = queue.Peek(options.repeat, options.automatic !== false);
    return { id, upcoming: queue.Timeline(options.repeat).upcoming.slice(0, 20) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 共通テストデータ用：順番の決まった一連の操作を、専用のQueueで実行して、再生された曲のIDの並びを返す。
function QueueRun(spec) {
  const own = new Queue(Rng(spec.seed || 1)), played = [];
  const first = QueueApply(own, { ...spec });
  played.push(first.id);
  for (const step of spec.steps || []) {
    if (step.sync) { const synced = QueueSyncState(own, step.sync); played.push(synced.stopped ? 'stopped' : 'synced'); continue; }
    const result = QueueStep(own, step);
    if (result.error) return result;
    played.push(result.id);
  }
  return { played };
}
// ---- 再生回数の台帳（iPhone版）。状態（台帳のJSON文字列）はSwiftが保存し、毎回ここへ渡す。数え方・合計・世代の規則は、Windows版と共通の play-ledger.cjs。
function LedgerOpen(options) {
  try {
    if (options.text) { const { ledger, dropped } = Ledger.Clean(JSON.parse(options.text)); return { text: JSON.stringify(ledger), dropped }; }
    return { text: JSON.stringify(Ledger.NewLedger(options.deviceId)), dropped: 0 };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// keys：曲のキーの配列 → { counts: { キー: 回数 } }（現在の世代の合計）と、抽選の重み（weights）
function LedgerCounts(options) {
  try {
    const totals = Ledger.Totals(JSON.parse(options.text)), counts = {}, weights = {}, favorites = new Set(Array.isArray(options.favorites) ? options.favorites : []);
    // favorites：お気に入りの曲のキー（任意）。お気に入りは、重みに倍率が掛かる（共通：play-ledger.cjs）
    for (const key of options.keys || []) { const n = totals.get(key) || 0; counts[key] = n; weights[key] = Ledger.WeightOf(n, favorites.has(key)); }
    return { counts, weights };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
function LedgerIncrement(options) {
  try { const ledger = JSON.parse(options.text), row = Ledger.Increment(ledger, options.key, options.now); return { text: JSON.stringify(ledger), row }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}
function LedgerReset(options) {
  try { const ledger = JSON.parse(options.text), epoch = Ledger.Reset(ledger); return { text: JSON.stringify(ledger), epoch }; }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// 同期から受け取った行・世代・読み取り位置を取り込む。changed：台帳が変わったか
function LedgerMerge(options) {
  try {
    const ledger = JSON.parse(options.text);
    const changed = Ledger.MergeRows(ledger, options.rows || []) + (options.epoch !== undefined && Ledger.MergeEpoch(ledger, options.epoch) ? 1 : 0);
    let moved = false;
    if (Number.isSafeInteger(options.cursor) && options.cursor > (ledger.syncCursor || 0)) { ledger.syncCursor = options.cursor; moved = true; }
    return { text: JSON.stringify(ledger), changed: changed > 0 || moved };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 同期へ送る行（Bilibiliの曲だけ）と、世代・読み取り位置・端末の識別子。
function LedgerSyncState(options) {
  try {
    const ledger = JSON.parse(options.text);
    return { deviceId: ledger.deviceId, epoch: ledger.epoch, cursor: ledger.syncCursor || 0, rows: Ledger.SyncRows(ledger).map(row => ({ id: Ledger.RowId(row.device, row.epoch, row.month, row.key), epoch: row.epoch, month: row.month, key: row.key, n: row.n })) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 再生を数える（実再生3秒で1回など。規則は共通の PlayTracker）。状態はこのモジュールに持つ。
const tracker = new Ledger.PlayTracker();
function PlayBegin(options) { tracker.Begin(options.key || '', options.now); return { ok: true }; }
function PlayObserve(options) { try { return { key: tracker.Observe(options.media, options.now) }; } catch (error) { return { error: String(error && error.message || error) }; } }
function PlayStop() { tracker.Stop(); return { ok: true }; }
// 曲の所在（ホームから、そのリストまでの階層）。Windows版の「再生中」「次に再生」の経路と同じ規則（共通のTree.Path：再生範囲を通る経路を優先し、
// なければ表示順で最初の経路）。options：{ text（ライブラリのJSON）, playlistId, scope（再生範囲のリストID。"*" はすべて） }。戻り値：{ path: [{ id, name }] }（見つからなければ空）。
function PlaylistPath(options) {
  try {
    const library = JSON.parse(options.text);
    return { path: Tree.Path(library, options.playlistId, options.scope || '*').map(list => ({ id: list.id, name: list.name })) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 端末間で曲を同じと見なすキー（SyncMediaKey：bili:<BV>:p<パート>）。保存した動画の記録は、このキーで引く（ファイル名・パスは使わない）。
function MediaKeys(options) {
  try {
    const keyOf = LibrarySyncKey(options.aliases || []);
    return { keys: (options.entries || []).map(entry => { try { return keyOf({ type: 'bilibili', url: entry.url }); } catch { return null; } }) };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
module.exports = { MediaKeys, Open, Apply, TransferPrepare, TransferImport, TransferExport, QueueStart, QueueMove, QueueSync, QueuePeek, QueueList, QueueReorder, QueueJump, QueueRun, Search, AutoLists, PlaylistPath, LedgerOpen, LedgerCounts, LedgerIncrement, LedgerReset, LedgerMerge, LedgerSyncState, PlayBegin, PlayObserve, PlayStop };
