'use strict';
// 「いくつからでも最新版まで更新できる」ことの確認：実際の旧版（gitのタグ）の中身で、旧版を Setup で入れ、いまのソースの Patch を直接当てる。
// 旧版のインストール状態は、旧版そのもののファイル構成（src・docs・build・package.json）で作る。実行ファイル（Node・ランチャー）は、中身を問わない模擬。
// 確認すること：Patchが最後まで成功する／アプリが最新の版に置き換わる／利用者のデータ（保存済みメディア・個人のファイル）が、1バイトも変わらない／
// 旧版が作ったライブラリを、いまのコードで開ける／再度のPatch（同じ版）も成功する。
// タグは、環境変数 FAVECUS_REQUIRE_TAGS=1 のとき、1つでもなければ失敗にする（CIの確認用。ローカルでは、ないタグを読み飛ばす）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Install, Hash } = require('../scripts/install-core.cjs');

const ROOT = path.join(__dirname, '..');
// v0.6.2 のタグは、READMEだけの最初のコミットで、ソースがない。ソースのある最古のタグは v0.6.6。それ以前の形（0.1.0〜0.4.x）は、test/revision.test.cjs が、模擬の構成で確認している。
const TAGS = ['v0.6.6', 'v0.6.7', 'v0.7.0', 'v0.7.1', 'v0.7.2'];
const deps = { runtimes: async () => {} }; // Electron・ffmpegの取得は、版が同じなら行われない（ここでは省く）

function Temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-update-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function HasTag(tag) { return spawnSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { cwd: ROOT }).status === 0; }

// gitのタグ（または作業ツリー＝いまのソース）から、Payload（Setup/Patchの中身）を作る。
function Extract(ref, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (ref === null) {
    for (const name of ['src', 'docs', 'build']) fs.cpSync(path.join(ROOT, name), path.join(destination, name), { recursive: true });
    for (const name of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(ROOT, name), path.join(destination, name));
    return;
  }
  const archive = spawnSync('git', ['archive', '--format=tar', ref, 'src', 'docs', 'build', 'package.json', 'LICENSE'], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  assert.equal(archive.status, 0, `git archive ${ref}: ${archive.stderr}`);
  // 展開先は cwd で指定する（-C にWindowsのパス（C:…）を渡すと、tarが「C」をホスト名と解釈するため）
  const extract = spawnSync('tar', ['-x'], { cwd: destination, input: archive.stdout, maxBuffer: 512 * 1024 * 1024 });
  assert.equal(extract.status, 0, `tar: ${extract.stderr}`);
}
async function Payload(parent, ref, label) {
  const payload = path.join(parent, `payload-${label}`), app = path.join(payload, 'app');
  Extract(ref, app);
  const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
  for (const [name, data] of Object.entries({ 'FavecusPlayer.exe': `launcher ${label}`, 'bootstrap/node.exe': 'node (mock)', 'bootstrap/NODE-LICENSE.txt': 'license' })) {
    fs.mkdirSync(path.dirname(path.join(payload, name)), { recursive: true }); fs.writeFileSync(path.join(payload, name), data);
  }
  const files = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(payload)) files.push({ path: path.relative(payload, file).split(path.sep).join('/'), sha256: await Hash(file) });
  fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify({ product: 'favecus-player', version, files }));
  return { payload, version };
}

for (const tag of TAGS) {
  test(`updating from ${tag} straight to the current source keeps all user files and succeeds again on a repeat`, async t => {
    if (!HasTag(tag)) {
      assert.notEqual(process.env.FAVECUS_REQUIRE_TAGS, '1', `タグ ${tag} がありません（CIでは、全タグの取得が必要）`);
      t.skip(`タグ ${tag} がありません`); return;
    }
    const base = Temp(t), target = path.join(base, 'FavecusPlayer'), userData = path.join(base, 'AppData');
    const old = await Payload(base, tag, `old-${tag}`), current = await Payload(base, null, 'current');
    // 1. 旧版を、Setupで入れる
    const installed = await Install({ root: target, payload: old.payload, mode: 'setup', dependencies: deps });
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, installed.app, 'package.json'), 'utf8')).version, old.version);
    // 2. 利用者のデータ：旧版のコードで作ったライブラリ（アプリのデータ）と、インストール先の保存済みメディア・個人のファイル
    const { Store } = require(path.join(base, `payload-old-${tag}`, 'app', 'src', 'core', 'store.cjs'));
    const oldStore = new Store(userData);
    oldStore.Apply({ type: 'add', playlistId: oldStore.data.activePlaylistId, urls: 'https://www.bilibili.com/video/BV1aaaaaaaaa/\nhttps://www.bilibili.com/video/BV1bbbbbbbbb/?p=2' });
    oldStore.Save();
    const names = oldStore.data.playlists.flatMap(p => p.entries.map(e => e.videoId));
    fs.mkdirSync(path.join(target, 'downloads', 'audio'), { recursive: true });
    const keep = { 'downloads/audio/saved.m4a': Buffer.from('saved media bytes'), 'downloads/index.json': Buffer.from('{"keep":true}'), 'media/local.mp4': Buffer.from('local media'), 'my-notes.txt': Buffer.from('personal file') };
    for (const [name, data] of Object.entries(keep)) { fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true }); fs.writeFileSync(path.join(target, name), data); }
    const before = {}; for (const name of Object.keys(keep)) before[name] = await Hash(path.join(target, name));
    // 3. いまのソースの Patch を、直接当てる
    const updated = await Install({ root: target, payload: current.payload, mode: 'patch', dependencies: deps });
    const nowVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, updated.app, 'package.json'), 'utf8')).version, nowVersion, 'アプリが、いまの版に置き換わる');
    assert.equal(fs.readFileSync(path.join(target, 'runtime/config/active.txt'), 'utf8').trim(), updated.app);
    assert.ok(fs.existsSync(path.join(target, 'runtime/node/node.exe')) && fs.existsSync(path.join(target, 'FavecusPlayer.exe')), '起動に必要なファイルが、そろっている');
    for (const [name, hash] of Object.entries(before)) assert.equal(await Hash(path.join(target, name)), hash, `${name} が変わっていない`);
    assert.deepEqual(fs.readdirSync(target).filter(n => n.startsWith('.setup-stage-')), [], '一時ファイルが残らない');
    // 4. 旧版が作ったライブラリを、いまのコードで開ける（アプリの起動と同じ読み込み）
    const { Store: CurrentStore } = require('../src/core/store.cjs');
    const reopened = new CurrentStore(userData);
    assert.deepEqual(reopened.data.playlists.flatMap(p => p.entries.map(e => e.videoId)), names, '曲・並びが、そのまま');
    // 5. 同じ版のPatchを、もう一度当てても成功する（失敗後の再実行・重ね掛け）
    const again = await Install({ root: target, payload: current.payload, mode: 'patch', dependencies: deps });
    assert.equal(again.app, updated.app);
    for (const [name, hash] of Object.entries(before)) assert.equal(await Hash(path.join(target, name)), hash);
  });
}

test('every tag the update path promises is present in this checkout (CI requires them all)', () => {
  const missing = TAGS.filter(tag => !HasTag(tag));
  if (process.env.FAVECUS_REQUIRE_TAGS === '1') assert.deepEqual(missing, [], `不足しているタグ：${missing.join(', ')}`);
});
