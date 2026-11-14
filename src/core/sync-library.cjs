'use strict';
// 既存のライブラリ形式（version 3 / identityVersion 2）と、同期レコードの変換。
//  FromLibrary：既存のライブラリ → 初期レコード（決定的。同じライブラリを別端末で変換しても同じレコード）
//  Diff        ：直前に表示したライブラリ → 編集後のライブラリの差分を、変更レコードにする（ローカルを先に更新し、outboxへ積む）
//  Materialize ：同期状態 → ライブラリ（循環・孤児・削除・上限の扱いは、状態から毎回同じ結果として導く。レコードとして保存しない）
// 純粋な処理：時刻（tick）・乱数に依存しない。保存形式・Store・main.cjsには触れない（接続はStep7）。
const Clock = require('./sync-clock.cjs');
const Order = require('./sync-order.cjs');
const S = require('./sync-state.cjs');
const { ParseBilibili, MEDIA_EXTENSIONS } = require('./urls.cjs');
const { VideoAliases } = require('./library-identity.cjs');

const MAX_PLAYLISTS = 999, MAX_ENTRIES = 10000;
const Less = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// ---- 決定的なID（復旧用リスト・mediaIdの既定値）。128ビットのハッシュをUUID形式にする。
function Hash128(text) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233); h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233); h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}
function DerivedId(seed) {
  const [a, b, c, d] = Hash128(seed).map(n => n.toString(16).padStart(8, '0'));
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
}
const Extension = fileName => { const at = String(fileName || '').lastIndexOf('.'); return at < 0 ? '' : String(fileName).slice(at).toLowerCase(); };

// ---- 並び順キーの割り当て：既存のキーのうち、順序が保たれる最大の部分列をそのまま残し、残りだけ新しいキーにする。
function Increasing(keys) { // keys: 文字列またはnull。nullを除いた最長の厳密な増加部分列の位置
  const tails = [], parents = new Array(keys.length).fill(-1), at = [];
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === null) continue;
    let low = 0, high = tails.length;
    while (low < high) { const middle = (low + high) >> 1; if (keys[at[middle]] < keys[i]) low = middle + 1; else high = middle; }
    if (low > 0) parents[i] = at[low - 1];
    tails[low] = keys[i]; at[low] = i;
  }
  const kept = new Set(); let cursor = at.length ? at[at.length - 1] : -1;
  while (cursor >= 0) { kept.add(cursor); cursor = parents[cursor]; }
  return kept;
}
function AssignKeys(ids, existing) {
  const keys = ids.map(id => existing(id) ?? null), kept = Increasing(keys), result = new Array(ids.length);
  let i = 0;
  while (i < ids.length) {
    if (kept.has(i)) { result[i] = { key: keys[i], changed: false }; i++; continue; }
    let j = i; while (j < ids.length && !kept.has(j)) j++;
    const low = i > 0 ? result[i - 1].key : '', high = j < ids.length ? keys[j] : null, spread = Order.Spread(j - i, low, high);
    for (let n = i; n < j; n++) result[n] = { key: spread[n - i], changed: keys[n] !== spread[n - i] };
    i = j;
  }
  // 同じ位置への挿入を繰り返してキーが長くなりすぎたら、全体を振り直す（検証の上限128文字に達する前に）。
  if (result.some(item => item.key.length > 96)) { const spread = Order.Spread(ids.length); return ids.map((id, n) => ({ key: spread[n], changed: keys[n] !== spread[n] })); }
  return result;
}

// ---- 既存ライブラリ → レコード
function EntryFields(entry) {
  const fields = { playlist: undefined, title: entry.title || '', type: entry.type, addedAt: entry.addedAt || '' };
  if (entry.type === 'local') fields.ext = MEDIA_EXTENSIONS.has(Extension(entry.fileName)) ? Extension(entry.fileName) : '.mp3'; else fields.url = entry.url;
  if (Number.isFinite(entry.duration) && entry.duration >= 0) fields.duration = Math.min(entry.duration, 604800);
  return fields;
}
const Pair = (value, hlc) => [value, hlc];
function Make(id, fields, hlc) {
  const f = {}; for (const [name, value] of Object.entries(fields)) if (value !== undefined) f[name] = Pair(value, hlc);
  return { id, f };
}
function FromLibrary(library, hlc = Clock.GENESIS) {
  const out = [], map = new Map(library.playlists.map(p => [p.id, p]));
  for (const p of library.playlists) out.push(Make(S.PlaylistId(p.id), { name: p.name, includeInAll: p.includeInAll !== false, createdAt: p.createdAt || '', born: hlc, deleted: false }, hlc));
  const edges = (parent, children) => { const keys = Order.Spread(children.length); children.forEach((child, i) => { if (map.has(child)) out.push(Make(S.EdgeId(parent, child), { order: keys[i], born: hlc, deleted: false }, hlc)); }); };
  edges(S.ROOT, library.rootPlaylistIds || []);
  for (const p of library.playlists) edges(p.id, p.childIds || []);
  for (const p of library.playlists) {
    const keys = Order.Spread(p.entries.length);
    p.entries.forEach((entry, i) => out.push(Make(S.TrackId(entry.id), { ...EntryFields(entry), playlist: p.id, order: keys[i], born: hlc, deleted: false }, hlc)));
  }
  for (const pair of library.videoAliases || []) out.push(Make(S.AliasId(pair.aid), { bvid: pair.bvid, born: hlc, deleted: false }, hlc));
  return out;
}

// ---- 差分 → 変更レコード
function Diff(previous, next, state, tick, derivedEdges = new Set()) {
  const out = [], records = state.records;
  const change = (id, fields) => { const stamp = tick(); out.push(Make(id, fields, stamp)); return stamp; };
  const born = () => tick();
  const prevLists = new Map(previous.playlists.map(p => [p.id, p])), nextLists = new Map(next.playlists.map(p => [p.id, p]));
  for (const p of next.playlists) {
    const old = prevLists.get(p.id), id = S.PlaylistId(p.id);
    const same = (a, b) => a.length === b.length && a.every((value, n) => value === b[n]);
    const touched = old && !records[id] && (old.name !== p.name || (old.includeInAll !== false) !== (p.includeInAll !== false) || !same(old.childIds, p.childIds) || !same(old.entries.map(e => e.id), p.entries.map(e => e.id)));
    if (!old || touched) { const stamp = born(); out.push(Make(id, { name: p.name, includeInAll: p.includeInAll !== false, createdAt: p.createdAt || '', born: stamp, deleted: false }, stamp)); continue; }
    const fields = {};
    if (old.name !== p.name) fields.name = p.name;
    if ((old.includeInAll !== false) !== (p.includeInAll !== false)) fields.includeInAll = p.includeInAll !== false;
    if (Object.keys(fields).length) change(id, fields);
  }
  for (const p of previous.playlists) if (!nextLists.has(p.id)) change(S.PlaylistId(p.id), { deleted: true });
  // 辺（親→子と順序）。表示のために導いた辺（孤児のROOT付けなど）は、レコードにしない。
  const effectiveKey = (id, field) => { const record = records[id]; return S.IsLive(record) ? S.Value(record, field) : undefined; };
  const edgeDiff = (parent, before, after) => {
    const real = child => !derivedEdges.has(S.EdgeId(parent, child));
    const wanted = after.filter(real), had = new Set(before.filter(real));
    for (const child of had) if (!after.includes(child)) { const id = S.EdgeId(parent, child); if (records[id] && S.IsLive(records[id])) change(id, { deleted: true }); }
    const assigned = AssignKeys(wanted, child => effectiveKey(S.EdgeId(parent, child), 'order'));
    wanted.forEach((child, i) => {
      const id = S.EdgeId(parent, child), record = records[id], live = S.IsLive(record);
      if (live && !assigned[i].changed) return;
      if (!record) { const stamp = born(); out.push(Make(id, { order: assigned[i].key, born: stamp, deleted: false }, stamp)); }
      else change(id, live ? { order: assigned[i].key } : { order: assigned[i].key, deleted: false });
    });
  };
  edgeDiff(S.ROOT, previous.rootPlaylistIds || [], next.rootPlaylistIds || []);
  for (const p of next.playlists) edgeDiff(p.id, (prevLists.get(p.id)?.childIds) || [], p.childIds || []);
  // 登録曲
  const prevEntries = new Map(), nextEntries = new Map();
  for (const p of previous.playlists) for (const e of p.entries) prevEntries.set(e.id, { entry: e, playlist: p.id });
  for (const p of next.playlists) for (const e of p.entries) nextEntries.set(e.id, { entry: e, playlist: p.id });
  for (const [id, old] of prevEntries) if (!nextEntries.has(id) && records[S.TrackId(id)] && S.IsLive(records[S.TrackId(id)])) change(S.TrackId(id), { deleted: true });
  for (const p of next.playlists) {
    const ids = p.entries.map(e => e.id);
    const assigned = AssignKeys(ids, id => { const record = records[S.TrackId(id)]; return S.IsLive(record) && S.Value(record, 'playlist') === p.id ? S.Value(record, 'order') : undefined; });
    p.entries.forEach((entry, i) => {
      const id = S.TrackId(entry.id), record = records[id], old = prevEntries.get(entry.id);
      if (!old) {
        const stamp = born();
        out.push(Make(id, { ...EntryFields(entry), playlist: p.id, order: assigned[i].key, born: stamp, deleted: false }, stamp)); return;
      }
      const fields = {};
      if (old.playlist !== p.id) fields.playlist = p.id;
      if (assigned[i].changed || old.playlist !== p.id) fields.order = assigned[i].key;
      if ((old.entry.title || '') !== (entry.title || '')) fields.title = entry.title || '';
      if ((old.entry.duration || 0) !== (entry.duration || 0) && Number.isFinite(entry.duration) && entry.duration >= 0) fields.duration = Math.min(entry.duration, 604800);
      if (record && !S.IsLive(record)) fields.deleted = false;
      if (Object.keys(fields).length) change(id, fields);
    });
  }
  // 確認済みのav/BV対応
  const before = new Map((previous.videoAliases || []).map(pair => [pair.aid, pair.bvid])), after = new Map((next.videoAliases || []).map(pair => [pair.aid, pair.bvid]));
  for (const [aid, bvid] of after) { const id = S.AliasId(aid), record = records[id]; if (before.get(aid) !== bvid || (record && !S.IsLive(record))) { if (!record) { const stamp = born(); out.push(Make(id, { bvid, born: stamp, deleted: false }, stamp)); } else change(id, { bvid, deleted: false }); } }
  for (const aid of before.keys()) if (!after.has(aid) && records[S.AliasId(aid)] && S.IsLive(records[S.AliasId(aid)])) change(S.AliasId(aid), { deleted: true });
  return out;
}

// ---- 状態 → ライブラリ（決定的）
function Materialize(state, context = {}) {
  const maxPlaylists = context.maxPlaylists || MAX_PLAYLISTS, maxEntries = context.maxEntries || MAX_ENTRIES;
  const ids = Object.keys(state.records).sort(), at = { playlists: new Map(), edges: [], tracks: [], aliases: [] };
  for (const id of ids) {
    let parsed; try { parsed = S.ParseId(id); } catch { continue; }
    const record = state.records[id];
    if (parsed.kind === 'playlist') at.playlists.set(parsed.id, record);
    else if (parsed.kind === 'edge') at.edges.push({ id, parent: parsed.parent, child: parsed.child, record });
    else if (parsed.kind === 'track') at.tracks.push({ id: parsed.id, record });
    else at.aliases.push({ aid: parsed.aid, record });
  }
  const born = (record, fallback = 'name') => S.Value(record, 'born') || S.Stamp(record, fallback);
  // 1) 生きているリストと、上限（作成の時刻、同値ならID順で、全端末が同じ先頭N件を採用）
  const live = [...at.playlists].filter(([, record]) => S.IsLive(record) && S.Value(record, 'name') !== undefined)
    .sort((a, b) => Less(born(a[1]), born(b[1])) || Less(a[0], b[0]));
  const kept = new Map(live.slice(0, maxPlaylists)), held = { playlists: live.slice(maxPlaylists).map(([id]) => id), tracks: [] };
  // 2) 辺：両端が採用済みのリストである生きた辺だけ
  const edgeBorn = edge => S.Value(edge.record, 'born') || S.Stamp(edge.record, 'order');
  let edges = at.edges.filter(e => S.IsLive(e.record) && S.Value(e.record, 'order') !== undefined && e.parent !== e.child && kept.has(e.child) && (e.parent === S.ROOT || kept.has(e.parent)));
  // 3) 循環：循環を作る辺のうち最も新しいもの（bornが最大、同値なら辺ID）を無効にする。何度でも同じ結果になる。
  const cut = [];
  for (;;) {
    const children = new Map(); for (const e of edges) if (e.parent !== S.ROOT) { if (!children.has(e.parent)) children.set(e.parent, []); children.get(e.parent).push(e); }
    for (const list of children.values()) list.sort((a, b) => Less(a.child, b.child) || Less(a.id, b.id));
    const color = new Map(), stack = []; let found = null;
    const visit = start => {
      const frames = [{ node: start, index: 0 }]; color.set(start, 1);
      while (frames.length && !found) {
        const frame = frames[frames.length - 1], list = children.get(frame.node) || [];
        if (frame.index >= list.length) { color.set(frame.node, 2); frames.pop(); stack.pop(); continue; }
        const edge = list[frame.index++], state = color.get(edge.child);
        if (state === 1) { const from = frames.findIndex(f => f.node === edge.child); found = [...frames.slice(from + 1).map(f => f.via), edge]; }
        else if (!state) { color.set(edge.child, 1); frames.push({ node: edge.child, index: 0, via: edge }); stack.push(edge); }
      }
    };
    for (const id of [...kept.keys()].sort()) { if (!color.get(id)) { stack.length = 0; visit(id); if (found) break; } }
    if (!found) break;
    const worst = found.reduce((a, b) => (Less(edgeBorn(a), edgeBorn(b)) || Less(a.id, b.id)) > 0 ? a : b);
    cut.push(worst.id); edges = edges.filter(e => e.id !== worst.id);
  }
  // 4) 子の並び（順序キー、bornの順、子ID）と、孤児（生きた親がない）のROOT付け
  const order = (a, b) => Less(S.Value(a.record, 'order'), S.Value(b.record, 'order')) || Less(edgeBorn(a), edgeBorn(b)) || Less(a.child, b.child);
  const childIds = new Map([[S.ROOT, []]]); for (const id of kept.keys()) childIds.set(id, []);
  const hasParent = new Set();
  for (const e of [...edges].sort(order)) { childIds.get(e.parent).push(e.child); hasParent.add(e.child); }
  const derived = { edges: [], playlists: [] };
  for (const id of [...kept.keys()].sort((a, b) => Less(born(kept.get(a)), born(kept.get(b))) || Less(a, b))) if (!hasParent.has(id)) { childIds.get(S.ROOT).push(id); derived.edges.push(S.EdgeId(S.ROOT, id)); }
  // 5) 登録曲
  const rescued = new Map(), pending = [], candidates = [];
  const trackBorn = t => S.Value(t.record, 'born') || S.Stamp(t.record, 'playlist');
  for (const t of at.tracks) {
    if (!S.IsLive(t.record) || ['playlist', 'order', 'type'].some(name => S.Value(t.record, name) === undefined)) continue;
    const owner = S.Value(t.record, 'playlist'), ownerRecord = at.playlists.get(owner);
    if (kept.has(owner)) candidates.push({ ...t, owner });
    else if (held.playlists.includes(owner)) held.tracks.push(t.id);
    else if (!ownerRecord) pending.push(t.id);
    else if (!S.IsLive(ownerRecord) && S.Stamp(t.record, 'playlist') > S.Stamp(ownerRecord, 'deleted')) { if (!rescued.has(owner)) rescued.set(owner, []); rescued.get(owner).push(t); }
    // それ以外（リストの削除より前にそのリストへ置かれた曲）は、リストとともに削除済み
  }
  const recovered = []; let total = kept.size;
  for (const owner of [...rescued.keys()].sort()) {
    const recoveryId = DerivedId(`recovery:${owner}`), real = at.playlists.get(recoveryId), name = `復旧：${S.Value(at.playlists.get(owner), 'name') || '削除されたリスト'}`.slice(0, 60);
    if (real && !S.IsLive(real)) continue; // 利用者が復旧用リストを削除した：曲も戻さない
    if (kept.has(recoveryId)) { for (const t of rescued.get(owner)) candidates.push({ ...t, owner: recoveryId }); recovered.push({ playlistId: owner, recoveryId, tracks: rescued.get(owner).map(t => t.id).sort() }); continue; } // 利用者が改名などで実体にした
    if (total >= maxPlaylists) { for (const t of rescued.get(owner)) held.tracks.push(t.id); continue; }
    total++; kept.set(recoveryId, { synthetic: true, name }); childIds.set(recoveryId, []); childIds.get(S.ROOT).push(recoveryId); derived.edges.push(S.EdgeId(S.ROOT, recoveryId)); derived.playlists.push(recoveryId);
    for (const t of rescued.get(owner)) candidates.push({ ...t, owner: recoveryId });
    recovered.push({ playlistId: owner, recoveryId, tracks: rescued.get(owner).map(t => t.id).sort() });
  }
  // (1) リストが1つもなくなる（全端末が別々のリストを削除した等）と、起動時の検証が通らないため、決定的な既定のリストを導く（レコードにしない）。
  if (!kept.size) { const defaultId = DerivedId('default-list'); kept.set(defaultId, { synthetic: true, name: 'お気に入り' }); childIds.set(defaultId, []); childIds.get(S.ROOT).push(defaultId); derived.edges.push(S.EdgeId(S.ROOT, defaultId)); derived.playlists.push(defaultId); }
  candidates.sort((a, b) => Less(trackBorn(a), trackBorn(b)) || Less(a.id, b.id));
  const accepted = candidates.slice(0, maxEntries); for (const t of candidates.slice(maxEntries)) held.tracks.push(t.id);
  // 6) 確認済みのav/BV対応：矛盾する対応は、bornの古い方を採用して、新しい方を使わない
  const aliases = [];
  for (const a of at.aliases.filter(x => S.IsLive(x.record) && S.Value(x.record, 'bvid')).sort((x, y) => Less(S.Value(x.record, 'born') || '', S.Value(y.record, 'born') || '') || Less(x.aid, y.aid))) {
    const pair = { aid: a.aid, bvid: S.Value(a.record, 'bvid') };
    try { VideoAliases([...aliases, pair]); aliases.push(pair); } catch { /* 矛盾する対応は使わない */ }
  }
  // 照合キー（LibraryMediaKeyと同じ値）。検証済みのvideoId/partから直接作り、URLを何度も解析しない（約1万件で数倍速い。同じ値になることはテストで確認する）。
  const aliasOf = new Map(); for (const pair of aliases) { aliasOf.set(`av${pair.aid}`, pair.bvid); aliasOf.set(pair.bvid, pair.bvid); }
  const keyOf = entry => entry.type === 'local' ? `local:${entry.fileName}` : `bilibili:https://www.bilibili.com/video/${aliasOf.get(entry.videoId) || entry.videoId}/${entry.part > 1 ? `?p=${entry.part}` : ''}`;
  const entriesOf = new Map([...kept.keys()].map(id => [id, []]));
  const skipped = [];
  for (const t of accepted) {
    const type = S.Value(t.record, 'type'), base = { id: t.id, title: S.Value(t.record, 'title') || '', addedAt: S.Value(t.record, 'addedAt') || '' };
    const duration = S.Value(t.record, 'duration'); if (Number.isFinite(duration) && duration > 0) base.duration = duration;
    let entry;
    if (type === 'bilibili') { let video; try { video = ParseBilibili(S.Value(t.record, 'url')); } catch { skipped.push(t.id); continue; } entry = { ...base, ...video }; }
    else {
      const ext = S.Value(t.record, 'ext'), wanted = MEDIA_EXTENSIONS.has(ext) ? ext : '.mp3';
      // 端末のファイル名は同期しない。この端末に実体がなければ、IDから導いた参照（未充足）にする。
      entry = { ...base, type: 'local', fileName: context.localFileName?.(t.id, wanted) || `${t.id}${wanted}` };
    }
    entry.mediaId = (context.mediaIdFor || (key => DerivedId(`media:${key}`)))(keyOf(entry));
    entriesOf.get(t.owner).push({ entry, order: S.Value(t.record, 'order'), born: trackBorn(t) });
  }
  const playlists = [...kept].map(([id, record]) => {
    const synthetic = record.synthetic === true, entries = entriesOf.get(id).sort((a, b) => Less(a.order, b.order) || Less(a.born, b.born) || Less(a.entry.id, b.entry.id)).map(x => x.entry);
    return { id, name: synthetic ? record.name : (S.Value(record, 'name') || '無題のリスト'), icon: '', entries, childIds: childIds.get(id), createdAt: synthetic ? '' : (S.Value(record, 'createdAt') || ''), lastAddedAt: '', includeInAll: synthetic ? true : S.Value(record, 'includeInAll') !== false };
  }).sort((a, b) => Less(a.id, b.id));
  return { library: { version: 3, identityVersion: 2, videoAliases: aliases, rootPlaylistIds: childIds.get(S.ROOT), playlists },
    held: { playlists: held.playlists.sort(), tracks: held.tracks.sort() }, pending: pending.sort(), recovered, derived, cut: cut.sort(), skipped: skipped.sort() };
}
module.exports = { MAX_PLAYLISTS, MAX_ENTRIES, DerivedId, AssignKeys, FromLibrary, Diff, Materialize };
