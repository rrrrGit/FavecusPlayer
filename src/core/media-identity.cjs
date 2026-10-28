'use strict';
const { ParseBilibili } = require('./urls.cjs');

const IDENTITY_VERSION = 1;
function VideoIdentity(input, details = null) {
  const video = ParseBilibili(typeof input === 'string' ? input : input?.url);
  const bvid = typeof details?.bvid === 'string' && /^BV[a-zA-Z0-9]{10}$/.test(details.bvid) ? details.bvid : null;
  const aid = typeof details?.aid === 'string' ? details.aid : Number.isSafeInteger(details?.aid) ? String(details.aid) : '';
  const avid = /^[1-9]\d{0,17}$/.test(aid) ? `av${aid}` : null;
  // メタデータが入力動画自身を示す場合だけ、avとBVの対応を根拠にする。
  const verified = !!(bvid && avid && [bvid, avid].includes(video.videoId));
  const ids = verified ? [bvid, avid] : [video.videoId];
  const aliases = ids.map(id => ParseBilibili(`https://www.bilibili.com/video/${id}/?p=${video.part}`).url);
  return { version: IDENTITY_VERSION, type: 'bilibili', videoId: ids[0], part: video.part,
    url: aliases[0], originalURL: video.url, key: `bilibili:${aliases[0]}`, aliases, verified };
}
function MediaKey(entry, details = null) {
  return entry.type === 'local' ? `local:${entry.fileName}` : VideoIdentity(entry, details).key;
}
function DownloadIdentity(entry, kind, details = null) {
  if (!['video', 'audio'].includes(kind)) throw new Error('保存形式は動画または音声を指定してください。');
  const media = VideoIdentity(entry, details);
  return { ...media, kind, key: `${media.url}\n${kind}` };
}
function SameVideo(left, right, details = null) {
  const media = VideoIdentity(left, details), other = VideoIdentity(right);
  return media.part === other.part && media.aliases.includes(other.url);
}

module.exports = { IDENTITY_VERSION, VideoIdentity, MediaKey, DownloadIdentity, SameVideo };
