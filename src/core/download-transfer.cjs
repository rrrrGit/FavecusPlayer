'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { DownloadDiagnostic } = require('./download-errors.cjs');
const { MediaURL } = require('./bilibili-download.cjs');
const MAX_FILE_BYTES = 8 * 1024 ** 3;
async function DownloadStream(fetch, stream, file, referer, signal, progress, pause = delay) {
  let lastError;
  const candidates = [...new Set(stream.urls)].slice(0, 3);
  for (let attempt = 0; attempt < 2; attempt++) {
  for (const candidate of candidates) {
    signal.throwIfAborted(); let url = MediaURL(candidate);
    try {
      const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal]);
      let timer, received = 0; const arm = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(Object.assign(new Error('通信が60秒間進まないため中断しました。'), { downloadCode: 'FP-DOWNLOAD-TIMEOUT' })), 60000); };
      try {
        arm(); let response;
        for (let redirects = 0; redirects <= 5; redirects++) {
          response = await fetch(url, { credentials: 'omit', redirect: 'manual', signal: combined, headers: { Referer: referer } });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location || redirects === 5) throw new Error('配信先の転送を確認できません。');
          url = MediaURL(new URL(location, url).href);
        }
        if (!response.ok || response.status === 206 || !response.body) { await response.body?.cancel(); throw Object.assign(new Error(`動画データを取得できません（HTTP ${response.status}）。`), { httpStatus: response.status, stopBatch: [401, 412, 429].includes(response.status) }); }
        const advertised = Number(response.headers.get('content-length')) || 0, expected = stream.size || advertised;
        if (expected > MAX_FILE_BYTES || advertised > MAX_FILE_BYTES) { await response.body.cancel(); throw new Error('1ファイル8GBを超える保存には対応していません。'); }
        const count = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; arm(); progress(received, expected); callback(received > MAX_FILE_BYTES ? new Error('1ファイル8GBを超えたため中断しました。') : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), count, fs.createWriteStream(file, { flags: 'wx' }), { signal: combined });
        if (!received || expected && received !== expected || advertised && received !== advertised) throw Object.assign(new Error('動画データが途中までしか保存されませんでした。'), { downloadCode: 'FP-DOWNLOAD-INCOMPLETE' });
        return received;
      } catch (error) { if (timeout.signal.aborted && !signal.aborted) throw timeout.signal.reason; throw error; }
      finally { clearTimeout(timer); }
    } catch (error) {
      await fs.promises.rm(file, { force: true }).catch(() => {}); signal.throwIfAborted();
      if (error.stopBatch || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) { error.stopBatch = true; throw error; }
      lastError = error;
    }
  }
    const code = DownloadDiagnostic(lastError, 'transfer').code;
    if (!['FP-DOWNLOAD-CONNECTION', 'FP-DOWNLOAD-TIMEOUT', 'FP-DOWNLOAD-INCOMPLETE'].includes(code) && !(lastError?.httpStatus >= 500)) break;
    if (attempt === 0) await pause(700, null, { signal });
  }
  throw lastError || new Error('動画データを取得できません。');
}
function FFmpeg(executable, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '', aborted = false, timedOut = false;
    const abort = () => { aborted = true; child.kill(); }; signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30 * 60 * 1000), cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-12000); });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); if (aborted) reject(signal.reason || new Error('保存を中止しました。')); else if (timedOut) reject(new Error('保存形式の処理が時間内に完了しませんでした。')); else resolve({ code, output }); });
    if (signal.aborted) abort();
  });
}
async function Assemble(executable, plan, files, destination, signal) {
  const args = ['-v', 'error', '-xerror'];
  if (plan.layout === 'segments') { const list = path.join(path.dirname(destination), 'segments.txt'); await fs.promises.writeFile(list, files.map(f => `file '${path.basename(f)}'`).join('\n')); args.push('-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list); }
  else for (const file of files) args.push('-protocol_whitelist', 'file,pipe', '-i', file);
  if (plan.kind === 'video') args.push('-map', '0:v:0', '-map', plan.layout === 'dash' ? '1:a:0' : '0:a:0', '-c', 'copy', '-f', 'mp4');
  else args.push('-map', '0:a:0', '-vn', '-c:a', 'copy', '-f', 'ipod');
  args.push('-map_metadata', '-1', '-movflags', '+faststart', '-n', destination);
  if ((await FFmpeg(executable, args, signal)).code !== 0) throw new Error('保存形式へまとめられませんでした。未対応の形式か、不完全なデータです。');
  const probe = await FFmpeg(executable, ['-protocol_whitelist', 'file,pipe', '-i', destination], signal), match = probe.output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  if (!(duration > 0) || plan.duration > 0 && Math.abs(duration - plan.duration) > Math.max(3, plan.duration * .02)) throw new Error('保存ファイルの再生時間を確認できません。途中のデータは保存済みにしません。');
  return duration;
}
module.exports = { DownloadStream, Assemble };
