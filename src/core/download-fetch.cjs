'use strict';
const { MediaURL } = require('./bilibili-download.cjs');
const { ImageURL } = require('./thumbnail.cjs');

function DownloadFetch(session, fetcher = globalThis.fetch) {
  return async (input, options = {}) => {
    const url = new URL(input), api = url.origin === 'https://api.bilibili.com';
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('保存先の通信URLが正しくありません。');
    if (api) {
      if (!['/x/web-interface/view', '/x/web-interface/nav', '/x/player/playurl', '/x/player/wbi/playurl'].includes(url.pathname) || url.username || url.password) throw new Error('保存用の情報取得先が正しくありません。');
    } else {
      try { MediaURL(url.href); } catch { ImageURL(url.href); }
    }
    options.signal?.throwIfAborted();
    const headers = new Headers(options.headers);
    headers.delete('Cookie'); headers.delete('Authorization');
    const agent = session.getUserAgent?.(); if (agent) headers.set('User-Agent', agent);
    if (api && options.credentials === 'include') {
      const cookies = await session.cookies.get({ url: url.href });
      const value = cookies.filter(c => !/[\r\n;]/.test(c.name + c.value)).map(c => `${c.name}=${c.value}`).join('; ');
      if (value) headers.set('Cookie', value);
    }
    options.signal?.throwIfAborted();
    // 保存通信はChromiumのページ用処理から分離し、CookieはAPI宛てだけに付ける。
    return fetcher(url.href, { ...options, headers, redirect: options.redirect === 'error' ? 'error' : 'manual' });
  };
}
module.exports = { DownloadFetch };
