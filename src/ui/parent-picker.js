'use strict';
(function (root) {
  function ParentPicker(container, data, options = {}) {
    const tree = root.FavecusTree, map = new Map(data.playlists.map(p => [p.id, p]));
    const excluded = new Set(options.excludeId ? tree.Walk(data, [options.excludeId]).map(p => p.id) : []);
    const expanded = new Set(); let selected = options.selected || null, query = '', beforeSearch = null, matches = [], matchIndex = 0;
    let rows = [], names = new Map(), arrows = new Map();
    function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
    function button(text, cls, click) { const b = node('button', cls, text); b.type = 'button'; b.onclick = click; return b; }
    const normal = text => text.normalize('NFKC').toLocaleLowerCase().trim();
    const searchLabel = node('label', 'parent-search-label', options.label || '親プレイリストを検索');
    const search = node('input', 'parent-search'); search.type = 'search'; search.placeholder = 'プレイリスト名を入力'; searchLabel.append(search);
    const tools = node('div', 'parent-search-tools'), status = node('span', 'parent-search-status'); status.setAttribute('role', 'status');
    const previous = button('↑', 'icon-button', () => jump(-1)), next = button('↓', 'icon-button', () => jump(1));
    previous.setAttribute('aria-label', '前の検索結果へ'); next.setAttribute('aria-label', '次の検索結果へ'); tools.append(status, previous, next);
    const selection = node('p', 'parent-selection'); selection.setAttribute('role', 'status');
    const rootLabel = options.rootLabel || '最上位（親なし）';
    const top = button(rootLabel, 'parent-root', () => choose(null));
    const choices = node('div', 'parent-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', options.label || '親プレイリストの階層');
    top.hidden = options.allowRoot === false;
    container.classList.add('parent-picker'); container.replaceChildren(searchLabel, tools, selection, top, choices);
    function reveal(id) { tree.ExpandTo(data, id, expanded); }
    function scrollTo(id) {
      const row = rows.find(r => r.dataset.playlistId === id); if (!row) return;
      const bounds = choices.getBoundingClientRect(), item = row.getBoundingClientRect();
      // Scroll only this picker; never move the modal or the playing queue behind it.
      choices.scrollTop += item.top - bounds.top - Math.max(0, (choices.clientHeight - item.height) / 2);
    }
    function choose(id, path) {
      if (!id && options.allowRoot === false) return;
      if (id && (!map.has(id) || excluded.has(id))) return;
      selected = id; render(); options.onChange?.(selected); (id ? names.get(path) : top)?.focus({ preventScroll: true });
    }
    function render() {
      choices.replaceChildren(); rows = []; names = new Map(); arrows = new Map();
      const highlighted = new Set(matches), focusId = matches[matchIndex];
      const label = selected ? tree.Path(data, selected).map(p => p.name).join('/') : rootLabel;
      selection.textContent = `選択中：${label}`; selection.title = label; top.setAttribute('aria-pressed', String(!selected));
      status.textContent = query ? (matches.length ? `${matchIndex + 1} / ${matches.length}件` : '該当するプレイリストはありません') : '矢印で子プレイリストを開けます';
      previous.disabled = next.disabled = matches.length < 2;
      const visit = (id, path, depth, ancestors) => {
        const p = map.get(id); if (!p || ancestors.has(id)) return;
        const row = node('div', 'parent-row'); row.dataset.playlistId = id; row.dataset.path = path; row.style.paddingLeft = `${Math.min(depth * 18, 180)}px`;
        row.classList.toggle('selected', selected === id); row.classList.toggle('search-match', highlighted.has(id)); row.classList.toggle('search-current', id === focusId);
        const children = p.childIds || [], open = expanded.has(path);
        const arrow = button(open ? '⌄' : '›', 'tree-expand', () => { open ? expanded.delete(path) : expanded.add(path); render(); arrows.get(path)?.focus({ preventScroll: true }); });
        arrow.disabled = !children.length; arrow.setAttribute('aria-expanded', String(open)); arrow.setAttribute('aria-label', `${p.name}の子プレイリストを${open ? '閉じる' : '開く'}`);
        const name = button(p.name, 'parent-name', () => choose(id, path)); name.title = path.split('/').map(part => map.get(part)?.name || '').join('/'); name.setAttribute('aria-pressed', String(selected === id));
        name.disabled = excluded.has(id); row.append(arrow, name);
        if (name.disabled) row.append(node('span', 'selection-unavailable', '選択不可'));
        choices.append(row); rows.push(row); names.set(path, name); arrows.set(path, arrow);
        if (open) for (const child of children) visit(child, `${path}/${child}`, depth + 1, new Set([...ancestors, id]));
      };
      for (const id of tree.Roots(data)) visit(id, id, 0, new Set());
    }
    function jump(step) {
      if (!matches.length) return;
      matchIndex = (matchIndex + step + matches.length) % matches.length; reveal(matches[matchIndex]); render(); scrollTo(matches[matchIndex]);
    }
    search.oninput = () => {
      const value = normal(search.value);
      if (value && !query) beforeSearch = new Set(expanded);
      if (beforeSearch) { expanded.clear(); for (const path of beforeSearch) expanded.add(path); }
      query = value; matchIndex = 0;
      matches = query ? tree.Walk(data).filter(p => normal(p.name).includes(query)).map(p => p.id) : [];
      for (const id of matches) reveal(id);
      if (!query) beforeSearch = null;
      render(); if (matches.length) scrollTo(matches[0]);
    };
    search.onkeydown = event => {
      if (event.isComposing || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); jump(event.key === 'ArrowUp' || event.shiftKey ? -1 : 1);
    };
    if (!map.has(selected) || excluded.has(selected)) selected = null;
    if (options.excludeId) reveal(options.excludeId);
    if (selected) reveal(selected);
    render(); if (selected) scrollTo(selected);
    return { get: () => selected };
  }
  root.FavecusParentPicker = ParentPicker;
})(globalThis);
