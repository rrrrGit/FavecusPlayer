'use strict';
// 音楽・動画ファイルに埋め込まれたタグ（曲名・アーティスト）の読み取り（v0.7.4。PC版。ffmpeg の -f ffmetadata を使う）。
// 読み取りだけ。ファイルは変えない。読めなかったときは、空（呼び出し側は、ファイル名を曲名にする）。
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FIELD = 300;
const unescape = text => text.replace(/\\([=;#\\\n])/g, '$1');

// ffmpeg の ffmetadata 形式（「キー=値」の行。先頭は ;FFMETADATA1。値の中の = ; # \ と改行は、\ で退避）から、曲名・アーティスト・アルバムを取り出す。
function ParseFfmetadata(text) {
  const tags = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw || raw.startsWith(';') || raw.startsWith('[')) { if (raw.startsWith('[')) break; continue; } // [CHAPTER] などの前まで（ファイル全体のタグだけ）
    const at = raw.indexOf('=');
    if (at <= 0) continue;
    const key = raw.slice(0, at).trim().toLowerCase(), value = unescape(raw.slice(at + 1)).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
    if (!value) continue;
    if (key === 'title' && !tags.title) tags.title = value;
    else if ((key === 'artist' || key === 'album_artist' || key === 'albumartist') && !tags.artist) tags.artist = value;
    else if (key === 'album' && !tags.album) tags.album = value;
  }
  return tags;
}

// ffmpeg でタグを読む（最大 timeoutMs。失敗・タイムアウトは、空）。spawnFn は、テスト用。
function ReadTags(executable, file, { timeoutMs = 10000, spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    let output = '', done = false, child;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    try { child = spawnFn(executable, ['-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file', '-i', path.resolve(file), '-map_metadata', '0', '-f', 'ffmetadata', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve({}); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({}); }, timeoutMs);
    child.stdout?.on('data', chunk => { output += chunk; if (output.length > 200000) output = output.slice(0, 200000); });
    child.once('error', () => finish({}));
    child.once('close', code => finish(code === 0 ? ParseFfmetadata(output) : {}));
  });
}

// 曲名にするもの：埋め込みの曲名があればそれ、なければ、ファイル名（拡張子なし）。
const TitleFrom = (tags, file) => (tags && tags.title) || path.basename(file, path.extname(file));

module.exports = { ParseFfmetadata, ReadTags, TitleFrom };
