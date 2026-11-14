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
    // v0.7.1：再生回数・設定（schema.sql の sync_counts / sync_prefs と同じ規則：回数は減らない、世代は大きい方、設定は新しい時刻）。countsTable=false は、まだSQLを実行していない状態
    countsTable: true, counts: new Map(), countsSeq: 0, prefs: null };
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
        for (const row of body) {
          const id = [row.device_id, row.epoch, row.month, row.media_key].join('|'), old = s.counts.get(id);
          s.counts.set(id, { seq: ++s.countsSeq, ...row, n: Math.max(old ? old.n : 0, row.n) });
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
    return { status: 404, json: {} };
  };
  return s;
}
module.exports = { jwt, KEY, CONFIG, FakeServer, T0 };
