'use strict';
(function (root) {
  const tree = typeof module !== 'undefined' && module.exports ? require('./library-tree.js') : root.FavecusTree;
  const PAGE_SIZE = 50;
  function Index(data) {
    const map = new Map(data.playlists.map(p => [p.id, p])), visited = new Set(), records = [];
    const pending = tree.Roots(data).reverse().map(id => ({ id, parent: null }));
    function visit() {
      while (pending.length) {
        const route = pending.pop(), p = map.get(route.id); if (!p || visited.has(p.id)) continue;
        visited.add(p.id); route.name = p.name;
        if (p.entries.length) {
          const path = []; for (let link = route; link; link = link.parent) path.push(link.name);
          const pathText = ['ホーム', ...path.reverse()].join(' ＞ '), pathSearch = tree.Normalize(pathText);
          for (const entry of p.entries) records.push({ playlistId: p.id, playlistName: p.name, entry, pathText, pathSearch,
            text: tree.Normalize(`${entry.title || entry.videoId || 'ローカルファイル'} ${entry.videoId || ''} ${entry.url || ''} P${entry.part || 1}`) });
        }
        for (const id of [...(p.childIds || [])].reverse()) pending.push({ id, parent: route });
      }
    }
    visit();
    for (const p of data.playlists) if (!visited.has(p.id)) { pending.push({ id: p.id, parent: null }); visit(); }
    return { records };
  }
  function Page(index, query, page = 0) {
    const terms = tree.Normalize(query).trim().split(/\s+/).filter(Boolean);
    const matches = terms.length ? index.records.filter(item => terms.every(term => item.text.includes(term) || item.pathSearch.includes(term))) : [];
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isFinite(page) ? Math.trunc(page) : 0));
    return { total: matches.length, page, pages, items: matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
  }
  const api = { PAGE_SIZE, Index, Page };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FavecusSearch = api;
})(globalThis);
