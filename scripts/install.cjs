'use strict';
const fs = require('node:fs');
const { Install } = require('./install-core.cjs');
const [root, payload, log, mode, selection] = process.argv.slice(2);
function Progress(message) { if (log) fs.appendFileSync(log, `${message}\r\n`, 'utf8'); }
(async () => {
  try {
    if (process.platform !== 'win32') throw new Error('このセットアップはWindows用です。');
    if (!root || !payload || !log) throw new Error('Setup.exeまたはPatch.exeから起動してください。');
    const result = await Install({ root, payload, mode, selection: selection === 'selected', progress: Progress });
    fs.writeFileSync(`${log}.root`, result.root, 'utf8');
    if (result.notes?.length) fs.writeFileSync(`${log}.notice`, result.notes.join('\n'), 'utf8');
  } catch (error) { Progress(`エラー: ${error.message}`); process.exitCode = 1; }
})();
