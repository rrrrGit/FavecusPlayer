'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-preview-')));
const root = path.join(__dirname, '../src/ui');
// --demo：見た目の確認用に、階層・全体再生から外したリスト・空のリスト・長い名前のリストを作る（外部通信なし。保存先は一時フォルダー）。
if (process.argv.includes('--demo')) {
  const bv = n => `https://www.bilibili.com/video/BV1${String(n).padStart(9, 'a')}/`, make = (name, parentId = null) => { store.Apply({ type: 'create', name, parentId }); return store.data.activePlaylistId; };
  const first = store.data.playlists[0].id; store.Apply({ type: 'rename', playlistId: first, name: 'お気に入りの曲' }); store.Apply({ type: 'add', playlistId: first, urls: [1, 2, 3].map(bv).join('\n'), title: '曲' });
  const parent = make('EroGameSongs'), child = make('ケロQ・枕', parent), grand = make('サクラノ詩', child); store.Apply({ type: 'add', playlistId: grand, urls: [4, 5].map(bv).join('\n'), title: '曲' });
  const excluded = make('全体再生から外したリスト'); store.Apply({ type: 'add', playlistId: excluded, urls: bv(6), title: '曲' }); store.Apply({ type: 'playlist-properties', playlistId: excluded, includeInAll: false });
  make('空のリスト'); const long = make('とても長い名前のプレイリストがここに入るとどう表示されるかの確認用リスト'); store.Apply({ type: 'add', playlistId: long, urls: bv(7), title: '曲' });
  store.Apply({ type: 'select', playlistId: first });
}
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 20000) { res.writeHead(413).end(); return; } }
    try {
      const { name, args } = JSON.parse(body);
      const value = name === 'state' ? { state: store.Snapshot(), version: `${require('../package.json').version} preview`, statuses: {}, current: null } : name === 'action' ? store.Apply(args[0]) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, value }));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message })); }
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[a-z-]+\.(html|js|css|svg|png)$/.test(name) || !fs.existsSync(path.join(root, name)) && !['icon.png', 'music.png'].includes(name)) { res.writeHead(404).end(); return; }
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }).end(fs.readFileSync(['icon.png', 'music.png'].includes(name) ? path.join(__dirname, '../build', name) : path.join(root, name)));
}).listen(4187, '127.0.0.1', () => process.stdout.write('Preview: http://127.0.0.1:4187/?preview=1\n'));
