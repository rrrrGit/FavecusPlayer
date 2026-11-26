'use strict';
// 再生速度（段階・サイクル・保存・配線）のテスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Speed = require('../src/core/playback-speed.cjs');
const { readMain, readApp } = require('./support-source.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('speeds snap to the 7 allowed steps, wrap cleanly via Next, and format labels', () => {
  assert.deepEqual([...Speed.OPTIONS], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(Speed.Nearest(1.3), 1.25);
  assert.equal(Speed.Nearest(9), 2);
  assert.equal(Speed.Nearest(0.1), 0.5);
  for (const bad of [NaN, Infinity, 'fast', undefined, null]) assert.equal(Speed.Nearest(bad), bad === null ? 0.5 : 1, String(bad));
  assert.equal(Speed.Label(1.5), '1.5x');

  let value = 1;
  const seen = [];
  for (let i = 0; i < 7; i++) { value = Speed.Next(value); seen.push(value); }
  assert.deepEqual(seen, [1.25, 1.5, 1.75, 2, 0.5, 0.75, 1]);
});

test('SpeedStore persists atomically, rounds to steps, and falls back to 1x on broken/unknown files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'playback-speed.json');
  const store = new Speed.SpeedStore(file);
  assert.equal(store.Get(), 1);
  assert.equal(store.Set(1.5), 1.5);
  assert.equal(new Speed.SpeedStore(file).Get(), 1.5);
  assert.equal(store.Set(1.3), 1.25);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(file, '{ broken');
  assert.equal(new Speed.SpeedStore(file).Get(), 1);
  fs.writeFileSync(file, JSON.stringify({ version: 9, speed: 2 }));
  assert.equal(new Speed.SpeedStore(file).Get(), 1);
});

test('playback speed is wired across preload, main IPC, media preload, and matches iPhone steps', () => {
  const main = readMain(), app = readApp(), media = read('src/preloads/media.cjs');
  assert.match(read('src/preloads/ui.cjs'), /speed: invoke\('player:speed'\)/);
  assert.match(main, /Handle\('player:speed'/);
  assert.match(main, /type: 'rate'/);
  assert.match(main, /speed: speedStore \? speedStore\.Get\(\) : 1/);
  assert.match(media, /command\.type === 'rate'/);
  for (const type of ['loadedmetadata', 'play', 'playing']) assert.ok(media.includes(`'${type}'`), type);
  assert.match(read('ios/FavecusPlayer/Playback/PlaybackSpeed.swift'), /\[0\.5, 0\.75, 1\.0, 1\.25, 1\.5, 1\.75, 2\.0\]/);
  assert.match(app, /SPEED_OPTIONS = \[0\.5, 0\.75, 1, 1\.25, 1\.5, 1\.75, 2\]/);
});
