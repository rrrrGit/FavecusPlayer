'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadJson, WriteJsonAtomic, RemoveFile } = require('../src/core/json-file.cjs');

test('ReadJson returns null for missing or malformed files and parses valid JSON', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.json');
  assert.equal(ReadJson(file), null);
  fs.writeFileSync(file, '{broken json');
  assert.equal(ReadJson(file), null);
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: ['a', 2] }));
  assert.deepEqual(ReadJson(file), { version: 1, items: ['a', 2] });
});

test('WriteJsonAtomic creates parent directories, round-trips JSON, and cleans up temp files on failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'sub', 'data.json');
  assert.equal(WriteJsonAtomic(nested, { version: 1, count: 42 }), true);
  assert.deepEqual(ReadJson(nested), { version: 1, count: 42 });
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), ['data.json']);

  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blockedTarget = path.join(blocker, 'child.json');
  assert.equal(WriteJsonAtomic(blockedTarget, { version: 1 }), false);
  assert.equal(ReadJson(blockedTarget), null);

  const dirTarget = path.join(dir, 'existing-dir');
  fs.mkdirSync(dirTarget);
  assert.equal(WriteJsonAtomic(dirTarget, { version: 1 }), false);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('RemoveFile deletes existing files and ignores missing paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'remove.json');
  WriteJsonAtomic(file, { ok: true });
  assert.equal(fs.existsSync(file), true);
  RemoveFile(file);
  assert.equal(fs.existsSync(file), false);
  RemoveFile(file);
});
