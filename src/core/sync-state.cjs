'use strict';
// 同期の状態とマージ。レコードはフィールドごとに [値, 時刻] を持ち、マージは「時刻（同値なら値の文字列）が最大のものを残す」だけ。
// このため、マージは交換可能・結合可能・冪等（同じ変更を何回、どの順で適用しても同じ結果）になる。修復（循環・孤児・上限・復旧）は保存せず、
// sync-library.cjs の Materialize が状態から毎回同じ結果として導く。
// 純粋な処理：時刻・乱数・端末APIに依存しない。
const Clock = require('./sync-clock.cjs');
const Order = require('./sync-order.cjs');

const ID = /^[a-f0-9-]{36}$/;
const KINDS = Object.freeze({ playlist: 'p', edge: 'e', track: 't', alias: 'a' });
const ROOT = 'ROOT';
const Text = max => value => typeof value === 'string' && value.length <= max;
const SCHEMA = Object.freeze({
  playlist: { name: Text(60), includeInAll: value => typeof value === 'boolean', createdAt: Text(40), born: Clock.IsHlc, deleted: value => typeof value === 'boolean' },
  edge: { order: Order.IsKey, born: Clock.IsHlc, deleted: value => typeof value === 'boolean' },
  track: { playlist: value => typeof value === 'string' && ID.test(value), order: Order.IsKey, title: Text(180), type: value => value === 'bilibili' || value === 'local', url: Text(2048), addedAt: Text(40),
    duration: value => Number.isFinite(value) && value >= 0 && value <= 604800, ext: value => typeof value === 'string' && /^\.[a-z0-9]{2,5}$/.test(value), born: Clock.IsHlc, deleted: value => typeof value === 'boolean' },
  alias: { bvid: value => typeof value === 'string' && /^BV[a-zA-Z0-9]{10}$/.test(value), born: Clock.IsHlc, deleted: value => typeof value === 'boolean' }
});
const PlaylistId = id => `p:${id}`, TrackId = id => `t:${id}`, EdgeId = (parent, child) => `e:${parent}:${child}`, AliasId = aid => `a:${aid}`;
function ParseId(id) {
  const match = /^([petas]):(.+)$/.exec(String(id));
  if (!match) throw new Error('レコードIDが正しくありません。');
  const kind = Object.keys(KINDS).find(name => KINDS[name] === match[1]);
  if (kind === 'edge') {
    const parts = /^(ROOT|[a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(match[2]);
    if (!parts) throw new Error('辺のIDが正しくありません。');
    return { kind, parent: parts[1], child: parts[2] };
  }
  if (kind === 'alias') { if (!/^[1-9]\d{0,17}$/.test(match[2])) throw new Error('対応のIDが正しくありません。'); return { kind, aid: match[2] }; }
  if (!kind || !ID.test(match[2])) throw new Error('IDの形式が正しくありません。');
  return { kind, id: match[2] };
}
const Canonical = value => Array.isArray(value) ? `[${value.map(Canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${Canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
// 外部から受け取った変更（レコードの一部）の検証。未知のフィールド・不正な値・不正な時刻は拒否する（部分的に適用しない）。
function CleanChange(change) {
  if (!change || typeof change !== 'object' || typeof change.id !== 'string' || !change.f || typeof change.f !== 'object' || Array.isArray(change.f)) throw new Error('変更の形式が正しくありません。');
  const parsed = ParseId(change.id), schema = SCHEMA[parsed.kind], fields = {};
  const names = Object.keys(change.f);
  if (!names.length || names.length > 16) throw new Error('変更のフィールド数が正しくありません。');
  for (const name of names) {
    const pair = change.f[name];
    if (!Object.hasOwn(schema, name) || !Array.isArray(pair) || pair.length !== 2 || !schema[name](pair[0]) || !Clock.IsHlc(pair[1])) throw new Error(`変更のフィールドが正しくありません: ${name}`);
    fields[name] = [pair[0], pair[1]];
  }
  return { id: change.id, f: fields };
}
function Newer(a, b) { // a が b より新しい（勝つ）か。時刻、同値なら値の文字列で決める。
  if (a[1] !== b[1]) return a[1] > b[1];
  return Canonical(a[0]) > Canonical(b[0]);
}
function NewState() { return { records: {} }; }
// 変更を状態へ取り込む（元の状態は変更しない）。戻り値の changed は、状態が実際に変わったか。
function Merge(state, changes) {
  const records = { ...state.records }; let changed = false;
  for (const raw of changes) {
    const change = CleanChange(raw), existing = records[change.id];
    let fields = existing ? existing.f : null, copied = false;
    for (const name of Object.keys(change.f)) {
      const incoming = change.f[name];
      if (fields && Object.hasOwn(fields, name) && !Newer(incoming, fields[name])) continue;
      if (!copied) { fields = { ...(fields || {}) }; copied = true; }
      fields[name] = incoming; changed = true;
    }
    if (copied) records[change.id] = { f: fields };
  }
  return { state: changed ? { records } : state, changed };
}
const Value = (record, name) => record && Object.hasOwn(record.f, name) ? record.f[name][0] : undefined;
const Stamp = (record, name) => record && Object.hasOwn(record.f, name) ? record.f[name][1] : '';
const IsLive = record => !!record && Value(record, 'deleted') !== true;
// 削除（Tombstone）の整理：削除から保持期間を過ぎたレコードを取り除く。戻り値は新しい状態と、取り除いた件数。
function Compact(state, now, retentionMs) {
  const records = {}; let removed = 0; const limit = Math.floor(now) - retentionMs;
  // 削除より後にそのリストへ置かれた生きた曲（復旧リストに救われる曲）が参照するTombstoneは、整理しない（整理すると端末によって曲が消える）。
  const pinned = new Set();
  for (const id of Object.keys(state.records)) {
    const record = state.records[id];
    if (!id.startsWith('t:') || !IsLive(record)) continue;
    const owner = Value(record, 'playlist'), target = typeof owner === 'string' ? state.records[PlaylistId(owner)] : null;
    if (target && Value(target, 'deleted') === true && Stamp(record, 'playlist') > Stamp(target, 'deleted')) pinned.add(PlaylistId(owner));
  }
  for (const id of Object.keys(state.records)) {
    const record = state.records[id];
    if (Value(record, 'deleted') === true && !pinned.has(id) && Clock.Wall(Stamp(record, 'deleted')) <= limit) { removed++; continue; }
    records[id] = record;
  }
  return { state: removed ? { records } : state, removed };
}
module.exports = { ROOT, KINDS, SCHEMA, PlaylistId, TrackId, EdgeId, AliasId, ParseId, Canonical, CleanChange, Newer, NewState, Merge, Value, Stamp, IsLive, Compact };
