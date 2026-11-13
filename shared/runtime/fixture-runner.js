'use strict';
// 共通テストデータ（shared/fixtures/cases.json）の実行器。NodeでもiOSのJavaScriptCoreでも同じものを実行する。
// 入出力はJSON文字列のみ。端末APIには依存しない。
const urls = require('../core/urls.cjs');
const mediaIdentity = require('../core/media-identity.cjs');
const data = require('../core/library-data.cjs');
const share = require('../core/library-share.cjs');
const importIdentity = require('../core/import-identity.cjs');
const iconData = require('../core/playlist-icon-data.cjs');
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
  ValidateIcon: value => iconData.ValidateIcon(value)
};

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
  return JSON.stringify(result);
}

module.exports = { RunCases, Observe, Bench };
