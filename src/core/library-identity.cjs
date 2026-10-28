'use strict';
const { MediaKey } = require('./media-identity.cjs');

const IDENTITY_SCHEMA_VERSION = 1;
const MEDIA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function IdentityError(message) { return Object.assign(new Error(message), { identityDataInvalid: true }); }
function ValidateIdentityVersion(input) {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'identityVersion') && input.identityVersion !== IDENTITY_SCHEMA_VERSION) {
    throw IdentityError('対応していないメディア識別形式です。保存データは変更していません。');
  }
}
function PlanMediaIds(playlists, createId) {
  const byKey = new Map(), byId = new Map(), assignments = new Map();
  const entries = playlists.flatMap(p => p.entries);
  for (const entry of entries) {
    if (!Object.hasOwn(entry, 'mediaId')) continue;
    if (typeof entry.mediaId !== 'string' || !MEDIA_ID.test(entry.mediaId)) throw IdentityError('メディア識別番号の形式が正しくありません。');
    const key = MediaKey(entry), id = entry.mediaId;
    if (byKey.has(key) && byKey.get(key) !== id || byId.has(id) && byId.get(id) !== key) {
      throw IdentityError('メディア識別番号と参照先が矛盾しています。');
    }
    byKey.set(key, id); byId.set(id, key);
  }
  for (const entry of entries) {
    const key = MediaKey(entry);
    if (!byKey.has(key)) {
      const id = createId();
      if (typeof id !== 'string' || !MEDIA_ID.test(id) || byId.has(id)) throw IdentityError('重複しないメディア識別番号を生成できませんでした。');
      byKey.set(key, id); byId.set(id, key);
    }
    assignments.set(entry, byKey.get(key));
  }
  return assignments;
}

module.exports = { IDENTITY_SCHEMA_VERSION, MEDIA_ID, IdentityError, ValidateIdentityVersion, PlanMediaIds };
