'use strict';
const { MediaKey, VideoIdentity } = require('./media-identity.cjs');

const IDENTITY_SCHEMA_VERSION = 2;
const MEDIA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function IdentityError(message) { return Object.assign(new Error(message), { identityDataInvalid: true }); }
function ValidateIdentityVersion(input) {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'identityVersion') && ![1, IDENTITY_SCHEMA_VERSION].includes(input.identityVersion)) {
    throw IdentityError('対応していないメディア識別形式です。保存データは変更していません。');
  }
}
function VideoAliases(values = []) {
  if (!Array.isArray(values) || values.length > 10000) throw IdentityError('動画の対応情報が正しくありません。');
  const result = [], byAv = new Map(), byBV = new Map();
  for (const record of values) {
    if (!record || typeof record.aid !== 'string' || !/^[1-9]\d{0,17}$/.test(record.aid)) throw IdentityError('動画の対応情報が正しくありません。');
    const media = VideoIdentity(`av${record.aid}`, record);
    if (!media.verified || byAv.has(record.aid) && byAv.get(record.aid) !== record.bvid || byBV.has(record.bvid) && byBV.get(record.bvid) !== record.aid) throw IdentityError('avとBVの対応情報が矛盾しています。');
    if (!byAv.has(record.aid)) result.push({ aid: record.aid, bvid: record.bvid });
    byAv.set(record.aid, record.bvid); byBV.set(record.bvid, record.aid);
  }
  return result;
}
function LibraryMediaKey(values = []) {
  const map = new Map();
  for (const record of VideoAliases(values)) { map.set(`av${record.aid}`, record); map.set(record.bvid, record); }
  return entry => {
    if (entry.type === 'local') return MediaKey(entry);
    const media = VideoIdentity(entry);
    return MediaKey(entry, map.get(media.videoId));
  };
}
// 端末間の同一性に使う同期用メディアキー（SyncMediaKey）。保存形式は変更しない純粋な派生値。
// 形式：確認済みBVがあれば bili:<BV>:p<パート>、avのみなら bili-av:<aid>:p<パート>。ローカル曲はnull（ファイル名を同期の識別に使わない）。
// 曲名・所属リスト・登録曲id・mediaId・端末のパスには依存しない。検証済みの videoId / part があればURLを再解析しない。
const SYNC_KEY = /^(bili:BV[a-zA-Z0-9]{10}|bili-av:[1-9]\d{0,17}):p[1-9]\d{0,4}$/;
// 保存済みの videoId / part は、URLが同じ値から作られた正規の形（検証時にParseBilibiliが作る形）と完全に一致するときだけ使う。
// 食い違い・不正な値・未検証の項目は、URLを解析して求める（URLを正とし、保存値を無条件に信頼しない）。
function SyncKeyParts(entry) {
  const { videoId, part } = entry;
  if (typeof videoId === 'string' && /^(BV[a-zA-Z0-9]{10}|av[1-9]\d{0,17})$/.test(videoId) && Number.isInteger(part) && part >= 1 && part <= 10000
    && entry.url === `https://www.bilibili.com/video/${videoId}/${part > 1 ? `?p=${part}` : ''}`) return { videoId, part };
  const media = VideoIdentity(entry);
  return { videoId: media.videoId, part: media.part };
}
function LibrarySyncKey(values = []) {
  const map = new Map();
  for (const record of VideoAliases(values)) { map.set(`av${record.aid}`, record); map.set(record.bvid, record); }
  return entry => {
    if (!entry || entry.type === 'local') return null;
    const { videoId, part } = SyncKeyParts(entry), alias = map.get(videoId);
    if (alias) return `bili:${alias.bvid}:p${part}`;
    return videoId.startsWith('BV') ? `bili:${videoId}:p${part}` : `bili-av:${videoId.slice(2)}:p${part}`;
  };
}
// 保存済みの同期キー（bili-av:<aid>:p<n> など）を、判明済みエイリアス（bili:<bvid>:p<n>）へ正規化する。
function CanonicalMediaKey(values = []) {
  const map = new Map();
  for (const record of VideoAliases(values)) map.set(`av${record.aid}`, record.bvid);
  return key => {
    if (typeof key !== 'string') return key;
    const match = /^bili-av:([1-9]\d{0,17}):(p[1-9]\d{0,5})$/.exec(key);
    if (!match) return key;
    const bvid = map.get(`av${match[1]}`);
    return bvid ? `bili:${bvid}:${match[2]}` : key;
  };
}
// 同じ動画を指す形（確認済みのav/BV対応があれば両方）。Step6の同期で、片方の端末だけが対応を確認した場合の照合に使う。
function LibrarySyncKeyForms(values = []) {
  const map = new Map(), key = LibrarySyncKey(values);
  for (const record of VideoAliases(values)) { map.set(`av${record.aid}`, record); map.set(record.bvid, record); }
  return entry => {
    const primary = key(entry); if (!primary) return [];
    const { videoId, part } = SyncKeyParts(entry), alias = map.get(videoId);
    return alias ? [primary, `bili-av:${alias.aid}:p${part}`] : [primary];
  };
}
// 識別番号の点検（読み取り専用）。UUID（版1〜8・RFC 4122の変種）でないものの件数だけを返す。値は返さない。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function AuditIds(playlists = []) {
  const result = { lists: 0, entries: 0, media: 0, total: 0 };
  for (const p of Array.isArray(playlists) ? playlists : []) {
    result.total++; if (!UUID.test(p?.id || '')) result.lists++;
    for (const e of Array.isArray(p?.entries) ? p.entries : []) {
      result.total++; if (!UUID.test(e?.id || '')) result.entries++;
      if (e && Object.hasOwn(e, 'mediaId') && !UUID.test(e.mediaId || '')) result.media++;
    }
  }
  return result;
}

function PlanMediaIds(playlists, createId, keyOf = MediaKey) {
  const byKey = new Map(), byId = new Map(), assignments = new Map();
  const entries = playlists.flatMap(p => p.entries);
  for (const entry of entries) {
    if (!Object.hasOwn(entry, 'mediaId')) continue;
    if (typeof entry.mediaId !== 'string' || !MEDIA_ID.test(entry.mediaId)) throw IdentityError('メディア識別番号の形式が正しくありません。');
    const key = keyOf(entry), id = entry.mediaId;
    if (byKey.has(key) && byKey.get(key) !== id || byId.has(id) && byId.get(id) !== key) {
      throw IdentityError('メディア識別番号と参照先が矛盾しています。');
    }
    byKey.set(key, id); byId.set(id, key);
  }
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!byKey.has(key)) {
      const id = createId();
      if (typeof id !== 'string' || !MEDIA_ID.test(id) || byId.has(id)) throw IdentityError('重複しないメディア識別番号を生成できませんでした。');
      byKey.set(key, id); byId.set(id, key);
    }
    assignments.set(entry, byKey.get(key));
  }
  return assignments;
}

module.exports = { IDENTITY_SCHEMA_VERSION, MEDIA_ID, IdentityError, ValidateIdentityVersion, PlanMediaIds, VideoAliases, LibraryMediaKey, SYNC_KEY, LibrarySyncKey, CanonicalMediaKey, LibrarySyncKeyForms, AuditIds };
