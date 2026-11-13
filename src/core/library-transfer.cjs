'use strict';
// プレイリストの出力・取り込みの規則（端末APIなし）。ZIPの入れ物・暗号・ファイル操作は端末側（Windows：library-archive.cjs、iPhone：Swift）が行い、
// 「どの名前を受け付けるか」「中身をどう検証し、取り込み先へどう合成するか」「何を出力するか」はここで共通にする。
// ID・名前の生成は注入（createId）。入出力はJSON文字列にしやすい形（iPhone版の入口 Prepare/Import/Export は JSON.parse 済みの引数を受ける）。
const Tree = require('../ui/library-tree.js');
const { ValidateLibrary, MAX_PLAYLISTS, MAX_ENTRIES, ValidatePlaylistCount, CleanText } = require('./library-data.cjs');
const { VideoAliases, LibraryMediaKey } = require('./library-identity.cjs');
const { ShareData, ShareMode, ReadShare } = require('./library-share.cjs');
const { PlanImportIdentity } = require('./import-identity.cjs');
const { ExportJSON } = require('./library-json.cjs');

const MAX_FILES = 60000;
// ZIP内で許可する名前（パス区切りは/、先頭の/・.・..・空要素は不可）。
function SafeName(name) {
  return /^[a-zA-Z0-9_./-]{1,200}$/.test(name) && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
}
const PLAYLIST_ENTRY = /^playlists\/[a-f0-9-]{36}\.json$/;
const ID = /^[a-f0-9-]{36}$/;
const extension = name => { const at = String(name).lastIndexOf('.'); return at < 0 ? '' : String(name).slice(at); };

// 内側のZIPの中身（identity.json と playlists/<id>.json）から、取り込み用の入力を作る。
//   identityMeta：identity.jsonの内容（なければnull）、records：各 playlists/*.json の内容。
function BuildShareInput(identityMeta, records) {
  let identity = {};
  if (identityMeta !== null && identityMeta !== undefined) {
    if (!identityMeta || !Object.hasOwn(identityMeta, 'identityVersion')) throw new Error('識別形式の情報がありません。');
    identity = { identityVersion: identityMeta.identityVersion, videoAliases: identityMeta.videoAliases, ...(Object.hasOwn(identityMeta, 'shareVersion') ? { shareVersion: identityMeta.shareVersion } : {}), ...(Object.hasOwn(identityMeta, 'exportMode') ? { exportMode: identityMeta.exportMode } : {}) };
  }
  return { version: 3, ...identity, playlists: records.map(r => r.playlist), rootPlaylistIds: records.filter(r => r.rootIndex >= 0).sort((a, b) => a.rootIndex - b.rootIndex).map(r => r.playlist.id) };
}
// 内側のZIPの名前一覧が、取り込める構成か。戻り値：playlists/*.json の名前の一覧。
function CheckInnerNames(names) {
  const records = [];
  ValidatePlaylistCount(names.length - Number(names.includes('identity.json')));
  for (const name of names) {
    if (name === 'identity.json') continue;
    if (!PLAYLIST_ENTRY.test(name)) throw new Error('プレイリストのファイル構成が正しくありません。');
    records.push(name);
  }
  return records;
}
// 外側のZIPの名前一覧と、宣言（mode・locals）の整合。
function CheckOuterNames(share, names) {
  if (share.mode === 'information' && names.some(name => name !== 'playlists.fvpa')) throw new Error('情報のみのアーカイブにメディアが含まれています。');
  if (share.mode === 'media') for (const [name, included] of share.locals) if (included !== names.includes(`media/${name}`)) throw new Error('ローカル曲の同梱情報と実体が一致しません。');
}

// 取り込み候補の検証。戻り値の plan を Import へそのまま渡す（JSON化できる）。
function Prepare(input) {
  const playlists = ValidateLibrary(input), roots = input.version === 3 ? input.rootPlaylistIds : playlists.map(p => p.id), share = ReadShare(input);
  const identity = Object.hasOwn(input, 'identityVersion') ? { identityVersion: input.identityVersion, ...(input.identityVersion === 2 ? { videoAliases: VideoAliases(input.videoAliases) } : {}) } : {};
  const skipped = input.playlists.reduce((n, p) => n + p.entries.filter(e => e?.type === 'youtube').length, 0);
  return {
    plan: { input: { version: 3, ...identity, playlists, rootPlaylistIds: roots }, share: { mode: share.mode, locals: [...share.locals] }, skipped },
    mode: share.mode, skipped,
    lists: playlists.map(p => ({ id: p.id, name: p.name, count: p.entries.length, childIds: p.childIds })), rootPlaylistIds: roots
  };
}

// 選んだリストを、既存のライブラリへ合成する（ファイル操作はしない。コピーすべきファイルを files で返す）。
//   options：{ library, plan, ids, parentId, available（ZIP内にあるメディアの元のfileName）, createId, cleanTitle }
function Import(options) {
  const { library, plan, ids, createId } = options, cleanTitle = options.cleanTitle || (value => CleanText(value));
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PLAYLISTS || ids.some(id => !plan.input.playlists.some(p => p.id === id))) throw new Error('取り込むプレイリストを選んでください。');
  const parentId = options.parentId || null;
  if (parentId && !library.playlists.some(p => p.id === parentId)) throw new Error('再生リストが見つかりません。');
  const locals = new Map(plan.share.locals), available = new Set(options.available || []);
  const selection = Tree.Selection(plan.input, ids), chosen = JSON.parse(JSON.stringify(selection.playlists)), roots = selection.rootPlaylistIds;
  let lists = ValidateLibrary({ ...plan.input, playlists: chosen, rootPlaylistIds: roots });
  const checkLimits = () => {
    ValidatePlaylistCount(library.playlists.length + lists.length);
    if ([...library.playlists, ...lists].reduce((n, p) => n + p.entries.length, 0) > MAX_ENTRIES) throw new Error('登録数の上限を超えています。');
  };
  checkLimits();
  const files = [], renamed = new Map(); let missing = 0, omitted = 0;
  const reserved = new Set(library.playlists.flatMap(p => p.entries).filter(e => e.type === 'local').map(e => e.fileName));
  for (const p of lists) for (const entry of p.entries) if (entry.type === 'local') {
    const original = entry.fileName;
    if (!renamed.has(original)) {
      let name = null;
      for (let attempt = 0; attempt < 16 && !name; attempt++) { const candidate = `${createId()}${extension(original)}`; if (!reserved.has(candidate)) name = candidate; }
      if (!name) throw new Error('衝突しないローカル曲の保存先を作成できません。');
      reserved.add(name); renamed.set(original, name);
      if (locals.get(original) === false) { if (plan.share.mode === 'information') omitted++; else missing++; }
      else if (available.has(original)) files.push({ from: original, to: name });
      else if (locals.get(original) === true) throw new Error('同梱されたローカル曲を読み取れません。');
      else missing++;
    }
    entry.fileName = renamed.get(original);
  }
  checkLimits();
  const keyOf = LibraryMediaKey(VideoAliases(library.videoAliases || []));
  const identity = PlanImportIdentity(library.playlists, lists, roots, { keyOf, createId, preserveIds: !!plan.input.identityVersion });
  lists = identity.playlists;
  const names = new Set(library.playlists.map(p => p.name));
  for (const p of lists) {
    const base = p.name; let i = 1; while (names.has(p.name)) p.name = `${base.slice(0, 42)}（取り込み${i++}）`; names.add(p.name);
    for (const e of p.entries) e.title = cleanTitle(e.title);
  }
  const next = JSON.parse(JSON.stringify(library));
  next.playlists.push(...lists);
  const parent = parentId ? next.playlists.find(p => p.id === parentId) : null;
  (parent ? parent.childIds : next.rootPlaylistIds).push(...identity.rootPlaylistIds);
  if (parent) parent.lastAddedAt = options.now || parent.lastAddedAt;
  next.activePlaylistId = identity.idMap.get(ids[0]);
  Tree.ValidateGraph(next.playlists, next.rootPlaylistIds);
  return { library: next, imported: lists.length, ancestors: selection.ancestorIds.length, missing, omitted, files, skipped: plan.skipped || 0 };
}

// 出力の内容を作る（ファイル操作はしない）。available：端末にある実体のfileName。
//   戻り値：{ identity（identity.jsonの文字列）, records: [{ name, text }], locals: [{ fileName, included }], missing, omitted }
function Export(options) {
  const mode = ShareMode({ mode: options.mode }), data = ShareData(JSON.parse(JSON.stringify(options.library)), mode), available = new Set(options.available || []);
  const locals = new Map(); let missing = 0, omitted = 0;
  for (const p of data.playlists) for (const e of p.entries) if (e.type === 'local') {
    if (!locals.has(e.fileName)) {
      let included = false;
      if (mode === 'media') { if (available.has(e.fileName)) included = true; else missing++; } else omitted++;
      locals.set(e.fileName, included);
    }
    e.mediaIncluded = locals.get(e.fileName);
  }
  return {
    identity: ExportJSON({ shareVersion: data.shareVersion, exportMode: mode, identityVersion: data.identityVersion, videoAliases: data.videoAliases }),
    records: data.playlists.map(p => ({ name: `playlists/${p.id}.json`, text: ExportJSON({ version: 3, playlist: p, rootIndex: data.rootPlaylistIds.indexOf(p.id) }) })),
    locals: [...locals].map(([fileName, included]) => ({ fileName, included })), missing, omitted
  };
}
module.exports = { MAX_FILES, SafeName, ID, BuildShareInput, CheckInnerNames, CheckOuterNames, Prepare, Import, Export };
