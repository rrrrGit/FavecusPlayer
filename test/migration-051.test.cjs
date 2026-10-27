'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PrepareDataDirectory } = require('../src/core/data-migration.cjs');
const { Store } = require('../src/core/store.cjs');
function Temp(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-migration-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
test('old app data and account partitions move with exact bytes, and default Discord art migrates once', t => {
  const root = Temp(t), old = path.join(root, 'Focus Player'), store = new Store(old);
  store.Apply({ type: 'add', playlistId: store.data.activePlaylistId, urls: 'av123' });
  store.data.settings.discordImageKey = 'focus_player_music'; store.Save();
  const bytes = fs.readFileSync(store.file), partition = path.join(old, 'Partitions/focus-bilibili'); fs.mkdirSync(partition, { recursive: true }); fs.writeFileSync(path.join(partition, 'Cookies'), 'account bytes');
  const directory = PrepareDataDirectory(root); assert.equal(fs.existsSync(old), false); assert.deepEqual(fs.readFileSync(path.join(directory, 'library.json')), bytes);
  assert.equal(fs.readFileSync(path.join(directory, 'Partitions/favecus-bilibili/Cookies'), 'utf8'), 'account bytes');
  const next = new Store(directory); assert.equal(next.data.settings.discordImageKey, 'favecus_player_music'); assert.equal(next.data.playlists[0].entries[0].videoId, 'av123');
  next.Apply({ type: 'settings', settings: { discordImageKey: 'my_custom_image' } });
  assert.equal(PrepareDataDirectory(root), directory); assert.equal(new Store(directory).data.settings.discordImageKey, 'my_custom_image');
});
test('existing new-name data prevents destructive migration or merging', t => {
  const root = Temp(t);
  for (const name of ['Focus Player', 'Favecus Player']) { const folder = path.join(root, name); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'library.json'), name); }
  assert.throws(() => PrepareDataDirectory(root), /両方/);
  for (const name of ['Focus Player', 'Favecus Player']) assert.equal(fs.readFileSync(path.join(root, name, 'library.json'), 'utf8'), name);
});
