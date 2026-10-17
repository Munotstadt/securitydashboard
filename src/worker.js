// securitydashboard Worker
//
// Serves the static frontend (public/, via the ASSETS binding) and a small
// same-origin API on /api/* backed by the D1 database "securities".
//
// Everything lives under one hostname (security.munot.app), so the Cloudflare
// Access login cookie is first-party: no cross-origin cookie problems, no
// "open the API URL once so the data loads" workaround.
//
// Auth: Cloudflare Access (Google login) protects the hostname at the edge.
// As defence in depth every /api/* request additionally has its Access JWT
// verified here (signature, issuer, audience, expiry). Configure via
// wrangler.jsonc vars: ACCESS_TEAM_DOMAIN, ACCESS_AUD. Without them the API
// fails closed (503).

import { handleMigrate } from './migrate.js'; // TEMPORARY - remove after the Turso -> D1 migration

const MAX_STATEMENTS = 200;
const MAX_SQL_LENGTH = 20000;
const ALLOWED_SQL = /^\s*(select|insert|update|delete|replace|with)\b/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      const identity = await verifyAccess(request, env);
      if (identity instanceof Response) return identity;

      if (url.pathname === '/api/me' && request.method === 'GET') {
        return json({ email: identity.email || null, service: identity.common_name || null });
      }
      if (url.pathname === '/api/db' && request.method === 'POST') {
        return await handleDb(request, env);
      }
      if (url.pathname === '/api/improvements' && request.method === 'POST') {
        return await handleImprovement(request, env);
      }
      if (url.pathname === '/api/securityprices.csv' && request.method === 'GET') {
        return await handleValuationCsv(env);
      }
      if (url.pathname.startsWith('/api/admin/migrate/')) {
        return await handleMigrate(request, env, url); // TEMPORARY
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------- /api/db
// Body: { statements: [{ sql, args: [...] }, ...] }
// Response: { results: [{ rows, affected, lastInsertRowid }, ...] }
// All statements run in one D1 batch (= one transaction, all-or-nothing).
async function handleDb(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
  const statements = Array.isArray(body && body.statements) ? body.statements : null;
  if (!statements || statements.length === 0) return json({ error: 'statements[] required' }, 400);
  if (statements.length > MAX_STATEMENTS) return json({ error: `max ${MAX_STATEMENTS} statements per request` }, 400);

  const prepared = [];
  for (const s of statements) {
    const sql = s && typeof s.sql === 'string' ? s.sql : '';
    if (!sql || sql.length > MAX_SQL_LENGTH) return json({ error: 'invalid sql' }, 400);
    if (!ALLOWED_SQL.test(sql)) return json({ error: 'only SELECT/INSERT/UPDATE/DELETE are allowed (schema changes go through migrations/)' }, 400);
    // D1 rejects multiple statements per prepare() anyway; also refuse them explicitly.
    if (/;\s*\S/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) return json({ error: 'multiple statements not allowed' }, 400);
    const args = Array.isArray(s.args) ? s.args.map(normalizeArg) : [];
    prepared.push(env.DB.prepare(sql).bind(...args));
  }

  const out = await env.DB.batch(prepared);
  return json({
    results: out.map((r) => ({
      rows: r.results || [],
      affected: r.meta ? r.meta.changes : 0,
      lastInsertRowid: r.meta ? r.meta.last_row_id : null,
    })),
  });
}

function normalizeArg(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ------------------------------------------------------ /api/improvements
// Same-origin target of the floating "improvement" button. Writes into the shared
// improvement_tasks table of the D1 database "db_admin" (the one admin.munot.app reads),
// so entries show up there as before - without any cross-site call from the browser.
async function handleImprovement(request, env) {
  if (!env.ADMIN_DB) return json({ error: 'ADMIN_DB binding missing' }, 503);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const title = clip(b.title, 200);
  const sourceApp = clip(b.sourceApp, 100);
  if (!title || !sourceApp) return json({ error: 'sourceApp und title sind Pflicht' }, 400);
  const priority = ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal';
  const r = await env.ADMIN_DB.prepare(
    'INSERT INTO improvement_tasks (SourceApp, SourceUrl, Title, Note, Priority) VALUES (?, ?, ?, ?, ?)'
  ).bind(sourceApp, clip(b.sourceUrl, 500) || null, title, clip(b.note, 4000) || null, priority).run();
  return json({ ok: true, TaskID: r.meta.last_row_id }, 201);
}

// ------------------------------------------------ /api/securityprices.csv
// Latest price per in-scope security, for the local MS-Access import.
// In scope: net Quantity (Buy/Sell) != 0  OR  security_master.DashboardGrouping set.
// Same logic as portfolio.html's "Valuation CSV" button - keep both in sync.
async function handleValuationCsv(env) {
  const { results } = await env.DB.prepare(`
    WITH net AS (
      SELECT t.SecurityID AS SecurityID, SUM(t.Quantity) AS Qty
        FROM security_transactions t
        JOIN security_parameter ta ON ta.ParameterID = t.TrxArt
       WHERE ta.ParameterName IN ('Buy', 'Sell')
       GROUP BY t.SecurityID
    ),
    scope AS (
      SELECT m.SecurityID
        FROM security_master m
        LEFT JOIN net n ON n.SecurityID = m.SecurityID
       WHERE m.DashboardGrouping IS NOT NULL OR ABS(COALESCE(n.Qty, 0)) >= 1e-9
    ),
    latest AS (
      SELECT p.SecurityID, p.Price_date, p.Price, p.source,
             ROW_NUMBER() OVER (PARTITION BY p.SecurityID ORDER BY p.Price_date DESC, p.id DESC) AS rn
        FROM security_prices p
        JOIN scope s ON s.SecurityID = p.SecurityID
    )
    SELECT SecurityID, Price_date, Price, source FROM latest WHERE rn = 1 ORDER BY SecurityID
  `).all();

  const lines = ['SecurityID,PriceDate,Price,Source'];
  for (const r of results || []) {
    lines.push([csvField(r.SecurityID), csvField(r.Price_date), csvField(r.Price), csvField(r.source)].join(','));
  }
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ------------------------------------------------------ Access JWT check
let jwksCache = { at: 0, keys: null };

async function verifyAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return json({ error: 'Access not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)' }, 503);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookieValue(request, 'CF_Authorization');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const parts = token.split('.');
  if (parts.length !== 3) return json({ error: 'unauthorized' }, 401);
  let header, payload;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch (e) { return json({ error: 'unauthorized' }, 401); }

  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || payload.iss !== `https://${team}` || !aud.includes(env.ACCESS_AUD) || !payload.exp || payload.exp < now) {
    return json({ error: 'unauthorized' }, 401);
  }

  const key = await findKey(team, header.kid);
  if (!key) return json({ error: 'unauthorized' }, 401);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!ok) return json({ error: 'unauthorized' }, 401);
  return payload;
}

async function findKey(team, kid) {
  const load = async () => {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error('could not load Access certs');
    const data = await res.json();
    jwksCache = { at: Date.now(), keys: data.keys || [] };
  };
  if (!jwksCache.keys || Date.now() - jwksCache.at > 3600000) await load();
  let jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) { await load(); jwk = jwksCache.keys.find((k) => k.kid === kid); } // key rotation
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

function cookieValue(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
