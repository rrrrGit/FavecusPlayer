'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..'); let count = 0;
function Visit(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) Visit(file);
    else if (/\.(cjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
      count++;
    } else if (item.name.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}
for (const folder of ['src', 'scripts', 'test']) Visit(path.join(root, folder));
process.stdout.write(`${count} JavaScript files: syntax OK\n`);
