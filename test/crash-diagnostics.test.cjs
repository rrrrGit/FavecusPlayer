'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StartCrashDiagnostics } = require('../src/core/crash-diagnostics.cjs');

test('native crash diagnostics use runtime/logs, rotate large logs and never enable report upload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-crash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'runtime/logs'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'electron.log'), Buffer.alloc(4 * 1024 * 1024 + 1, 'x')); fs.writeFileSync(path.join(directory, 'electron.log.old'), 'old');
  const order = [], annotations = new Map(); let options;
  const app = { getVersion: () => '0.6.3', getPath: () => assert.fail('Install root must be used'), commandLine: { appendSwitch: (name, value) => order.push([name, value]) }, setPath: (name, value) => order.push([name, value]) };
  const crashReporter = { start(value) { options = value; order.push(['start']); }, addExtraParameter: (key, value) => annotations.set(key, value) };
  const result = StartCrashDiagnostics({ app, crashReporter, installRoot: root, runId: '27780-48437828' });
  assert.equal(result.started, true); assert.equal(options.uploadToServer, false); assert.equal(options.submitURL, undefined);
  assert.equal(options.globalExtra.favecus_run, '27780-48437828'); assert.equal(options.globalExtra.favecus_version, '0.6.3');
  assert.deepEqual(order.at(-2), ['crashDumps', path.join(directory, 'crashes')]); assert.deepEqual(order.at(-1), ['start']);
  assert.equal(fs.statSync(path.join(directory, 'electron.log.old')).size, 4 * 1024 * 1024 + 1);
  assert.deepEqual(fs.readdirSync(root), ['runtime']);
  result.Annotate({ event: 'track-change', video: 'a'.repeat(300), part: null });
  assert.equal(annotations.get('favecus_event'), 'track-change'); assert.equal(annotations.get('favecus_video').length, 127); assert.equal(annotations.get('favecus_part'), '');
});

test('diagnostic startup failure is recorded without stopping playback initialization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-crash-failure-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getVersion: () => '0.6.3', getPath: () => root, commandLine: { appendSwitch() {} }, setPath() {} };
  const result = StartCrashDiagnostics({ app, crashReporter: { start() { throw new Error('handler unavailable'); }, addExtraParameter() { assert.fail('Handler did not start'); } } });
  assert.equal(result.started, false); assert.equal(result.error, 'handler unavailable'); assert.doesNotThrow(() => result.Annotate({ event: 'play' }));
});
