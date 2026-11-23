'use strict';
const { test } = require('node:test');
const { readApp } = require('./support-source.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = readApp();
function FunctionSource(name) {
  const start = renderer.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return renderer.slice(start, renderer.indexOf('\n}', start) + 2);
}
test('notice appearance and dismissal immediately update video bounds and replace the old timeout', () => {
  const hidden = new Set(['hidden']), sent = [], timers = new Map(); let nextTimer = 0;
  const elements = {
    modal: { open: false },
    toast: { textContent: '', classList: { add: x => hidden.add(x), remove: x => hidden.delete(x) } },
    'player-slot': { getBoundingClientRect: () => ({ x: 100, y: 120, width: 500, height: hidden.has('hidden') ? 400 : 320 }) }
  };
  const context = { Date, $: id => elements[id], api: { bounds: b => sent.push(b) }, HasView: () => true, allListsView: false, transportMenuOpen: false, state: { settings: { thumbnailMode: false } },
    clearTimeout: id => timers.delete(id), setTimeout: (callback, delay) => { assert.equal(delay, 7000); const id = ++nextTimer; timers.set(id, callback); return id; } };
  vm.createContext(context);
  vm.runInContext(`let toastTimer; const toastLog = []; ${FunctionSource('SendBounds')} ${FunctionSource('Toast')}`, context);
  vm.runInContext('SendBounds()', context); assert.equal(sent.at(-1).height, 400);
  context.message = '外部ページは上部の「ブラウザーで開く」から開けます。';
  vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).height, 320); assert.equal(sent.at(-1).visible, true); assert.equal(elements.toast.textContent, context.message);
  const first = context.message;
  context.message = '新しい案内 中文 <img src=x>'; vm.runInContext('Toast(message)', context);
  assert.equal(timers.size, 1); assert.equal(elements.toast.textContent, `${first}\n${context.message}`, '続けて来た通知は、前のものを消さずに重ねる');
  vm.runInContext('Toast(message)', context); assert.equal(elements.toast.textContent, `${first}\n${context.message}`, '同じ内容は、1つにまとめる');
  for (const extra of ['3件目', '4件目']) { context.message = extra; vm.runInContext('Toast(message)', context); }
  assert.equal(elements.toast.textContent.split('\n').length, 3, '最大3件');
  assert.ok(elements.toast.textContent.endsWith('4件目'));
  context.message = '新しい案内 中文 <img src=x>';
  [...timers.values()][0](); assert.equal(sent.at(-1).height, 400); assert.ok(hidden.has('hidden'));
  context.state.settings.thumbnailMode = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false);
  context.state.settings.thumbnailMode = false; context.allListsView = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false);
  context.allListsView = false; context.transportMenuOpen = true; vm.runInContext('Toast(message)', context); assert.equal(sent.at(-1).visible, false); context.transportMenuOpen = false;
  context.api = undefined; vm.runInContext('Toast(message)', context);
});
