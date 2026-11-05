'use strict';
const { ValidateLibrary } = require('./library-data.cjs');
const { VideoAliases } = require('./library-identity.cjs');
function ShareMode(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'mode')) throw new Error('出力方式が正しくありません。');
  const mode = options.mode === undefined ? 'media' : options.mode;
  if (!['information', 'media'].includes(mode)) throw new Error('出力方式が正しくありません。');
  return mode;
}
function ShareData(data, mode) {
  ShareMode({ mode });
  const playlists = ValidateLibrary(data);
  for (const p of playlists) for (const e of p.entries) if (e.type === 'local') e.mediaIncluded = false;
  return { version: 3, shareVersion: 1, exportMode: mode, identityVersion: data.identityVersion, videoAliases: VideoAliases(data.videoAliases), playlists, rootPlaylistIds: [...data.rootPlaylistIds] };
}
function ReadShare(input) {
  const locals = new Map();
  if (!Object.hasOwn(input, 'shareVersion') && !Object.hasOwn(input, 'exportMode')) return { mode: 'legacy', locals };
  if (input.shareVersion !== 1 || input.version !== 3 || !['information', 'media'].includes(input.exportMode)) throw new Error('対応していないプレイリスト共有形式です。');
  for (const p of input.playlists) for (const e of p.entries) if (e.type === 'local') {
    if (typeof e.mediaIncluded !== 'boolean' || input.exportMode === 'information' && e.mediaIncluded || locals.has(e.fileName) && locals.get(e.fileName) !== e.mediaIncluded) throw new Error('ローカル曲の同梱情報が正しくありません。');
    locals.set(e.fileName, e.mediaIncluded);
  }
  return { mode: input.exportMode, locals };
}
module.exports = { ShareMode, ShareData, ReadShare };
