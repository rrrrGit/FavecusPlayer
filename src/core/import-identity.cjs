'use strict';
const { PlanMediaIds, MEDIA_ID, IdentityError } = require('./library-identity.cjs');

function PlanImportIdentity(existing, playlists, roots, { keyOf, createId, preserveIds = true }) {
  const lists = structuredClone(playlists), used = new Set(), reserved = new Set(), idMap = new Map();
  for (const p of existing) { used.add(p.id); for (const e of p.entries) used.add(e.id); }
  for (const p of lists) { reserved.add(p.id); for (const e of p.entries) { reserved.add(e.id); if (e.mediaId) reserved.add(e.mediaId); } }
  const generate = occupied => {
    for (let i = 0; i < 16; i++) { const id = createId(); if (typeof id === 'string' && MEDIA_ID.test(id) && !occupied.has(id) && !reserved.has(id)) return id; }
    throw IdentityError('衝突しない取り込み用IDを生成できません。');
  };
  const registration = id => { const next = preserveIds && !used.has(id) ? id : generate(used); used.add(next); idMap.set(id, next); return next; };
  for (const p of lists) { p.id = registration(p.id); for (const e of p.entries) e.id = registration(e.id); }
  for (const p of lists) p.childIds = p.childIds.map(id => idMap.get(id));
  const assignments = PlanMediaIds(existing, createId, keyOf), byKey = new Map(), byId = new Map();
  for (const [e, id] of assignments) { byKey.set(keyOf(e), id); byId.set(id, keyOf(e)); }
  for (const p of lists) for (const e of p.entries) {
    const key = keyOf(e);
    if (!byKey.has(key)) {
      const candidate = preserveIds && e.mediaId;
      const id = candidate && MEDIA_ID.test(candidate) && !byId.has(candidate) ? candidate : generate(byId);
      byKey.set(key, id); byId.set(id, key);
    }
    e.mediaId = byKey.get(key);
  }
  return { playlists: lists, rootPlaylistIds: roots.map(id => idMap.get(id)), idMap };
}
module.exports = { PlanImportIdentity };
