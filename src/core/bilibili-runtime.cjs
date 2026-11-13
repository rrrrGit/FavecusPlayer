'use strict';
// iPhone版（JavaScriptCore）のBilibili情報取得の入口。通信はSwiftが用意した host（globalThis.__favecusHost）の request(method, url, JSON文字列{headers, body}) を通す
// （Cookieの付与・接続先の制限・通信そのものはSwift側。api.bilibili.com 宛てだけにCookieを付ける）。
// 規則は、Windows版と共通の bilibili-resolve.cjs。ここは、ステータスの扱いと、結果の整形だけ。
// 方針：ログイン要・リスク制御（412・-352など）では、方法を変えて再試行せず、停止して知らせる。保護された動画・試聴用は扱わない。
const { ResolveWith } = require('./bilibili-resolve.cjs');
const { ParseBilibili } = require('./urls.cjs');

const Host = () => { const host = globalThis.__favecusHost; if (!host) throw new Error('通信の接続先（host）が用意されていません。'); return host; };
const Fail = error => ({ error: String(error && error.message || error), ...(error && error.stopBatch ? { stopBatch: true } : {}), ...(error && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
const Encode = query => typeof query === 'string' ? query : Object.keys(query).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`).join('&');

// api.bilibili.com への要求。応答のJSONを返す。HTTPの失敗は、停止して知らせる（401・412・429は、続けて試さない）。
function Requester() {
  const host = Host();
  return async (endpoint, query) => {
    const response = JSON.parse(await host.request('GET', `https://api.bilibili.com${endpoint}?${Encode(query)}`, JSON.stringify({ headers: { Referer: 'https://www.bilibili.com/' }, body: null })));
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`Bilibiliから情報を取得できません（HTTP ${response.status}）。ログイン状態を確認し、時間を置いて再実行してください。`), { httpStatus: response.status, stopBatch: [401, 412, 429].includes(response.status) });
    }
    return response.json;
  };
}

// 配信先を決める。options：{ url, kind: 'audio'|'video', height }。戻り値：{ resolved, verified } または { error, stopBatch?, httpStatus? }
async function Resolve(options) {
  try {
    const result = await ResolveWith(Requester(), ParseBilibili(options.url), options.kind, options.height || 720);
    return { resolved: result.resolved, verified: result.verified };
  } catch (error) { return Fail(error); }
}
// ログイン状態（/x/web-interface/nav）。戻り値：{ loggedIn, uid?, name? }
async function Profile() {
  try {
    const result = await Requester()('/x/web-interface/nav', {});
    const data = result && result.data;
    if (result && result.code === 0 && data && data.isLogin && Number.isSafeInteger(data.mid)) return { loggedIn: true, uid: String(data.mid), name: String(data.uname || '').slice(0, 60) };
    // ログアウト扱い（保存したログイン情報を消す）のは、未ログインを示す -101 のときだけ。リスク制御・混雑などは、消さずに停止して知らせる。
    if (result && (result.code === -101 || (result.code === 0 && data && data.isLogin === false))) return { loggedIn: false };
    return { error: `Bilibiliから情報を取得できません（コード ${result && result.code}）。時間を置いて再実行してください。`, stopBatch: true };
  } catch (error) { return Fail(error); }
}
module.exports = { Resolve, Profile };
