// Test helpers: a D1-compatible adapter on top of node:sqlite, a mock Cloudflare Access
// (RSA keys + JWKS) and a mock Turso /v2/pipeline endpoint.
import { DatabaseSync } from 'node:sqlite';

export function makeD1(db, { maxParams = 100 } = {}) {
  const isRead = (sql) => /^\s*(select|with|pragma)\b/i.test(sql) && !/^\s*pragma\s+defer/i.test(sql);
  function prep(sql) {
    let params = [];
    const run1 = () => {
      if (params.length > maxParams) throw new Error(`D1_ERROR: too many SQL variables (${params.length} > ${maxParams})`);
      const st = db.prepare(sql);
      if (isRead(sql)) return { results: st.all(...params), meta: { changes: 0, last_row_id: 0 } };
      const info = st.run(...params);
      return { results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    };
    const stmt = {
      bind(...p) { params = p; return stmt; },
      async all() { return run1(); },
      async first() { const r = run1(); return r.results[0] ?? null; },
      async run() { return run1(); },
      _run: run1,
    };
    return stmt;
  }
  return {
    prepare: prep,
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

export async function makeAccess(team = 'test.cloudflareaccess.com', aud = 'AUD123') {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  async function token(over = {}, key = kp.privateKey) {
    const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const p = b64({ iss: `https://${team}`, aud: [aud], exp: Math.floor(Date.now() / 1000) + 600, email: 'philipp@example.com', ...over });
    const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p))).toString('base64url');
    return `${h}.${p}.${sig}`;
  }
  return { team, aud, jwk, token, otherKey: (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])).privateKey };
}

// Minimal Turso /v2/pipeline emulation backed by a node:sqlite database.
export function tursoHandler(db) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const results = [];
    for (const r of body.requests) {
      if (r.type === 'close') { results.push({ type: 'ok', response: { type: 'close' } }); continue; }
      try {
        const args = (r.stmt.args || []).map((a) => a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value);
        const st = db.prepare(r.stmt.sql);
        const cols = st.columns().map((c) => ({ name: c.name }));
        const rows = st.all(...args).map((row) => cols.map((c) => {
          const v = row[c.name];
          if (v === null || v === undefined) return { type: 'null' };
          if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
          if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
          return { type: 'text', value: String(v) };
        }));
        results.push({ type: 'ok', response: { type: 'execute', result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } catch (e) { results.push({ type: 'error', error: { message: e.message } }); }
    }
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export const D1_SCHEMA = `
CREATE TABLE security_parameter (ParameterID integer PRIMARY KEY, ParameterName text NOT NULL, ParaTable text NOT NULL, ParaField text NOT NULL, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE TABLE security_master (SecurityID integer PRIMARY KEY, SecurityName text NOT NULL, Collector integer REFERENCES security_parameter(ParameterID), Ticker text, ID_ISIN text, ID_Valor integer, Currency text, DashboardGrouping integer REFERENCES security_parameter(ParameterID), Instrument integer REFERENCES security_parameter(ParameterID), PortfolioGrouping integer REFERENCES security_parameter(ParameterID), DateLaunch text, DateTerminated text, Status integer REFERENCES security_parameter(ParameterID), Comments text, UBSQuotesName text, TER real, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE TABLE security_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID), Price REAL NOT NULL, Price_adjusted REAL NOT NULL, Price_date text NOT NULL, source text, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_security_prices_unique ON security_prices (SecurityID, Price_date, source);
CREATE TABLE security_collector_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, collectortype text);
CREATE TABLE security_transactions (TransactionID INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID), TrxArt INTEGER REFERENCES security_parameter(ParameterID), Quantity REAL, TrxDate TEXT);
`;
export { DatabaseSync };
