'use strict';
// v0.7.3 F2：前回の続きから再生（保存と位置の規則）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ResumeStore, ResumePosition, INTERVAL_MS } = require('../src/core/resume-point.cjs');

const sample = (position = 100) => ({ entryId: 'e1', playlistId: 'p1', scope: '*', position, duration: 300 });
function Temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-resume-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'playback-resume.json'); }

test('a position near the start or the end resumes from the beginning', () => {
  assert.equal(ResumePosition(3, 200), 0);
  assert.equal(ResumePosition(5, 200), 5);
  assert.equal(ResumePosition(123.9, 200), 123);
  assert.equal(ResumePosition(196, 200), 0, '終わりの5秒以内');
  assert.equal(ResumePosition(195, 200), 195);
  assert.equal(ResumePosition(50, 0), 50, '長さが分からないときは、そのまま');
  assert.equal(ResumePosition(NaN, 200), 0);
});

test('the position is written about every 10 seconds, and at once when playback pauses', t => {
  const file = Temp(t); let time = 1_000_000;
  const store = new ResumeStore(file, () => time);
  store.Observe(sample(10)); // 最初の1回は、すぐ保存
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).position, 10);
  time += 3000; store.Observe(sample(13));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).position, 10, '間隔の途中では、書き込まない');
  assert.equal(store.Get().position, 13, '読み出しは、最新の位置');
  time += INTERVAL_MS; store.Observe(sample(25));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).position, 25);
  time += 1000; store.Observe(sample(26), true); // 一時停止にした瞬間
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).position, 26);
  time += 1000; store.Observe(sample(26), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).savedAt, 1_000_000 + 3000 + INTERVAL_MS + 1000, '一時停止中は、書き込みを繰り返さない');
});

test('flush writes the pending position (used when the app quits) and survives a restart', t => {
  const file = Temp(t); let time = 5_000_000;
  const store = new ResumeStore(file, () => time);
  store.Observe(sample(40)); time += 2000; store.Observe(sample(42));
  store.Flush();
  const next = new ResumeStore(file, () => time);
  assert.deepEqual({ ...next.Get(), savedAt: 0 }, { entryId: 'e1', playlistId: 'p1', scope: '*', position: 42, duration: 300, savedAt: 0 });
});

test('a damaged or malformed file is ignored and replaced by the next save', t => {
  const file = Temp(t);
  fs.writeFileSync(file, '{ not json');
  const store = new ResumeStore(file);
  assert.equal(store.Get(), null);
  fs.writeFileSync(file, JSON.stringify({ entryId: 'e1', playlistId: '', scope: '*', position: 5, duration: 9 }));
  assert.equal(new ResumeStore(file).Get(), null, '必須の項目がないものは使わない');
  store.Observe(sample(30));
  assert.equal(new ResumeStore(file).Get().position, 30);
});

test('invalid samples never overwrite a good record, and clear removes it', t => {
  const file = Temp(t);
  const store = new ResumeStore(file);
  store.Observe(sample(30));
  store.Observe({ entryId: '', playlistId: 'p', scope: '*', position: 1, duration: 1 });
  store.Observe({ ...sample(), position: -5 });
  store.Flush();
  assert.equal(new ResumeStore(file).Get().position, 30);
  store.Clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.Get(), null);
});

test('the player bar, preload and main process are wired to the resume record', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/ui/index.html'), /id="resume-last"/);
  assert.match(read('src/preloads/ui.cjs'), /resumeLast: invoke\('player:resume-last'\)/);
  const main = read('src/main.cjs');
  assert.match(main, /Handle\('player:resume-last'/);
  assert.match(main, /resumeStore\?\.Observe\(/);
  assert.match(main, /resumeStore\?\.Flush\(\)/, '終了時に確定する');
  assert.match(main, /Handle\('player:play', \(playlistId, entryId\) => Play\(playlistId, entryId\)\)/, '画面からは、再開の位置を指定できない');
});
