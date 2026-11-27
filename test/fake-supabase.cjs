'use strict';
// 偽のSupabase（メモリ上のPostgREST/Auth）。同期の検証用。連番はコミット順（supabase/schema.sqlのトリガーと同じ）。
const assert = require('node:assert/strict');
const X = require('../src/core/sync-supabase.cjs');
const T0 = Date.UTC(2026, 10, 13);
const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature-signature';
const KEY = jwt('anon');
const CONFIG = X.SupabaseConfig({ url: 'https://abcdefgh.supabase.co', anonKey: KEY });

// 偽のSupabase。連番はコミット順（schema.sqlのトリガーと同じ）。再送（同じbatch/idx）は無視するが連番は消費する。
function FakeServer(options = {}) {
  const s = { rows: [], lastSeq: 0, watermark: 0, requests: [], online: true, down: 0, ttl: 3600, now: options.now ?? T0, tokens: new Map(), codes: new Map(), refreshCount: 0, failNext401: 0,
    // v0.7.1〜v0.7.5：再生回数・設定・お気に入り・再生履歴（schema.sql と同じ規則）
    countsTable: true, counts: new Map(), countsSeq: 0, prefs: null,
    favoritesTable: true, favorites: new Map(), favoritesSeq: 0,
    historyTable: true, history: new Map(), historySeq: 0, historyState: null,
    activityTable: true, activityLogs: new Map() };
  const issue = user => {
    const n = s.tokens.size + 1, access = `acc-${n}`, refresh = `ref-${n}`;
    s.tokens.set(access, { user, exp: Math.floor(s.now / 1000) + s.ttl }); s.tokens.set(refresh, { user, refresh: true });
    return { access_token: access, refresh_token: refresh, expires_in: s.ttl, user: { id: user } };
  };
  s.request = async (method, rawUrl, { headers = {}, body } = {}) => {
    s.requests.push({ method, rawUrl, headers, body });
    if (!s.online) throw new Error('network');
    if (s.down) return { status: s.down, json: null };
    const u = new URL(rawUrl), path = u.pathname;
    if (headers.apikey !== KEY) return { status: 401, json: {} };
    if (path === '/auth/v1/otp') { s.codes.set(body.email, '123456'); return { status: 200, json: {} }; }
    if (path === '/auth/v1/verify') return s.codes.get(body.email) === body.token ? { status: 200, json: issue('user-1') } : { status: 403, json: {} };
    if (path === '/auth/v1/token') {
      const t = s.tokens.get(body.refresh_token);
      if (!t || !t.refresh) return { status: 400, json: {} };
      s.refreshCount++; return { status: 200, json: issue(t.user) };
    }
    const token = s.tokens.get(String(headers.Authorization || '').replace('Bearer ', ''));
    if (!token || token.refresh || token.exp <= Math.floor(s.now / 1000) || s.failNext401-- > 0) return { status: 401, json: {} };
    if (path === '/rest/v1/sync_meta') return { status: 200, json: [{ last_seq: s.lastSeq, watermark: s.watermark }] };
    if (path === '/rest/v1/sync_changes' && method === 'POST') {
      assert.ok(body.length <= 500, 'chunked');
      for (const row of body) { s.lastSeq++; if (!s.rows.some(r => r.batch_id === row.batch_id && r.idx === row.idx)) s.rows.push({ seq: s.lastSeq, ...row }); }
      return { status: 201, json: null };
    }
    if (path === '/rest/v1/sync_changes' && method === 'GET') {
      const after = Number(u.searchParams.get('seq').replace('gt.', '')), limit = Number(u.searchParams.get('limit'));
      return { status: 200, json: s.rows.filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map(r => ({ seq: r.seq, record_id: r.record_id, f: r.f })) };
    }
    if (path === '/rest/v1/rpc/sync_compact') {
      const before = s.rows.length; s.rows = s.rows.filter(r => !body.p_ids.includes(r.record_id) || s.rows.some(n => n.record_id === r.record_id && n.seq > body.p_upto));
      if (s.rows.length < before) s.watermark = s.lastSeq;
      return { status: 200, json: before - s.rows.length };
    }
    if (path === '/rest/v1/sync_counts_meta' || path === '/rest/v1/sync_counts' || path === '/rest/v1/sync_prefs') {
      if (!s.countsTable) return { status: 404, json: { code: 'PGRST205' } };
      if (path === '/rest/v1/sync_counts_meta') return { status: 200, json: [{ last_seq: s.countsSeq }] };
      if (path === '/rest/v1/sync_counts' && method === 'POST') {
        const seen = new Set();
        for (const row of body) {
          const id = [row.device_id, row.epoch, row.month, row.media_key].join('|');
          if (seen.has(id)) return { status: 400, json: { code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } };
          seen.add(id);
        }
        for (const row of body) {
          const id = [row.device_id, row.epoch, row.month, row.media_key].join('|'), old = s.counts.get(id);
          if (old && row.n <= old.n) continue;
          s.counts.set(id, { seq: ++s.countsSeq, ...row });
        }
        return { status: 201, json: null };
      }
      if (path === '/rest/v1/sync_counts') {
        const after = Number(u.searchParams.get('seq').replace('gt.', '')), limit = Number(u.searchParams.get('limit'));
        return { status: 200, json: [...s.counts.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit) };
      }
      if (method === 'GET') return { status: 200, json: s.prefs ? [{ ...s.prefs }] : [] };
      const row = body[0], old = s.prefs;
      s.prefs = !old ? { ...row } : { epoch: Math.max(old.epoch, row.epoch), ...(row.weighted_at > old.weighted_at ? { weighted_shuffle: row.weighted_shuffle, weighted_at: row.weighted_at } : { weighted_shuffle: old.weighted_shuffle, weighted_at: old.weighted_at }) };
      return { status: 201, json: null };
    }
    if (path === '/rest/v1/sync_favorites') {
      if (!s.favoritesTable) return { status: 404, json: { code: 'PGRST205' } };
      if (method === 'POST') {
        const seen = new Set();
        for (const row of body) { if (seen.has(row.media_key)) return { status: 400, json: { code: '21000' } }; seen.add(row.media_key); }
        for (const row of body) {
          const updatedAt = Math.min(row.updated_at, s.now + 600000), old = s.favorites.get(row.media_key);
          if (old && (updatedAt < old.updated_at || (updatedAt === old.updated_at && (old.fav || !row.fav)))) continue;
          s.favorites.set(row.media_key, { seq: ++s.favoritesSeq, ...row, updated_at: updatedAt });
        }
        return { status: 201, json: null };
      }
      const after = Number(u.searchParams.get('seq').replace('gt.', '')), limit = Number(u.searchParams.get('limit'));
      return { status: 200, json: [...s.favorites.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit) };
    }
    if (path === '/rest/v1/sync_history' || path === '/rest/v1/sync_history_state') {
      if (!s.historyTable) return { status: 404, json: { code: 'PGRST205' } };
      if (path === '/rest/v1/sync_history' && method === 'POST') {
        const seen = new Set();
        for (const row of body) { if (seen.has(row.media_key)) return { status: 400, json: { code: '21000' } }; seen.add(row.media_key); }
        const cleared = s.historyState ? s.historyState.cleared_at : 0;
        for (const row of body) {
          const playedAt = Math.min(row.played_at, s.now + 600000), old = s.history.get(row.media_key);
          if (cleared >= playedAt || (old && playedAt <= old.played_at)) continue;
          s.history.set(row.media_key, { seq: ++s.historySeq, ...row, played_at: playedAt });
        }
        return { status: 201, json: null };
      }
      if (path === '/rest/v1/sync_history') {
        const after = Number(u.searchParams.get('seq').replace('gt.', '')), limit = Number(u.searchParams.get('limit'));
        return { status: 200, json: [...s.history.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit) };
      }
      if (method === 'GET') return { status: 200, json: s.historyState ? [{ ...s.historyState }] : [] };
      const clearedAt = Math.min(body[0].cleared_at, s.now + 599000);
      if (!s.historyState || clearedAt > s.historyState.cleared_at) {
        s.historyState = { cleared_at: clearedAt };
        for (const [k, row] of s.history) if (row.played_at <= clearedAt) s.history.delete(k);
      }
      return { status: 201, json: null };
    }
    if (path === '/rest/v1/sync_activity_logs') {
      if (!s.activityTable) return { status: 404, json: { code: 'PGRST205' } };
      if (method === 'POST') {
        const seen = new Set();
        for (const row of body) {
          const id = `${row.device_id}|${row.day}`;
          if (seen.has(id)) return { status: 400, json: { code: '21000' } };
          seen.add(id);
        }
        for (const row of body) s.activityLogs.set(`${row.device_id}|${row.day}`, { ...row });
        return { status: 201, json: null };
      }
      if (method === 'DELETE') {
        const device = (u.searchParams.get('device_id') || '').replace(/^eq\./, '');
        const lt = (u.searchParams.get('day') || '').replace(/^lt\./, '');
        for (const [k, row] of s.activityLogs) {
          if ((!device || row.device_id === device) && (!lt || row.day < lt)) s.activityLogs.delete(k);
        }
        return { status: 204, json: null };
      }
      return { status: 200, json: [...s.activityLogs.values()] };
    }
    return { status: 404, json: {} };
  };
  return s;
}
module.exports = { jwt, KEY, CONFIG, FakeServer, T0 };
