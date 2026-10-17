// Test helpers: a D1-compatible adapter on top of node:sqlite, a mock Cloudflare Access
// (RSA keys + JWKS).
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

export const D1_SCHEMA = `
CREATE TABLE security_parameter (ParameterID integer PRIMARY KEY, ParameterName text NOT NULL, ParaTable text NOT NULL, ParaField text NOT NULL, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE TABLE security_master (SecurityID integer PRIMARY KEY, SecurityName text NOT NULL, Collector integer REFERENCES security_parameter(ParameterID), Ticker text, ID_ISIN text, ID_Valor integer, Currency text, DashboardGrouping integer REFERENCES security_parameter(ParameterID), Instrument integer REFERENCES security_parameter(ParameterID), PortfolioGrouping integer REFERENCES security_parameter(ParameterID), DateLaunch text, DateTerminated text, Status integer REFERENCES security_parameter(ParameterID), Comments text, UBSQuotesName text, TER real, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE TABLE security_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID), Price REAL NOT NULL, Price_adjusted REAL NOT NULL, Price_date text NOT NULL, source text, created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_security_prices_unique ON security_prices (SecurityID, Price_date, source);
CREATE TABLE security_collector_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, collectortype text);
CREATE TABLE security_transactions (TransactionID INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID), TrxArt INTEGER REFERENCES security_parameter(ParameterID), Quantity REAL, TrxDate TEXT);
`;
export { DatabaseSync };
