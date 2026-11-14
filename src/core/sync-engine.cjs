'use strict';
// 同期の流れ：端末（ローカルの状態・時計・未送信の変更outbox）と、SyncRepositoryの抽象、メモリ上の実装。
// 操作はまずローカルの状態へ反映してoutboxに積み、通信できるときに送る（オフラインでも編集できる）。マージは冪等なので、送信・受信の重複や再試行は安全。
// 純粋な処理：通信・保存・時刻は注入（repositoryの実装・nowの値）。Supabaseへの接続はStep7、sync/state.jsonへの保存もStep7。
const Clock = require('./sync-clock.cjs');
const S = require('./sync-state.cjs');
const L = require('./sync-library.cjs');

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // Tombstoneの保持期間（確定：90日）
const EmptyLibrary = () => ({ version: 3, identityVersion: 2, videoAliases: [], rootPlaylistIds: [], playlists: [] });
const Records = state => Object.keys(state.records).sort().map(id => ({ id, f: state.records[id].f }));

// SyncRepository（実装が満たす契約）
//   async Push(deviceId, changes)  → { cursor }              変更を取り込む。同じ変更の再送は無害（冪等）。
//   async Pull(cursor)             → { changes, cursor }     cursor以降の変更。整理（Compact）より古いcursorには { resync: true, snapshot, cursor } を返す。
class MemorySyncRepository {
  constructor() { this.state = S.NewState(); this.log = []; this.seq = 0; this.watermark = 0; this.online = true; }
  Check() { if (!this.online) throw new Error('オフラインです。'); }
  async Push(deviceId, changes) { return this.PushNow(deviceId, changes); }
  async Pull(cursor) { return this.PullNow(cursor); }
  PushNow(deviceId, changes) {
    this.Check();
    const clean = changes.map(S.CleanChange); // 1件でも不正なら、何も取り込まない
    for (const change of clean) { const merged = S.Merge(this.state, [change]); if (merged.changed) { this.state = merged.state; this.log.push({ seq: ++this.seq, deviceId, change }); } }
    return { cursor: this.seq };
  }
  PullNow(cursor) {
    this.Check();
    if (!Number.isInteger(cursor) || cursor < this.watermark) return { resync: true, snapshot: Records(this.state), cursor: this.seq };
    return { changes: this.log.filter(entry => entry.seq > cursor).map(entry => entry.change), cursor: this.seq };
  }
  // 保持期間を過ぎたTombstoneを整理する。以後、それより古いcursorの端末は全量の再同期になる。
  Compact(now, retentionMs = RETENTION_MS) { const result = S.Compact(this.state, now, retentionMs); this.state = result.state; if (result.removed) { this.watermark = this.seq; this.log = []; } return result.removed; }
}

function NewDevice(deviceId) {
  if (!Clock.DEVICE.test(deviceId)) throw new Error('端末IDが正しくありません。');
  return { id: deviceId, clock: '', state: S.NewState(), cursor: 0, outbox: [], view: EmptyLibrary(), derivedEdges: new Set(), conflicts: [], lastView: null };
}
const Tick = (device, now) => () => (device.clock = Clock.Tick(device.clock, now, device.id));
function Observe(device, changes, now) {
  let latest = '';
  for (const change of changes) for (const name of Object.keys(change.f)) if (change.f[name][1] > latest) latest = change.f[name][1];
  if (latest && latest !== Clock.GENESIS) device.clock = Clock.Observe(device.clock, latest, now, device.id);
}
function Refresh(device, context = {}) {
  const result = L.Materialize(device.state, context);
  device.view = result.library; device.derivedEdges = new Set(result.derived.edges); device.lastView = result;
  return result;
}
// 既存のライブラリを、初期レコードとして取り込む（決定的。別の端末で同じライブラリを変換しても同じ内容になる）。送信も必要なのでoutboxへ積む。
function Initialize(device, library, now, context = {}) {
  const changes = L.FromLibrary(library);
  device.state = S.Merge(device.state, changes).state; device.outbox.push(...changes);
  Observe(device, changes, now);
  return Refresh(device, context);
}
// ローカルで編集した（編集後の全体のライブラリ）。直前の表示との差分を、変更として状態とoutboxへ。戻り値は、導いた結果（表示用）。
function Edit(device, next, now, context = {}) {
  const changes = L.Diff(device.view, next, device.state, Tick(device, now), device.derivedEdges);
  if (changes.length) { device.state = S.Merge(device.state, changes).state; device.outbox.push(...changes); }
  return Refresh(device, context);
}
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
function ValidatePulled(pulled, now) {
  const changes = (pulled.resync ? pulled.snapshot : pulled.changes).map(S.CleanChange);
  for (const change of changes) for (const name of Object.keys(change.f)) if (Clock.Wall(change.f[name][1]) > now + MAX_AHEAD_MS) throw new Error('受信した時刻が未来すぎます。');
  if (!Number.isInteger(pulled.cursor)) throw new Error('cursorが正しくありません。');
}
// 受信の取り込み。戻り値は、全量の再同期（snapshot）で置き換えたか。
function ApplyPulled(device, pulled, now) {
  let resynced = false;
  if (pulled.resync) {
    // 整理済みのTombstoneより古い端末：差分では削除済みのものが復活するおそれがあるため、全量で置き換える。未送信の変更は送らず、競合として残す（黙って上書き・復活させない）。
    const known = new Set(pulled.snapshot.map(change => change.id)), keep = [];
    for (const change of device.outbox) { if (known.has(change.id) || Object.hasOwn(change.f, 'deleted')) keep.push(change); else device.conflicts.push({ reason: 'stale', change }); }
    device.state = S.Merge(S.Merge(S.NewState(), pulled.snapshot).state, keep).state; device.outbox = keep; resynced = true;
    Observe(device, pulled.snapshot, now);
  } else {
    const merged = S.Merge(device.state, pulled.changes); device.state = merged.state; Observe(device, pulled.changes, now);
  }
  device.cursor = pulled.cursor;
  return resynced;
}
// 通信できるときの同期：受信→取り込み→未送信の送信。失敗（オフライン等）でも状態とoutboxは保持し、あとで再試行できる。
async function Sync(device, repository, now, context = {}) {
  let pulled;
  try { pulled = await repository.Pull(device.cursor); ValidatePulled(pulled, now); }
  catch (error) { return { ok: false, error: error.message }; }
  const resynced = ApplyPulled(device, pulled, now);
  try { const sent = device.outbox.length; if (sent) { await repository.Push(device.id, device.outbox.slice(0, sent)); device.outbox.splice(0, sent); } } // 送信中に積まれた編集は残す
  catch (error) { Refresh(device, context); return { ok: false, error: error.message, pulled: true, resynced }; }
  Refresh(device, context);
  return { ok: true, resynced };
}
// 同じ処理の同期版（リポジトリがPullNow・PushNowを持つ場合。共通テストデータをJavaScriptCoreで実行するために使う）。
function SyncNow(device, repository, now, context = {}) {
  let pulled;
  try { pulled = repository.PullNow(device.cursor); ValidatePulled(pulled, now); }
  catch (error) { return { ok: false, error: error.message }; }
  const resynced = ApplyPulled(device, pulled, now);
  try { if (device.outbox.length) { repository.PushNow(device.id, device.outbox); device.outbox = []; } }
  catch (error) { Refresh(device, context); return { ok: false, error: error.message, pulled: true, resynced }; }
  Refresh(device, context);
  return { ok: true, resynced };
}
module.exports = { RETENTION_MS, EmptyLibrary, Records, MemorySyncRepository, NewDevice, Initialize, Edit, Sync, SyncNow, Refresh };
