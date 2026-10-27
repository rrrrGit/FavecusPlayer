'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MediaChannel } = require('../src/core/media-channel.cjs');

test('media IPC never creates a mainFrame before ready, during frame swaps, or after renderer destruction', () => {
  const wc = new EventEmitter(), sent = [];
  let frameReads = 0, closed = false;
  wc.isDestroyed = () => closed;
  Object.defineProperty(wc, 'mainFrame', { get() { frameReads++; return {}; } });
  wc.send = (name, value) => { void wc.mainFrame; sent.push([name, value]); };
  const channel = new MediaChannel(wc);
  assert.equal(channel.Send('media:command', { type: 'volume' }), false);
  assert.equal(frameReads, 0);
  channel.Ready(); assert.equal(channel.Send('media:command', { type: 'volume', value: .2 }), true);
  for (const event of [{ isMainFrame: false }, { isMainFrame: true, isSameDocument: true }]) {
    wc.emit('did-start-navigation', event); assert.equal(channel.ready, true);
  }
  wc.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
  for (const name of ['media:command', 'media:shortcuts']) assert.equal(channel.Send(name, {}), false);
  assert.equal(frameReads, 1);
  channel.Ready(); channel.Send('media:command', { type: 'pause' });
  wc.emit('render-process-gone'); assert.equal(channel.Send('media:command', {}), false);
  channel.Ready(); closed = true; wc.emit('destroyed');
  assert.equal(channel.Ready(), false); assert.equal(channel.Send('media:command', {}), false);
  assert.equal(frameReads, 2); assert.equal(sent.length, 2);
});

test('ordinary IPC failures are reported without marking an unloaded document ready', () => {
  const wc = new EventEmitter(), errors = [];
  wc.isDestroyed = () => false; wc.send = () => { throw new Error('renderer gone'); };
  const channel = new MediaChannel(wc, { failed: error => errors.push(error.message) });
  channel.Ready(); assert.equal(channel.Send('media:command', {}), false);
  channel.Suspend(); assert.equal(channel.Send('media:command', {}), false);
  assert.deepEqual(errors, ['renderer gone']);
});
