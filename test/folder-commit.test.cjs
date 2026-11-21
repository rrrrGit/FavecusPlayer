'use strict';
// フォルダから追加：追加が済んだあとに、アーティストが、曲の情報へ入ること（実際に動かして確かめる）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const register = require('../src/main/ipc-library.cjs');

function harness(t) {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-media-')), source = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-src-'));
  t.after(() => { fs.rmSync(media, { recursive: true, force: true }); fs.rmSync(source, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(source, 'a.mp3'), 'x'); fs.writeFileSync(path.join(source, 'b.mp3'), 'x');
  const handlers = new Map(), saved = [], plans = new Map(), emitted = [];
  const overrides = {
    Handle: (name, fn) => handlers.set(name, fn), fs, path, Emit: (...args) => emitted.push(args), SyncPlayingQueue: () => {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) },
    ScanFolder: require('../src/core/folder-scan.cjs').ScanFolder,
    ReadTags: async (_executable, file) => (file.endsWith('a.mp3') ? { title: 'タグの曲名', artist: '歌い手' } : {}),
    ffmpeg: 'ffmpeg',
    store: { media, Targets: () => [{ id: 'p' }] },
    notesStore: { Set: (key, record) => { saved.push([key, record]); } },
    win: {},
    additionReview: {
      plans,
      PrepareFiles: async (_ids, files, options) => {
        const items = [];
        for (const file of files) { const info = await options.describe(file); items.push({ sourceFile: file, ...(info.artist ? { artist: info.artist } : {}), entry: { type: 'local', fileName: `${path.basename(file, '.mp3')}-id.mp3`, title: info.title || path.basename(file) } }); }
        plans.set('plan1', { items });
        return { id: 'plan1', totalCount: items.length, warnings: [] };
      },
      Commit: async () => { fs.writeFileSync(path.join(media, 'a-id.mp3'), 'x'); /* b は、追加されなかった（重複を外した、など） */ return { state: {} }; },
      Cancel: () => {}
    }
  };
  const ctx = new Proxy({}, { get: (_target, key) => (key in overrides ? overrides[key] : () => {}) });
  register(ctx);
  return { handlers, saved, plans };
}

test('after the folder import is committed, the tag artist goes to song info for songs that were added, and only those', async t => {
  const h = harness(t);
  const plan = await h.handlers.get('library:prepare-folder')(['p']);
  assert.equal(plan.id, 'plan1');
  await (h.handlers.get('library:commit-add')(plan.id, []));
  assert.deepEqual(h.saved, [['local:a-id.mp3', { artist: '歌い手' }]], '追加された曲（ファイルがある）のアーティストだけ');
});

test('a cancelled plan forgets its artists and a second commit does not save them again', async t => {
  const h = harness(t);
  const plan = await h.handlers.get('library:prepare-folder')(['p']);
  h.handlers.get('library:cancel-add')(plan.id);
  await h.handlers.get('library:commit-add')(plan.id, []);
  assert.deepEqual(h.saved, []);
  const again = await h.handlers.get('library:prepare-folder')(['p']);
  await h.handlers.get('library:commit-add')(again.id, []);
  await h.handlers.get('library:commit-add')(again.id, []);
  assert.equal(h.saved.length, 1, '1回だけ');
});
