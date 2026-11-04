'use strict';
(function (root) {
  function TreeView(container, data, options = {}) {
    const tree = root.FavecusTree, expanded = options.expanded || new Set(), selected = options.selected || new Set();
    const map = new Map(data.playlists.map(p => [p.id, p])), searchCollapsed = new Set(); let visible = [], arrows = new Map();
    function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
    function button(label, cls, click) { const b = node('button', cls, label); b.type = 'button'; b.onclick = click; return b; }
    function capture() { for (const input of container.querySelectorAll('input')) input.checked && !input.disabled ? selected.add(input.value) : selected.delete(input.value); }
    function render() {
      capture(); for (const id of selected) if (options.disabled?.(id)) selected.delete(id);
      container.replaceChildren(); visible = []; arrows = new Map();
      function visit(id, parentId, depth, path) {
        const p = map.get(id); if (!p || visible.length >= 2000 || depth > 100) return;
        const query = options.query?.trim() || '';
        if (query && !tree.RawWalk(data, [id]).some(q => !options.hidden?.(q.id) && tree.Matches(q.name, query))) return;
        if (options.hidden?.(id)) { selected.delete(id); for (const child of p.childIds || []) visit(child, id, depth, `${path}/${child}`); return; }
        visible.push(id);
        const row = node('div', `tree-row${options.activeId === id ? ' selected' : ''}`); row.dataset.playlistId = id; row.dataset.parentId = parentId || ''; row.dataset.path = path; row.style.paddingLeft = `${Math.min(depth * 16, 160)}px`;
        if (query && tree.Matches(p.name, query)) row.classList.add('search-match');
        if (options.checkboxes) {
          const input = node('input'); input.type = 'checkbox'; input.value = id; input.checked = selected.has(id); input.disabled = options.disabled?.(id) || false;
          input.setAttribute('aria-label', `${p.name}を選択`); input.onchange = () => {
            if (input.disabled) { input.checked = false; return; }
            if (options.selectChildren) {
              for (const child of tree.RawWalk(data, [id])) input.checked && !options.disabled?.(child.id) ? selected.add(child.id) : selected.delete(child.id);
              if (!input.checked) for (const parent of data.playlists) if (tree.RawWalk(data, [parent.id]).some(child => child.id === id)) selected.delete(parent.id);
              for (const other of container.querySelectorAll('input')) other.checked = selected.has(other.value);
            } else { input.checked ? selected.add(id) : selected.delete(id); for (const other of container.querySelectorAll('input')) if (other.value === id) other.checked = input.checked; }
            options.onChange?.(selected);
          }; row.append(input);
        } else if (options.onDrop) {
          const handle = button('≡', 'tree-handle', () => {}); handle.draggable = true; handle.title = 'ドラッグで並べ替え'; handle.setAttribute('aria-label', `${p.name}を並べ替え`);
          handle.addEventListener('dragstart', event => { options.drag.value = { id, parentId }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); row.classList.add('dragging'); });
          handle.addEventListener('dragend', () => { options.drag.value = null; clearMarks(); });
          handle.addEventListener('keydown', event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault();
            const siblings = parentId ? map.get(parentId).childIds : tree.Roots(data), at = siblings.indexOf(id), target = siblings[at + (event.key === 'ArrowUp' ? -1 : 1)];
            if (target) options.onDrop({ id, parentId }, target, event.key === 'ArrowUp' ? 'before' : 'after', parentId);
          }); row.append(handle);
        }
        const name = button(p.name, 'tree-name', () => options.onSelect?.(id)); name.title = p.name;
        if (options.checkboxes) { name.disabled = row.querySelector('input').disabled; name.onclick = () => { const input = row.querySelector('input'); if (input.disabled) return; input.checked = !input.checked; input.onchange(); }; }
        row.append(name);
        if (name.disabled) row.append(node('span', 'selection-unavailable', '選択不可'));
        if (options.icons && p.icon) { const icon = node('img', 'playlist-icon'); icon.src = p.icon; icon.alt = ''; icon.draggable = false; row.append(icon); }
        row.append(node('span', 'count', options.count ? options.count(p) : tree.Entries(data, id).length));
        const children = tree.Ordered(data, p.childIds || []), open = query ? !searchCollapsed.has(path) : expanded.has(path), arrow = button(open ? '⌄' : '›', 'tree-expand', () => {
          if (query) open ? searchCollapsed.add(path) : searchCollapsed.delete(path);
          else open ? expanded.delete(path) : expanded.add(path);
          render(); arrows.get(path)?.focus?.({ preventScroll: true });
        });
        arrow.disabled = !children.length; arrow.setAttribute('aria-label', `${p.name}の子プレイリストを${open ? '閉じる' : '開く'}`); arrow.setAttribute('aria-expanded', String(open)); row.append(arrow); arrows.set(path, arrow);
        if (options.onDrop) {
          const zone = event => { const bounds = row.getBoundingClientRect(), ratio = (event.clientY - bounds.top) / bounds.height; return ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'child'; };
          row.addEventListener('dragover', event => {
            const dragged = options.drag.value; if (!dragged || dragged.id === id) return;
            const mode = zone(event); if (mode !== 'child' && dragged.parentId !== parentId) return;
            if (mode === 'child' && !tree.CanParent(data, dragged.id, id)) return;
            event.preventDefault(); clearMarks(); row.classList.add(`drop-${mode}`);
            const bounds = container.getBoundingClientRect(); if (event.clientY < bounds.top + 30) container.scrollTop -= 12; if (event.clientY > bounds.bottom - 30) container.scrollTop += 12;
          });
          row.addEventListener('drop', event => { const dragged = options.drag.value; if (!dragged || dragged.id === id) return; const mode = zone(event); if (mode !== 'child' && dragged.parentId !== parentId) return; event.preventDefault(); options.drag.value = null; clearMarks(); options.onDrop(dragged, id, mode, parentId); });
        }
        container.append(row);
        if (open) for (const child of children) visit(child, id, depth + 1, `${path}/${child}`);
      }
      for (const id of tree.Ordered(data, tree.Roots(data))) visit(id, null, 0, id);
    }
    function clearMarks() { for (const row of container.querySelectorAll('.tree-row')) row.classList.remove('drop-before', 'drop-after', 'drop-child', 'dragging'); }
    render();
    return { selected, render, get: () => { capture(); return data.playlists.filter(p => selected.has(p.id) && !options.hidden?.(p.id) && !options.disabled?.(p.id)).map(p => p.id); } };
  }
  root.FavecusTreeView = TreeView;
})(globalThis);
