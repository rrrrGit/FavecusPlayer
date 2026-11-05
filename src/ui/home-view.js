'use strict';
(function (root) {
  const tree = typeof module !== 'undefined' && module.exports ? require('./library-tree.js') : root.FavecusTree;
  const PAGE_SIZE = 24;
  function Page(data, { path = [], page = 0 } = {}) {
    const map = new Map(data.playlists.map(p => [p.id, p])), trail = [], seen = new Set();
    let ids = tree.Roots(data);
    for (const id of path) {
      if (!ids.includes(id) || !map.has(id) || seen.has(id)) break;
      const p = map.get(id); trail.push(p); seen.add(id); ids = p.childIds || [];
    }
    ids = tree.Ordered(data, [...new Set(ids)].filter(id => map.has(id) && !seen.has(id)));
    const pages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isFinite(page) ? Math.trunc(page) : 0));
    const cards = ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(id => {
      const p = map.get(id), lists = tree.RawWalk(data, [id]);
      return { id, name: p.name, icon: p.icon || null, ownCount: p.entries.length,
        count: lists.reduce((n, list) => n + list.entries.length, 0),
        childCount: new Set((p.childIds || []).filter(child => map.has(child) && child !== id && !seen.has(child))).size,
        includeInAll: p.includeInAll !== false };
    });
    return { path: trail.map(p => ({ id: p.id, name: p.name })), page, pages, total: ids.length, cards };
  }
  function Render(box, data, options) {
    const view = Page(data, options), path = view.path.map(p => p.id), doc = box.ownerDocument || document;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const button = (label, cls, action, aria = label) => {
      const n = el('button', cls, label); n.type = 'button'; n.setAttribute('aria-label', aria); n.title = aria;
      n.addEventListener('click', action); return n;
    };
    box.replaceChildren();
    const nav = el('nav', 'home-path'); nav.setAttribute('aria-label', 'ホームの階層');
    nav.append(button('ホーム', '', () => options.onNavigate([], 0)));
    const start = Math.max(0, view.path.length - 3);
    if (start) { const omitted = el('span', '', '› …'); omitted.title = view.path.slice(0, start).map(p => p.name).join(' ＞ '); nav.append(omitted); }
    for (let index = start; index < view.path.length; index++) {
      const item = view.path[index];
      nav.append(el('span', '', '›'), button(item.name, '', () => options.onNavigate(path.slice(0, index + 1), 0)));
    }
    nav.children[nav.children.length - 1].setAttribute('aria-current', 'page');
    const header = el('div', 'home-heading'), copy = el('div');
    const title = el('h1', '', view.path.at(-1)?.name || 'マイプレイリスト'); title.tabIndex = -1;
    const registered = data.playlists.reduce((n, p) => n + p.entries.length, 0);
    copy.append(title, el('p', '', `${data.playlists.length} リスト · ${registered} 曲の登録 · ${view.total} ${path.length ? '子リスト' : '最上位リスト'}`));
    const tools = el('div', 'home-tools');
    if (path.length) tools.append(button('このリストを開く', 'button secondary', () => options.onOpen(path.at(-1))));
    tools.append(button('並べ替え', 'button secondary', options.onSort), button('＋ プレイリストを作成', 'button primary', () => options.onCreate(path.at(-1) || null)));
    header.append(copy, tools); box.append(nav, header);
    const grid = el('div', 'home-grid'); grid.setAttribute('aria-label', 'プレイリストのカード');
    for (const card of view.cards) {
      const article = el('article', 'home-card'); article.dataset.playlistId = card.id;
      const open = button('', 'home-card-open', () => options.onOpen(card.id), `${card.name}を開く`);
      const image = el('img', 'home-cover'); image.src = card.icon || 'music.png'; image.alt = ''; image.loading = 'lazy'; image.draggable = false;
      image.onerror = () => { image.onerror = null; image.src = 'music.png'; };
      open.append(image, el('strong', '', card.name));
      const count = el('p', 'home-card-count', `${card.count} 曲${card.childCount ? '（子孫を含む）' : ''}`);
      count.title = `このリスト自身は${card.ownCount}曲。共有する子リストは一度だけ数えます。`;
      const actions = el('div', 'home-card-actions');
      const play = button('▶ 再生', 'button play-button', () => options.onPlay(card.id), `${card.name}を再生`); play.disabled = !card.count;
      actions.append(play);
      if (card.childCount) actions.append(button(`子リスト ${card.childCount} ›`, 'home-children', () => options.onNavigate([...path, card.id], 0), `${card.name}の子リストを表示`));
      const property = el('label', 'all-play-property'), check = el('input'); check.type = 'checkbox'; check.checked = card.includeInAll;
      check.setAttribute('aria-label', `${card.name}を全体再生に含める`);
      check.onchange = () => options.onInclude(card.id, check.checked);
      property.append(check, el('span', '', '全体再生に含める'));
      article.append(open, count, actions, property); grid.append(article);
    }
    if (!view.total) grid.append(el('p', 'home-empty', path.length ? '子プレイリストはありません。上のボタンからこのリストを開けます。' : 'プレイリストを作成すると、ここに表示されます。'));
    const pager = el('div', 'home-pager'); pager.setAttribute('aria-label', 'プレイリストのページ');
    const previous = button('← 前へ', 'button secondary', () => options.onNavigate(path, view.page - 1)); previous.disabled = view.page === 0;
    const next = button('次へ →', 'button secondary', () => options.onNavigate(path, view.page + 1)); next.disabled = view.page + 1 >= view.pages;
    const status = el('span', 'home-page-status', `${view.total ? view.page * PAGE_SIZE + 1 : 0}–${Math.min(view.total, (view.page + 1) * PAGE_SIZE)} / ${view.total} リスト · ${view.page + 1} / ${view.pages} ページ`);
    status.setAttribute('role', 'status'); pager.append(previous, status, next); box.append(grid, pager);
    return view;
  }
  const api = { PAGE_SIZE, Page, Render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FavecusHome = api;
})(globalThis);
