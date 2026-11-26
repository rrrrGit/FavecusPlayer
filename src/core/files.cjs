'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
function ParseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error('Invalid range');
  let start, end;
  if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Invalid range');
  return { start, end };
}
async function MediaResponse(request, file, release = () => {}) {
  let source, released = false;
  const finish = () => { if (!released) { released = true; release(); } };
  try {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return new Response('動画ファイルが見つかりません', { status: 404 });
    let range;
    try { range = ParseRange(request.headers.get('range'), stat.size); }
    catch { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } }); }
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(range ? range.end - range.start + 1 : stat.size) };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    let body = null;
    if (request.method !== 'HEAD' && stat.size) {
      source = fs.createReadStream(file, { ...range, signal: request.signal }); source.once('close', finish);
      body = Readable.toWeb(source);
    }
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) { source?.destroy(); throw error; }
  finally { if (!source) finish(); }
}
module.exports = { ParseRange, MediaResponse };
