'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Tree = require('../src/ui/library-tree.js');
function Harness() {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.events = {}; this.classes = new Set(); this.classList = { add: (...v) => v.forEach(x => this.classes.add(x)), remove: (...v) => v.forEach(x => this.classes.delete(x)) }; }
    append(...children) { this.children.push(...children); } replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; } addEventListener(k, fn) { this.events[k] = fn; }
    querySelectorAll(selector) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]); return all.filter(n => selector === '*' || selector === '.tree-row' && n.className?.includes('tree-row') || selector === n.tagName); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    getBoundingClientRect() { return { top: 0, height: 40, bottom: 400 }; }
  }
  const context = { FavecusTree: Tree, document: { createElement: tag => new Node(tag) } }; vm.runInNewContext(fs.readFileSync(require.resolve('../src/ui/tree-view.js'), 'utf8'), context);
  const data = { rootPlaylistIds: ['a', 'd'], playlists: [{ id: 'a', name: '親', entries: [], childIds: ['b'] }, { id: 'b', name: '子', entries: [], childIds: ['c'] }, { id: 'c', name: '孫', entries: [], childIds: [] }, { id: 'd', name: '独立', entries: [], childIds: ['b'] }] };
  const box = new Node('div'); return { data, box, render: options => context.FavecusTreeView(box, data, options) };
}
test('tree picker starts with roots, expands multiple levels, preserves collapsed choices and mirrors shared references', () => {
  const { box, render } = Harness(), selected = new Set(['a']), picker = render({ checkboxes: true, selected });
  assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'd']);
  box.children[0].children.at(-1).onclick(); assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'b', 'd']);
  const b = box.children[1].querySelector('input'); assert.equal(b.checked, false); b.checked = true; b.onchange();
  box.children[1].children.at(-1).onclick(); assert.deepEqual(box.children.map(r => r.dataset.playlistId), ['a', 'b', 'c', 'd']);
  box.children.at(-1).children.at(-1).onclick();
  const duplicates = box.querySelectorAll('input').filter(i => i.value === 'b'); assert.equal(duplicates.length, 2); assert.ok(duplicates.every(i => i.checked));
  duplicates[1].checked = false; duplicates[1].onchange(); assert.ok(duplicates.every(i => !i.checked));
  box.children[2].querySelector('input').checked = true; box.children[2].querySelector('input').onchange();
  box.children[0].children.at(-1).onclick(); assert.deepEqual([...picker.get()], ['a', 'c']);
});
test('drag handle distinguishes sibling ordering from child-drop and blocks descendant hover', () => {
  const { box, render } = Harness(), calls = [], drag = { value: null };
  render({ drag, onDrop: (...args) => calls.push(args), expanded: new Set(['a', 'a/b']) });
  const [a, b, c, d] = box.children;
  const event = y => ({ clientY: y, dataTransfer: { setData() {} }, preventDefault() { this.prevented = true; } });
  a.children[0].events.dragstart(event(20)); assert.equal(drag.value.id, 'a');
  const forbidden = event(20); c.events.dragover(forbidden); assert.equal(forbidden.prevented, undefined);
  d.events.dragover(event(1)); assert.ok(d.classes.has('drop-before')); d.events.drop(event(1)); assert.equal(calls[0][2], 'before');
  b.children[0].events.dragstart(event(20)); d.events.drop(event(20)); assert.equal(calls[1][2], 'child'); assert.equal(calls[1][0].id, 'b');
});
test('060 playlist art appears immediately before the count only when sidebar icons are enabled',()=>{
 const h=Harness();h.data.playlists[0].icon='data:image/png;base64,example';h.render({icons:true});const row=h.box.children[0],image=row.querySelector('img');assert.equal(image.src,h.data.playlists[0].icon);assert.equal(row.children[row.children.indexOf(image)+1].className,'count');assert.equal(h.box.children[1].querySelector('img'),undefined);h.render({checkboxes:true});assert.equal(h.box.querySelectorAll('img').length,0);
});
