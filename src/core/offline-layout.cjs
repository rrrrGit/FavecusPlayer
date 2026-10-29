'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const Tree = require('../ui/library-tree.js');
const { ParseBilibili } = require('./urls.cjs');
const { LibraryMediaKey } = require('./library-identity.cjs');
function SharedFolder(entry, data) {
  const key = LibraryMediaKey(data?.videoAliases)(entry), video = ParseBilibili(key.slice('bilibili:'.length));
  return `media/${video.videoId}-p${video.part}`;
}
function SafeName(value) { const name = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 55); return !name || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name) ? `_${name || 'playlist'}` : name; }
const Hash = (value, length) => createHash('sha256').update(String(value)).digest('hex').slice(0, length);
const Group = p => `${SafeName(p.name)}-${Hash(p.id, 8)}`;
const Track = e => `${SafeName(e.title || e.videoId)}-${Hash(ParseBilibili(e.url).url, 12)}`;
function Matches(record, entry) { return entry.type === 'bilibili' && [record.url, ...(record.aliases || [])].includes(ParseBilibili(entry.url).url); }
function Owner(data, record) {
  if (!data?.playlists) return null;
  const candidates = data.playlists.filter(p => p.entries.some(e => Matches(record, e)));
  const playlist = candidates.find(p => p.id === record.playlistId) || candidates.find(p => record.file.split('/').includes(Group(p))) || candidates[0];
  return playlist ? { playlist, entry: playlist.entries.find(e => Matches(record, e)) } : null;
}
function Folder(data, playlistId, playlistName) {
  const chain = data?.playlists ? Tree.Path(data, playlistId) : [];
  return (chain.length ? chain : [{ id: playlistId, name: playlistName }]).map(Group).join('/');
}
function Target(data, record) {
  const owner = Owner(data, record); if (!owner) return null;
  return { ...owner, folder: `${Folder(data, owner.playlist.id, owner.playlist.name)}/${record.layout >= 2 ? path.posix.basename(path.posix.dirname(record.file)) : Track(owner.entry)}` };
}
module.exports = { SafeName, Folder, Track, Target, SharedFolder };
