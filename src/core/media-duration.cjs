'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
function LocalDuration(executable, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', path.resolve(file)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let text = ''; const timer = setTimeout(() => { child.kill(); resolve(null); }, 10000);
    child.stderr.on('data', chunk => { text = (text + chunk).slice(-16000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null); });
  });
}
module.exports = { LocalDuration };
