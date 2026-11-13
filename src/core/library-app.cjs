'use strict';
// iPhone版（JavaScriptCore）が使うライブラリの入口。保存ファイルの読み込み判定と編集操作を、Swiftへ規則を持たせずに共通JSで行う。
// 端末APIなし。ID・時刻は呼び出し側が渡す（ids：新しいIDの予備、now：ISO文字列）。入出力はJSON文字列で扱いやすいよう、結果は { text } または { error } にそろえる。
const Actions = require('./library-actions.cjs');
const Tree = require('../ui/library-tree.js');
const { ValidateLibrary, CleanText } = require('./library-data.cjs');
const { ValidateIdentityVersion } = require('./library-identity.cjs');
const Transfer = require('./library-transfer.cjs');
const { Queue } = require('./queue.cjs');

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
    const library = JSON.parse(options.text), ctx = Context(options);
    if (!Actions.Apply(library, options.action, ctx)) throw new Error('対応していない操作です。');
    Tree.ValidateGraph(library.playlists, library.rootPlaylistIds);
    if (!library.playlists.some(p => p.id === library.activePlaylistId)) library.activePlaylistId = library.rootPlaylistIds[0] || library.playlists[0].id;
    return { text: Pretty(library) };
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
    Transfer.CheckOuterNames(prepared.plan.share, options.outerNames);
    return prepared;
  } catch (error) { return { error: String(error && error.message || error) }; }
}
// 選んだリストを取り込む。options：{ text（現在のライブラリ）, plan, ids, parentId, available, idsのプールはnewIds, now }
function TransferImport(options) {
  try {
    const library = JSON.parse(options.text), ctx = Context({ ids: options.newIds, now: options.now });
    const result = Transfer.Import({ library, plan: options.plan, ids: options.ids, parentId: options.parentId, available: options.available, createId: ctx.createId, cleanTitle: ctx.cleanTitle, now: ctx.now() });
    return { text: Pretty(result.library), imported: result.imported, missing: result.missing, omitted: result.omitted, files: result.files, skipped: result.skipped, activePlaylistId: result.library.activePlaylistId };
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
  return Tree.Entries(library, options.scope).filter(entry => playable.has(entry.id));
}
const Found = (entries, id) => { const entry = entries.find(e => e.id === id); return { id: id || null, playlistId: entry ? entry.playlistId : null }; };
function QueueApply(target, options) {
  const entries = PlayableEntries(options);
  const id = target.Start(options.scope, entries, options.entryId, options.shuffle);
  return id === null ? { id: null, playlistId: null } : Found(entries, id);
}
// 再生を始める。entryIdが再生できる曲の中にないとき（メディアがない等）は { id: null }。
function QueueStart(options) {
  try { queue = new Queue(options.seed === undefined ? null : Rng(options.seed)); return QueueApply(queue, options); }
  catch (error) { return { error: String(error && error.message || error) }; }
}
// 前後へ。options.sync（Start と同じ形）があれば、移動の前にライブラリの変更を反映する。
function QueueMove(options) { return QueueStep(queue, options); }
function QueueStep(target, options) {
  try {
    let entries = null;
    if (options.sync) { entries = PlayableEntries(options.sync); target.Sync(options.sync.scope, entries, options.sync.entryId, options.sync.shuffle); }
    const id = target.Move(options.direction, options.repeat, options.automatic === true);
    if (id === null) return { id: null, playlistId: null };
    return { id, playlistId: entries ? Found(entries, id).playlistId : (target.catalog.get(id) || {}).playlistId || null };
  } catch (error) { return { error: String(error && error.message || error) }; }
}
function QueuePeek(options) {
  const id = queue.Peek(options.repeat, options.automatic !== false);
  return { id, upcoming: queue.Timeline(options.repeat).upcoming.slice(0, 20) };
}
// 共通テストデータ用：順番の決まった一連の操作を、専用のQueueで実行して、再生された曲のIDの並びを返す。
function QueueRun(spec) {
  const own = new Queue(Rng(spec.seed || 1)), played = [];
  const first = QueueApply(own, { ...spec });
  played.push(first.id);
  for (const step of spec.steps || []) {
    if (step.sync) { const next = QueueStep(own, { direction: 0, repeat: 'off', sync: step.sync }); if (next.error) return next; continue; }
    const result = QueueStep(own, step);
    if (result.error) return result;
    played.push(result.id);
  }
  return { played };
}
module.exports = { Open, Apply, TransferPrepare, TransferImport, TransferExport, QueueStart, QueueMove, QueuePeek, QueueRun };
