'use strict';
(function (root) {
  function Roots(data) {
    const children = new Set(data.playlists.flatMap(p => p.childIds || []));
    return (data.rootPlaylistIds || data.playlists.map(p => p.id)).filter(id => !children.has(id));
  }
  const SortModes = ['manual', 'name', 'count-desc', 'count-asc', 'added', 'created-desc', 'created-asc'];
  const Normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const Matches = (value, query) => Normalize(value).includes(Normalize(query).trim());
  function RawWalk(data, start) {
    const map = new Map(data.playlists.map(p => [p.id, p])), result = [], seen = new Set();
    const visit = id => { const p = map.get(id); if (!p || seen.has(id)) return; seen.add(id); result.push(p); for (const child of p.childIds || []) visit(child); };
    for (const id of start) visit(id); return result;
  }
  function Ordered(data, ids, mode = data.settings?.playlistSort || 'manual') {
    if (mode === 'manual') return [...ids];
    const map = new Map(data.playlists.map((p, index) => [p.id, { p, index }])), collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    const number = date => Date.parse(date) || 0, category = name => /^\d/.test(name) ? 0 : /^[a-z]/.test(name) ? 1 : /^[ぁ-ん]/.test(name) ? 2 : 3;
    const stats = id => { const lists = RawWalk(data, [id]); return { count: lists.reduce((n, p) => n + p.entries.length, 0), added: Math.max(0, ...lists.flatMap(p => [number(p.lastAddedAt), ...p.entries.map(e => number(e.addedAt))])) }; };
    const cache = new Map(mode.startsWith('count') || mode === 'added' ? ids.map(id => [id, stats(id)]) : []);
    return [...ids].sort((a, b) => {
      const x = map.get(a), y = map.get(b); if (!x || !y) return 0;
      if (mode === 'name') { const n = Normalize(x.p.name), m = Normalize(y.p.name); return category(n) - category(m) || collator.compare(n, m) || x.index - y.index; }
      if (mode.startsWith('count')) return (cache.get(a).count - cache.get(b).count) * (mode === 'count-desc' ? -1 : 1) || x.index - y.index;
      if (mode === 'added') return cache.get(b).added - cache.get(a).added || x.index - y.index;
      return (number(x.p.createdAt) - number(y.p.createdAt) || x.index - y.index) * (mode === 'created-desc' ? -1 : 1);
    });
  }
  function Walk(data, start = Roots(data), eligible = false) {
    const map = new Map(data.playlists.map(p => [p.id, p])), seen = new Set(), result = [];
    const visit = id => { if (seen.has(id) || !map.has(id)) return; const p = map.get(id); if (eligible && p.includeInAll === false) return; seen.add(id); result.push(p); for (const child of Ordered(data, p.childIds || [])) visit(child); };
    for (const id of Ordered(data, start)) visit(id);
    return result;
  }
  function ExpandTo(data, target, expanded) {
    const map = new Map(data.playlists.map(p => [p.id, p]));
    const visit = (id, path, seen) => {
      if (id === target) return true;
      if (seen.has(id)) return false; seen.add(id);
      for (const child of map.get(id)?.childIds || []) if (visit(child, `${path}/${child}`, seen)) { expanded.add(path); return true; }
      return false;
    };
    for (const id of Roots(data)) if (visit(id, id, new Set())) break;
  }
  function AllLists(data) {
    if (data.settings?.playlistSort && data.settings.playlistSort !== 'manual') return Ordered(data, data.playlists.map(p => p.id));
    const ids = Walk(data).map(p => p.id), seen = new Set(ids);
    return [...ids, ...data.playlists.filter(p => !seen.has(p.id)).map(p => p.id)];
  }
  function Path(data, target, scope = '*') {
    const map = new Map(data.playlists.map(p => [p.id, p]));
    const find = (starts, end) => {
      const seen = new Set();
      const visit = id => {
        const p = map.get(id); if (!p || seen.has(id)) return null; seen.add(id);
        if (id === end) return [p];
        for (const child of p.childIds || []) { const path = visit(child); if (path) return [p, ...path]; }
        return null;
      };
      for (const id of starts) { const path = visit(id); if (path) return path; }
      return null;
    };
    if (scope && scope !== '*') {
      const prefix = find(Roots(data), scope), suffix = find([scope], target);
      if (prefix && suffix) return [...prefix.slice(0, -1), ...suffix];
    }
    return find(Roots(data), target) || [];
  }
  function CanParent(data, id, parentId) { return !parentId || (id !== parentId && !Walk(data, [id]).some(p => p.id === parentId)); }
  function Entries(data, scope) {
    const all = scope === '*', seen = new Set(), entries = [];
    for (const p of Walk(data, all ? Roots(data) : [scope], all)) for (const entry of p.entries) {
      const key = entry.type === 'local' ? `local:${entry.fileName}` : entry.url;
      if (all && seen.has(key)) continue;
      seen.add(key); entries.push({ ...entry, playlistId: p.id });
    }
    return entries;
  }
  function Rows(data, scope, expanded = new Set(), query = '') {
    const map = new Map(data.playlists.map(p => [p.id, p]));
    const songs = (p, depth) => p.entries.map((entry, index) => ({ entry: { ...entry, playlistId: p.id }, index, depth }))
      .filter(({ entry }) => Matches(`${entry.title || entry.videoId || 'ローカルファイル'} ${entry.url || ''}`, query));
    const visit = (id, depth, path, ancestors) => {
      const p = map.get(id); if (!p || ancestors.has(id)) return [];
      const open = !!query || expanded.has(path), descendants = [];
      if (open) {
        const next = new Set([...ancestors, id]);
        for (const child of Ordered(data, p.childIds || [])) descendants.push(...visit(child, depth + 1, `${path}/${child}`, next));
        descendants.push(...songs(p, depth + 1));
      }
      if (query && !Matches(p.name, query) && !descendants.length) return [];
      return [{ playlist: p, depth, path, expanded: open }, ...descendants];
    };
    const list = map.get(scope), rows = [];
    for (const id of Ordered(data, scope === '*' ? Roots(data) : list?.childIds || [])) rows.push(...visit(id, 0, `${scope}/${id}`, new Set()));
    if (list) rows.push(...songs(list, 0));
    return rows;
  }
  const Parent = (data, id) => Path(data, id).at(-2)?.id || null;
  function Selection(data, ids) {
    const content = new Set(RawWalk(data, ids).map(p => p.id)), included = new Set(content), parents = new Map();
    for (const p of data.playlists) for (const child of p.childIds || []) {
      const owners = parents.get(child) || []; owners.push(p.id); parents.set(child, owners);
    }
    // 子だけを選んでも祖先を器として残し、無関係な兄弟や祖先の曲は取り込まない。
    const pending = [...content];
    while (pending.length) for (const parent of parents.get(pending.pop()) || []) {
      if (!included.has(parent)) { included.add(parent); pending.push(parent); }
    }
    const playlists = data.playlists.filter(p => included.has(p.id)).map(p => ({ ...p,
      childIds: (p.childIds || []).filter(id => included.has(id)), entries: content.has(p.id) ? p.entries : [] }));
    return { playlists, rootPlaylistIds: Roots(data).filter(id => included.has(id)),
      contentIds: [...content], ancestorIds: playlists.filter(p => !content.has(p.id)).map(p => p.id) };
  }
  function ValidateGraph(playlists, roots) {
    const map = new Map(playlists.map(p => [p.id, p])), done = new Set(), stack = new Set();
    function visit(id) {
      if (!map.has(id)) throw new Error('存在しないプレイリストへの参照があります。');
      if (stack.has(id)) throw new Error('自分自身や子孫を親にはできません。');
      if (done.has(id)) return;
      stack.add(id); const children = map.get(id).childIds || [];
      if (!Array.isArray(children) || new Set(children).size !== children.length) throw new Error('子プレイリストの指定が正しくありません。');
      for (const child of children) visit(child);
      stack.delete(id); done.add(id);
    }
    if (!Array.isArray(roots) || !roots.length || new Set(roots).size !== roots.length) throw new Error('最上位プレイリストの指定が正しくありません。');
    for (const id of roots) visit(id);
    if (done.size !== playlists.length) throw new Error('表示できないプレイリストが含まれています。');
  }
  const api = { Roots, Walk, RawWalk, Ordered, AllLists, SortModes, Normalize, Matches, ExpandTo, Path, CanParent, Entries, Rows, Parent, Selection, ValidateGraph };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FavecusTree = api;
})(globalThis);
