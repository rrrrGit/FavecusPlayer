'use strict';
// UIコンポーネント（QueueDrag・TreeView）の統合テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { QueueDrag } = require('../src/ui/queue-drag.js');
const Tree = require('../src/ui/library-tree.js');

function dragHarness() {
  const frames = [], calls = [], marks = new Set();
  const handle = { events: {}, addEventListener(k, f) { this.events[k] = f; }, setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {} };
  const list = { scrollTop: 0, clientHeight: 300, getBoundingClientRect: () => ({ top: 0, bottom: 300, left: 0, right: 500 }) };
  const row = { classList: { add: x => marks.add(x), remove: x => marks.delete(x) } };
  const target = { dataset: { ownerId: 'p', entryId: 'b' }, classList: { add: x => marks.add(x) }, getBoundingClientRect: () => ({ top: 90, height: 60 }) };
  const drag = new QueueDrag({
    list: () => list, hit: () => target, schedule: f => frames.push(f), clear: () => {},
    start: x => calls.push(['start', x]), end: () => calls.push(['end']),
    interact: () => calls.push(['interact']), drop: (...a) => calls.push(['drop', ...a]),
  });
  drag.Bind(handle, row, { playlistId: 'p', entryId: 'a' });
  const e = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() { this.prevented = true; } });
  return { drag, handle, list, target, frames, calls, marks, e };
}

test('QueueDrag scrolls with wheel units, reorders on drop, requests confirmation for cross-playlist targets, and clears on cancel', () => {
  const h = dragHarness();
  h.handle.events.pointerdown(h.e(20, 100));
  h.handle.events.pointermove(h.e(22, 101));
  assert.equal(h.drag.Wheel({}), false);
  h.handle.events.pointermove(h.e(25, 130));
  for (const [deltaY, deltaMode] of [[30, 0], [2, 1], [1, 2]]) {
    const ev = { deltaY, deltaMode, preventDefault() { this.prevented = true; } };
    assert.equal(h.drag.Wheel(ev), true);
    assert.equal(ev.prevented, true);
  }
  assert.equal(h.list.scrollTop, 370);
  h.handle.events.pointerup(h.e(25, 130));
  assert.deepEqual(h.calls.find(x => x[0] === 'drop'), ['drop', { playlistId: 'p', entryId: 'a' }, { targetId: 'b', after: true }]);
  const top = h.list.scrollTop;
  h.frames.forEach(f => f());
  assert.equal(h.list.scrollTop, top);

  const h2 = dragHarness();
  h2.handle.events.pointerdown(h2.e(20, 100));
  h2.handle.events.pointermove(h2.e(20, 130));
  h2.target.dataset = { playlistId: 'child' };
  h2.handle.events.pointerup(h2.e(20, 130));
  assert.equal(h2.calls.at(-1)[2].playlistId, 'child');
  h2.target.dataset = { ownerId: 'another', entryId: 'x' };
  h2.handle.events.pointerdown(h2.e(20, 100));
  h2.handle.events.pointermove(h2.e(20, 130));
  h2.handle.events.pointerup(h2.e(20, 130));
  assert.equal(h2.calls.filter(x => x[0] === 'drop').length, 2);
  assert.deepEqual(h2.calls.at(-1)[2], { playlistId: 'another', targetId: 'x', after: true });
  h2.handle.events.pointerdown(h2.e(20, 100));
  h2.handle.events.pointermove(h2.e(20, 130));
  h2.handle.events.pointercancel();
  assert.equal(h2.drag.gesture, null);
  assert.equal(h2.marks.has('dragging'), false);
});

function treeHarness() {
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.events = {};
      this.classes = new Set();
      this.classList = { add: (...v) => v.forEach(x => this.classes.add(x)), remove: (...v) => v.forEach(x => this.classes.delete(x)) };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(k, fn) { this.events[k] = fn; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]);
      return all.filter(n => selector === '*' || (selector === '.tree-row' && n.className?.includes('tree-row')) || selector === n.tagName);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    getBoundingClientRect() { return { top: 0, height: 40, bottom: 400 }; }
  }
  const context = { FavecusTree: Tree, document: { createElement: tag => new Node(tag) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/ui/tree-view.js'), 'utf8'), context);
  const data = {
    rootPlaylistIds: ['a', 'd'],
    playlists: [
      { id: 'a', name: '親', entries: [], childIds: ['b'] },
      { id: 'b', name: '子', entries: [], childIds: ['c'] },
      { id: 'c', name: '孫', entries: [], childIds: [] },
      { id: 'd', name: '独立', entries: [], childIds: ['b'] },
    ],
  };
  const box = new Node('div');
  return { data, box, render: options => context.FavecusTreeView(box, data, options) };
}

test('TreeView starts with roots, expands levels, preserves collapsed selections, and mirrors shared references', () => {
  const { box, render } = treeHarness(), selected = new Set(['a']), picker = render({ checkboxes: true, selected });
  assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'd']);
  box.children[0].children.at(-1).onclick();
  assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'b', 'd']);
  const b = box.children[1].querySelector('input');
  assert.equal(b.checked, false);
  b.checked = true;
  b.onchange();
  box.children[1].children.at(-1).onclick();
  assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'b', 'c', 'd']);
  box.children.at(-1).children.at(-1).onclick();
  const duplicates = box.querySelectorAll('input').filter(i => i.value === 'b');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every(i => i.checked));
  duplicates[1].checked = false;
  duplicates[1].onchange();
  assert.ok(duplicates.every(i => !i.checked));
  box.children[2].querySelector('input').checked = true;
  box.children[2].querySelector('input').onchange();
  box.children[0].children.at(-1).onclick();
  assert.deepEqual([...picker.get()], ['a', 'c']);
});

test('TreeView keeps disabled selections uncheckable while allowing child expansion and search ancestor collapse', () => {
  const { box, render } = treeHarness(), selected = new Set(['a', 'b']);
  let blocked = true;
  const picker = render({ checkboxes: true, selected, disabled: id => blocked && id === 'a' });
  const first = box.children[0];
  assert.equal(first.querySelector('input').disabled, true);
  assert.equal(first.children.find(n => n.className === 'tree-name').disabled, true);
  first.querySelector('input').checked = true;
  first.querySelector('input').onchange();
  assert.equal(first.querySelector('input').checked, false);
  first.children.at(-1).onclick();
  assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'b', 'd']);
  assert.equal(box.children[1].querySelector('input').checked, true);
  assert.deepEqual([...picker.get()], ['b']);
  blocked = false;
  picker.render();
  assert.equal(box.children[0].querySelector('input').checked, false);

  const h2 = treeHarness(), sel2 = new Set(['c']);
  const picker2 = h2.render({ checkboxes: true, selected: sel2, query: '孫', disabled: id => id === 'a' });
  assert.deepEqual(h2.box.children.map(r => r.dataset.playlistId), ['a', 'b', 'c', 'd', 'b', 'c']);
  assert.equal(h2.box.children[0].children.at(-1).disabled, false);
  h2.box.children[0].children.at(-1).onclick();
  assert.deepEqual(h2.box.children.map(r => r.dataset.playlistId), ['a', 'd', 'b', 'c']);
  assert.deepEqual([...picker2.get()], ['c']);
  h2.box.children[0].children.at(-1).onclick();
  assert.deepEqual(h2.box.children.map(r => r.dataset.playlistId), ['a', 'b', 'c', 'd', 'b', 'c']);
  assert.equal(h2.box.children[2].querySelector('input').checked, true);
});

test('TreeView handles 999-level hierarchies and bounds cyclic input by path', () => {
  const { data, box, render } = treeHarness();
  data.rootPlaylistIds = ['n0'];
  data.playlists = Array.from({ length: 999 }, (_, n) => ({ id: `n${n}`, name: n === 998 ? '末端' : `親${n}`, entries: [], childIds: n < 998 ? [`n${n + 1}`] : [] }));
  const picker = render({ checkboxes: true, query: '末端' });
  assert.equal(box.children.length, 999);
  const input = box.children.at(-1).querySelector('input');
  input.checked = true;
  input.onchange();
  assert.deepEqual([...picker.get()], ['n998']);
  data.playlists[2].childIds = ['n1'];
  render({ checkboxes: true, expanded: new Set(['n0', 'n0/n1', 'n0/n1/n2']), count: () => 0 });
  assert.equal(box.children.length, 3);
});

test('TreeView drag handles sibling vs child drop, blocks descendant hover, and never renders stored playlist icons', () => {
  const { box, render } = treeHarness(), calls = [], drag = { value: null };
  render({ drag, onDrop: (...args) => calls.push(args), expanded: new Set(['a', 'a/b']) });
  const [a, b, c, d] = box.children;
  const event = y => ({ clientY: y, dataTransfer: { setData() {} }, preventDefault() { this.prevented = true; } });
  a.children[0].events.dragstart(event(20));
  assert.equal(drag.value.id, 'a');
  const forbidden = event(20);
  c.events.dragover(forbidden);
  assert.equal(forbidden.prevented, undefined);
  d.events.dragover(event(1));
  assert.ok(d.classes.has('drop-before'));
  d.events.drop(event(1));
  assert.equal(calls[0][2], 'before');
  b.children[0].events.dragstart(event(20));
  d.events.drop(event(20));
  assert.equal(calls[1][2], 'child');
  assert.equal(calls[1][0].id, 'b');

  const h2 = treeHarness();
  h2.data.playlists[0].icon = 'data:image/png;base64,example';
  h2.render({ icons: true });
  assert.equal(h2.box.querySelectorAll('img').length, 0);
  h2.render({ checkboxes: true });
  assert.equal(h2.box.querySelectorAll('img').length, 0);
  assert.equal(h2.data.playlists[0].icon, 'data:image/png;base64,example');
});
