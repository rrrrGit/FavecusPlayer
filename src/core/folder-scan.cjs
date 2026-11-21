'use strict';
// フォルダの中の動画・音楽ファイルを探す（v0.7.4。PC版の「フォルダから追加」）。読み取りだけ。ファイルは変えない。
// シンボリックリンク・読めないフォルダは飛ばす。見つけた順は、パスの自然順（数字は数として比べる）。上限を超えたら、そこで止めて知らせる。
const fs = require('node:fs');
const path = require('node:path');
const { MEDIA_EXTENSIONS } = require('./urls.cjs');

const DEFAULT_LIMIT = 2000, DEFAULT_DEPTH = 8;
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// 戻り値：{ files: [絶対パス], truncated: 上限で止めたか, skipped: 飛ばした項目の数（リンク・読めない場所） }
async function ScanFolder(root, { limit = DEFAULT_LIMIT, maxDepth = DEFAULT_DEPTH, extensions = MEDIA_EXTENSIONS } = {}) {
  const top = path.resolve(String(root || ''));
  const stat = await fs.promises.lstat(top).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('フォルダを選んでください。');
  const files = []; let skipped = 0, truncated = false;
  async function walk(dir, depth) {
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { skipped++; return; }
    items.sort((a, b) => collator.compare(a.name, b.name));
    for (const item of items) {
      if (truncated) return;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) { skipped++; continue; }
      if (item.isDirectory()) { if (depth < maxDepth) await walk(full, depth + 1); else skipped++; continue; }
      if (!item.isFile() || !extensions.has(path.extname(item.name).toLowerCase())) continue;
      if (files.length >= limit) { truncated = true; return; }
      files.push(full);
    }
  }
  await walk(top, 0);
  return { files, truncated, skipped };
}

module.exports = { ScanFolder, DEFAULT_LIMIT, DEFAULT_DEPTH };
