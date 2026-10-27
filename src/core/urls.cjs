'use strict';

const BILI_HOSTS = new Set(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'player.bilibili.com']);
const MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mp3', '.m4a', '.ogg', '.wav', '.flac', '.wma']);

function SharedURL(input) {
  const text = String(input || '').trim();
  if (text.length > 8192) throw new Error('共有文が長すぎます。動画URLの部分を貼り付けてください。');
  const matches = text.match(/https?:\/\/[^\s<>"'【】]+/g) || [];
  if (matches.length !== 1) throw new Error('1行に1件のBilibiliのURLを貼り付けてください。');
  const url = new URL(matches[0].replace(/[，。,;；）)\]]+$/, ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || ![...BILI_HOSTS, 'space.bilibili.com'].includes(url.hostname)) {
    throw new Error('Bilibiliの通常URLに対応しています。短縮URL（b23.tv）はブラウザーで開いた後のURLを使用してください。');
  }
  return url;
}
function ShareTitle(input) { return String(input || '').match(/^\s*【(.+)】\s*https:\/\//)?.[1]?.trim() || ''; }
const ParseVideo = input => ParseBilibili(input);

function ParseBilibili(input) {
  const text = String(input || '').trim();
  if (/^BV[a-zA-Z0-9]{10}$/.test(text)) return MakeVideo(text, 1);
  if (/^av[1-9]\d{0,17}$/i.test(text)) return MakeVideo(text.toLowerCase(), 1);
  const url = SharedURL(text);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !BILI_HOSTS.has(url.hostname)) {
    throw new Error('https://www.bilibili.com/video/… の動画URLに対応しています。短縮URLはブラウザーで開いた後のURLを使用してください。');
  }
  const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10}|av[1-9]\d{0,17})(?:\/|$)/);
  let videoId = match?.[1];
  if (url.hostname === 'player.bilibili.com' && url.pathname === '/player.html') {
    videoId = url.searchParams.get('bvid') || (url.searchParams.has('aid') ? `av${url.searchParams.get('aid')}` : '');
  }
  if (!videoId || !/^(BV[a-zA-Z0-9]{10}|av[1-9]\d{0,17})$/.test(videoId)) throw new Error('通常の投稿動画（BV / av）に対応しています。');
  const part = Number(url.searchParams.get('p') || 1);
  if (!Number.isInteger(part) || part < 1 || part > 10000) throw new Error('動画のパート番号が正しくありません。');
  return MakeVideo(videoId, part);
}

function MakeVideo(videoId, part) {
  return { type: 'bilibili', videoId, part, url: `https://www.bilibili.com/video/${videoId}/${part > 1 ? `?p=${part}` : ''}` };
}

function PlayerURL(entry, details = null) {
  if (entry.type !== 'bilibili') throw new Error('Bilibiliの動画を指定してください。');
  const video = ParseBilibili(entry.url);
  const url = new URL('https://player.bilibili.com/player.html');
  url.searchParams.set(video.videoId.startsWith('BV') ? 'bvid' : 'aid', video.videoId.replace(/^av/, ''));
  url.searchParams.set('p', String(video.part));
  const page = details?.pages?.find(p => Number(p.page) === video.part);
  if (Number.isSafeInteger(page?.cid) && page.cid > 0) url.searchParams.set('cid', String(page.cid));
  url.searchParams.set('autoplay', '1');
  url.searchParams.set('muted', '0');
  url.searchParams.set('danmaku', '0');
  url.searchParams.set('qn', '16'); url.searchParams.set('high_quality', '0');
  return url.href;
}

function IsAllowedRemote(raw, kind) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (kind === 'bilibili') return BILI_HOSTS.has(u.hostname) || ['passport.bilibili.com', 'space.bilibili.com', 'account.bilibili.com'].includes(u.hostname);
  } catch {}
  return false;
}

module.exports = { ParseBilibili, ParseVideo, SharedURL, ShareTitle, PlayerURL, IsAllowedRemote, MEDIA_EXTENSIONS };
