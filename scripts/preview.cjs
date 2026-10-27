'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/core/store.cjs');
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-preview-')));
const root = path.join(__dirname, '../src/ui');
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
