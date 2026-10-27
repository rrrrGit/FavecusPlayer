'use strict';
// 開発時のみ使用。配布アプリは生成済みHTMLを開く。
const fs = require('node:fs');
const path = require('node:path');
const marked = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'marked')) : require('marked');
const root = path.join(__dirname, '../docs');
const style = 'body{font-family:"Yu Gothic UI",system-ui,sans-serif;line-height:1.9;margin:45px auto;max-width:960px;padding:0 30px;color:#202332;background:#f8f9fc}h1,h2,h3{line-height:1.5;color:#363157}h2{margin-top:2em}table{border-collapse:collapse;width:100%;font-size:.95em}th,td{border:1px solid #c9cada;text-align:left;padding:9px 12px}th{background:#efedf9}pre{background:#eaeaf2;padding:15px;white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:Consolas,monospace;font-size:.92em}a{color:#5946a9}li{margin:6px 0}blockquote{margin:20px 0;padding:5px 20px;border-left:3px solid #7969bf;background:#efedf9}img{width:160px;max-width:100%;border-radius:24px}';
for (const name of ['GUIDE', 'BUILD', 'DISCORD', 'TASKBAR']) {
  const content = marked.parse(fs.readFileSync(path.join(root, `${name}.md`), 'utf8'));
  fs.writeFileSync(path.join(root, `${name}.html`), `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'"><title>Favecus Player · ${name}</title><style>${style}</style></head><body>${content}</body></html>\n`);
}
