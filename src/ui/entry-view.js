'use strict';
// プレイリスト内の曲の「並べ替え」と「絞り込み」（v0.7.4。PC版・iPhone版で同じ規則）。表示と、そのリストを再生するときの順に使う。
// 保存されている手動の並び（ライブラリの entries の順）は変えない。ブラウザ（classic script）・Node・共通JS（iPhone）の どこでも読める。
(function (root) {
  const SORTS = ['manual', 'title', 'count-desc', 'count-asc', 'added-desc', 'added-asc', 'duration-desc', 'duration-asc', 'favorite-first'];
  const FILTERS = Object.freeze({
    favorite: ['any', 'on', 'off'],
    saved: ['any', 'saved', 'unsaved'],
    source: ['any', 'bilibili', 'local'],
    played: ['any', 'played', 'unplayed']
  });
  const DEFAULT = Object.freeze({ sort: 'manual', favorite: 'any', saved: 'any', source: 'any', played: 'any' });

  // 知らない値・足りない項目は、既定（並べ替えなし・絞り込みなし）にする。
  function Normalize(view) {
    const input = view && typeof view === 'object' ? view : {}, result = { ...DEFAULT };
    if (SORTS.includes(input.sort)) result.sort = input.sort;
    for (const key of Object.keys(FILTERS)) if (FILTERS[key].includes(input[key])) result[key] = input[key];
    return result;
  }
  function IsActive(view) { const v = Normalize(view); return v.sort !== 'manual' || Object.keys(FILTERS).some(key => v[key] !== 'any'); }
  function IsFiltering(view) { const v = Normalize(view); return Object.keys(FILTERS).some(key => v[key] !== 'any'); }

  const text = entry => String(entry.title || entry.videoId || '');
  const compareText = (a, b) => text(a).localeCompare(text(b), 'ja', { numeric: true, sensitivity: 'base' });

  // items：並べ替える対象（getEntry(item) で、曲を取り出す。既定は、曲そのもの）。
  // ctx：{ count(entry)＝再生回数, favorite(entry)＝お気に入り, saved(entry)＝この端末に保存済み }。ない関数は、0・false として扱う。
  // 返すのは、新しい配列。元の配列は変えない。同じ値の曲は、元の順を保つ。
  function Apply(items, view, ctx = {}, getEntry = item => item) {
    const v = Normalize(view);
    const count = entry => Math.max(0, Number(ctx.count?.(entry)) || 0), favorite = entry => ctx.favorite?.(entry) === true, saved = entry => ctx.saved?.(entry) === true;
    const rows = items.map((item, index) => ({ item, index, entry: getEntry(item) })).filter(({ entry }) => {
      if (v.favorite !== 'any' && favorite(entry) !== (v.favorite === 'on')) return false;
      if (v.saved !== 'any' && saved(entry) !== (v.saved === 'saved')) return false;
      if (v.source !== 'any' && (entry.type === 'local' ? 'local' : 'bilibili') !== v.source) return false;
      if (v.played !== 'any' && (count(entry) > 0) !== (v.played === 'played')) return false;
      return true;
    });
    const by = {
      title: (a, b) => compareText(a.entry, b.entry),
      'count-desc': (a, b) => count(b.entry) - count(a.entry),
      'count-asc': (a, b) => count(a.entry) - count(b.entry),
      'added-desc': (a, b) => String(b.entry.addedAt || '').localeCompare(String(a.entry.addedAt || '')),
      'added-asc': (a, b) => String(a.entry.addedAt || '').localeCompare(String(b.entry.addedAt || '')),
      // 長さが分からない曲（0）は、どちらの向きでも、最後に置く
      'duration-desc': (a, b) => (!(a.entry.duration > 0) - !(b.entry.duration > 0)) || (b.entry.duration || 0) - (a.entry.duration || 0),
      'duration-asc': (a, b) => (!(a.entry.duration > 0) - !(b.entry.duration > 0)) || (a.entry.duration || 0) - (b.entry.duration || 0),
      'favorite-first': (a, b) => Number(favorite(b.entry)) - Number(favorite(a.entry))
    }[v.sort];
    if (by) rows.sort((a, b) => by(a, b) || a.index - b.index);
    return rows.map(row => row.item);
  }

  const Labels = Object.freeze({
    sort: { manual: '保存した順', title: '曲名', 'count-desc': '再生回数が多い順', 'count-asc': '再生回数が少ない順', 'added-desc': '追加が新しい順', 'added-asc': '追加が古い順', 'duration-desc': '長い順', 'duration-asc': '短い順', 'favorite-first': 'お気に入りを先に' },
    favorite: { any: 'すべて', on: 'お気に入りだけ', off: 'お気に入り以外' },
    saved: { any: 'すべて', saved: '保存済みだけ', unsaved: '未保存だけ' },
    source: { any: 'すべて', bilibili: 'Bilibiliだけ', local: 'ローカルだけ' },
    played: { any: 'すべて', played: '再生したことがある', unplayed: '未再生だけ' }
  });

  const api = { SORTS, FILTERS, DEFAULT, Labels, Normalize, IsActive, IsFiltering, Apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FavecusEntryView = api;
})(globalThis);
