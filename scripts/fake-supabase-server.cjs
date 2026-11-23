'use strict';
// 偽のSupabase（test/fake-supabase.cjs）をHTTPサーバーにする。iOSのテストとWindows版（Node）の同期を、同じサーバーへつなぐCI用。
// 使い方: node scripts/fake-supabase-server.cjs <ポート> [待ち受けたことを書くファイル]
// 実際のSupabaseではない（RLS・並行処理はなし）。コードは固定（123456）。
const http = require('node:http');
const fs = require('node:fs');
const { FakeServer } = require('../test/fake-supabase.cjs');

const port = Number(process.argv[2] || 0), readyFile = process.argv[3];
const server = FakeServer({ now: Date.now() }); // 偽のサーバーの時計は、実際の時刻から始める（固定の日付だと、日がたつと、端末との時刻のずれで同期が止まりテストが失敗する）
server.now = Date.now(); server.ttl = 24 * 3600; // 実際の時刻で、トークンの期限を長めに
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      const headers = { apikey: req.headers.apikey, Authorization: req.headers.authorization, 'Content-Type': req.headers['content-type'], prefer: req.headers.prefer };
      server.now = Date.now();
      const reply = await server.request(req.method, `http://127.0.0.1:${port}${req.url}`, { headers, body: text ? JSON.parse(text) : undefined });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json === undefined ? null : reply.json));
    } catch (error) { res.writeHead(500); res.end(String(error && error.message || error)); }
  });
}).listen(port, '127.0.0.1', function () {
  const actual = this.address().port;
  if (readyFile) fs.writeFileSync(readyFile, String(actual));
  console.log(`fake supabase on http://127.0.0.1:${actual}`);
});
