import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../src/worker.js';
import { DatabaseSync, makeD1, makeAccess, D1_SCHEMA } from './helpers.mjs';

const ORIGIN = 'https://security.munot.app';
const access = await makeAccess();

// ---- D1 fixture --------------------------------------------------------------------------------
const d1db = new DatabaseSync(':memory:');
d1db.exec('PRAGMA foreign_keys = ON');
d1db.exec(D1_SCHEMA);
d1db.exec(`
INSERT INTO security_parameter (ParameterID, ParameterName, ParaTable, ParaField, modified_at) VALUES
 (1,'Buy','security_transactions','TrxArt','2026-08-28 00:00:00'),(2,'Sell','security_transactions','TrxArt','2026-08-28 00:00:00'),
 (3,'Dashboard','security_master','DashboardGrouping','2026-08-28 00:00:00'),(4,'Collector A','security_master','Collector','2026-08-28 00:00:00'),
 (136,'Active','security_master','Status','2026-08-28 00:00:00'),(137,'Inactive','security_master','Status','2026-08-28 00:00:00'),
 (138,'Terminated','security_master','Status','2026-08-28 00:00:00');
INSERT INTO security_master (SecurityID, SecurityName, Collector, Ticker, Currency, DashboardGrouping, Status, DateTerminated, modified_at) VALUES
 (10,'Held Stock',4,'HLD','USD',NULL,136,NULL,'2026-08-30 00:00:00'),
 (11,'Pinned FX',4,'USDCHF=X','CHF',3,137,NULL,'2026-08-30 00:00:00'),
 (12,'Sold Out',4,'OLD','CHF',NULL,NULL,'2026-02-01','2026-08-30 00:00:00'),
 (13,'Unused',4,'UNU','CHF',NULL,137,NULL,'2026-08-30 00:00:00');
INSERT INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES
 (10,100,100,'2026-10-15 12:00:00','C'),(10,101,101,'2026-10-16 12:00:00','C'),(10,102,102,'2026-10-16 18:00:00','C'),
 (12,4,4,'2026-01-15','C'),(11,0.9,0.9,'2026-10-16 18:00:00','C'),(12,5,5,'2026-10-16 18:00:00','C'),(13,1,1,'2026-10-16 18:00:00','C');
`);
const adminDb = new DatabaseSync(':memory:');
adminDb.exec("CREATE TABLE improvement_tasks (TaskID INTEGER PRIMARY KEY AUTOINCREMENT, SourceApp TEXT NOT NULL, SourceUrl TEXT, Title TEXT NOT NULL, Note TEXT, Status TEXT NOT NULL DEFAULT 'open', Priority TEXT DEFAULT 'normal', CreatedAt TEXT NOT NULL DEFAULT (datetime('now')), UpdatedAt TEXT, CompletedAt TEXT)");
const env = {
  DB: makeD1(d1db), ADMIN_DB: makeD1(adminDb), ASSETS: { fetch: async () => new Response('asset') },
  ACCESS_TEAM_DOMAIN: access.team, ACCESS_AUD: access.aud,
};

// ---- network mocks (Access JWKS) -------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === `https://${access.team}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [access.jwk] }));
  return realFetch(input, init);
};

const call = async (path, { method = 'GET', body, jwt } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (jwt !== null) headers['Cf-Access-Jwt-Assertion'] = jwt ?? await access.token();
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
};
const db = async (statements, opts) => call('/api/db', { method: 'POST', body: { statements }, ...opts });

test('static assets bypass the API auth path', async () => {
  const r = await worker.fetch(new Request(ORIGIN + '/index.html'), env);
  assert.equal(await r.text(), 'asset');
});

test('Access JWT: missing / wrong audience / expired / wrong signature / unconfigured are rejected', async () => {
  assert.equal((await call('/api/me', { jwt: null })).status, 401);
  assert.equal((await call('/api/me', { jwt: await access.token({ aud: ['other'] }) })).status, 401);
  assert.equal((await call('/api/me', { jwt: await access.token({ exp: 1 }) })).status, 401);
  assert.equal((await call('/api/me', { jwt: await access.token({}, access.otherKey) })).status, 401);
  assert.equal((await call('/api/me', { jwt: await access.token({ iss: 'https://evil.example' }) })).status, 401);
  const r = await worker.fetch(new Request(ORIGIN + '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await access.token() } }), { ...env, ACCESS_AUD: '' });
  assert.equal(r.status, 503);
  const ok = await call('/api/me');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).email, 'philipp@example.com');
});

test('/api/db: select, params, write batch, rollback, guards', async () => {
  let r = await db([{ sql: 'SELECT SecurityName FROM security_master WHERE SecurityID = ?', args: [10] }]);
  assert.deepEqual((await r.json()).results[0].rows, [{ SecurityName: 'Held Stock' }]);

  // frontend-style manual price insert + update (D1 column names, Price_adjusted NOT NULL)
  r = await db([{ sql: 'INSERT INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES (?,?,?,?,?)', args: [13, 2, 2, '2026-10-17 09:00:00', 'manual'] }]);
  const ins = (await r.json()).results[0];
  assert.equal(ins.affected, 1);
  r = await db([{ sql: "UPDATE security_prices SET Price=?, Price_adjusted=?, modified_at=datetime('now') WHERE id=?", args: [3, 3, ins.lastInsertRowid] }]);
  assert.equal((await r.json()).results[0].affected, 1);
  r = await db([{ sql: 'DELETE FROM security_prices WHERE id=?', args: [ins.lastInsertRowid] }]);
  assert.equal((await r.json()).results[0].affected, 1);

  // atomic batch: second statement violates NOT NULL -> first must be rolled back
  const before = d1db.prepare('SELECT COUNT(*) n FROM security_prices').get().n;
  r = await db([
    { sql: 'INSERT INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES (13,1,1,?,?)', args: ['2026-10-18', 'x'] },
    { sql: 'INSERT INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES (13,NULL,1,?,?)', args: ['2026-10-19', 'x'] },
  ]);
  assert.equal(r.status, 500);
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_prices').get().n, before);

  for (const sql of ['DROP TABLE security_master', 'ALTER TABLE security_master ADD COLUMN x', 'PRAGMA foreign_keys=OFF', 'SELECT 1; DELETE FROM security_prices', 'ATTACH DATABASE x AS y']) {
    assert.equal((await db([{ sql }])).status, 400, sql);
  }
  assert.equal((await db([])).status, 400);
  // a ';' inside a string literal is fine
  assert.equal((await db([{ sql: "SELECT 'a;b' AS x" }])).status, 200);
});

test('/api/improvements: writes into the shared improvement_tasks table, validates input', async () => {
  let r = await call('/api/improvements', { method: 'POST', body: { sourceApp: 'securitydashboard', sourceUrl: 'https://security.munot.app/index.html', title: '  Test  ', note: 'n', priority: 'high' } });
  assert.equal(r.status, 201);
  const id = (await r.json()).TaskID;
  assert.deepEqual({ ...adminDb.prepare('SELECT SourceApp, Title, Note, Priority, Status FROM improvement_tasks WHERE TaskID = ?').get(id) }, { SourceApp: 'securitydashboard', Title: 'Test', Note: 'n', Priority: 'high', Status: 'open' });
  r = await call('/api/improvements', { method: 'POST', body: { sourceApp: 'x', title: 'y', priority: 'bogus' } });
  assert.equal(adminDb.prepare('SELECT Priority FROM improvement_tasks WHERE TaskID = ?').get((await r.json()).TaskID).Priority, 'normal');
  assert.equal((await call('/api/improvements', { method: 'POST', body: { sourceApp: 'x', title: '   ' } })).status, 400);
  assert.equal((await call('/api/improvements', { method: 'POST', body: { title: 'no app' } })).status, 400);
  assert.equal((await call('/api/improvements', { method: 'POST', jwt: null, body: { sourceApp: 'x', title: 'y' } })).status, 401);
  assert.equal((await call('/api/improvements')).status, 404); // GET not offered
});

test('/api/securityprices.csv: active + pinned securities only, latest price, sorted', async () => {
  const r = await call('/api/securityprices.csv');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), [
    'SecurityID,PriceDate,Price,Source',
    '10,2026-10-16 18:00:00,102,C',   // Active, latest of 3 rows
    '11,2026-10-16 18:00:00,0.9,C',   // Inactive, but DashboardGrouping set
    '',
  ].join('\n'));                       // 12 (terminated 01.02.2026) and 13 (inactive) are out of scope
});

test('service tokens (no e-mail) may only read the valuation CSV', async () => {
  const svc = await access.token({ email: undefined, common_name: 'abc.access' });
  assert.equal((await call('/api/securityprices.csv?mode=latest', { jwt: svc })).status, 200);
  assert.equal((await call('/api/me', { jwt: svc })).status, 403);
  assert.equal((await db([{ sql: 'SELECT 1' }], { jwt: svc })).status, 403);
  assert.equal((await call('/api/improvements', { method: 'POST', jwt: svc, body: { sourceApp: 'x', title: 'y' } })).status, 403);
  assert.equal((await db([{ sql: 'SELECT 1' }])).status, 200); // normal user unaffected
});

test('/api/securityprices.csv?mode=close: closing price as of a date, terminations as of that date', async () => {
  const csv = async (q) => { const r = await call('/api/securityprices.csv' + q); return [r.status, await r.text()]; };
  const H = 'SecurityID,PriceDate,Price,Source\n';
  // 15.10.2026: only security 10 has a price up to that day; 11 has none yet
  assert.deepEqual(await csv('?mode=close&asof=15.10.2026'), [200, H + '10,2026-10-15 12:00:00,100,C\n']);
  // 16.10.2026 (ISO input): last price of that day
  assert.deepEqual(await csv('?mode=close&asof=2026-10-16'), [200, H + '10,2026-10-16 18:00:00,102,C\n11,2026-10-16 18:00:00,0.9,C\n']);
  // 20.01.2026: security 12 was not yet terminated (01.02.2026) -> in scope with its price of 15.01.2026; 10 has no price yet
  assert.deepEqual(await csv('?mode=close&asof=20.01.2026'), [200, H + '12,2026-01-15,4,C\n']);
  // default mode = latest
  assert.equal((await csv('?mode=latest'))[1], (await csv(''))[1]);
  // invalid input
  assert.equal((await csv('?mode=close'))[0], 400);
  assert.equal((await csv('?mode=close&asof=31.02.2026'))[0], 400);
  assert.equal((await csv('?mode=bogus'))[0], 400);
});

// ---- client library (public/assets/db-data.js) against the real Worker --------------------------
test('client db-data.js: coercion, session-expiry handling, chunked IN queries (D1 100-param limit)', async () => {
  const store = new Map();
  const sandbox = {
    console, Intl, Date, Math, JSON, Map, Set, Promise, Number, String, Array, Object, RegExp, Error, parseInt, parseFloat, isNaN, isFinite, setTimeout,
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
    location: { reload() { sandbox.__reloads = (sandbox.__reloads || 0) + 1; } },
    fetch: async (path, init) => {
      if (sandbox.__expired) return { type: 'opaqueredirect', status: 0, ok: false };
      return worker.fetch(new Request(ORIGIN + path, { method: init.method, headers: { ...init.headers, 'Cf-Access-Jwt-Assertion': await access.token() }, body: init.body }), env);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/assets/db-data.js', import.meta.url), 'utf8') +
    '\nthis.api = { dbQuery, dbRun, dbBatch, dbQueryIn, dbClearCache, dbCacheCount, dbSecurityIsInactiveOrTerminated };', sandbox);
  const { api } = sandbox;

  // "10" from a <select> must match the INTEGER SecurityID
  assert.equal((await api.dbQuery('SELECT SecurityName FROM security_master WHERE SecurityID = ?', ['10']))[0].SecurityName, 'Held Stock');

  // caching: second call served from sessionStorage until a write clears it
  await api.dbQuery('SELECT COUNT(*) n FROM security_master', [], 60000);
  assert.equal(api.dbCacheCount(), 1);
  await api.dbRun("UPDATE security_master SET Comments = 'x' WHERE SecurityID = ?", [13]);
  assert.equal(api.dbCacheCount(), 0);

  // 300 ids -> would exceed D1's 100 parameters in ONE statement; chunking must work
  const ids = Array.from({ length: 300 }, (_, i) => i + 1);
  await assert.rejects(api.dbQuery(`SELECT SecurityID FROM security_master WHERE SecurityID IN (${ids.map(() => '?').join(',')})`, ids), /too many SQL variables/);
  const rows = await api.dbQueryIn((ph) => `SELECT SecurityID FROM security_master WHERE SecurityID IN (${ph})`, ids);
  assert.deepEqual(rows.map((r) => r.SecurityID).sort((a, b) => a - b), [10, 11, 12, 13]);
  // head args + chunking (security.html tiered price history pattern)
  const px = await api.dbQueryIn((ph) => `SELECT id FROM security_prices WHERE SecurityID = ? AND id IN (${ph})`, Array.from({ length: 250 }, (_, i) => i + 1), [10]);
  assert.equal(px.length, 3);

  // task renewal: only Active/Pending securities need a follow-up task
  d1db.exec(`INSERT INTO security_master (SecurityID, SecurityName, Status, DateTerminated) VALUES
    (20,'Active Sec',136,NULL),(21,'Inactive Sec',137,NULL),(22,'Terminated Sec',138,NULL),(23,'Pending Sec',NULL,NULL),(24,'Gone By Date',136,'2020-01-01');`);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated(20), false);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated(21), true);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated('22'), true);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated(23), false);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated(24), true);
  assert.equal(await api.dbSecurityIsInactiveOrTerminated(null), false);

  // expired Access session -> one automatic reload, readable error
  sandbox.__expired = true;
  await assert.rejects(api.dbQuery('SELECT 1'), /Sitzung abgelaufen/);
  await assert.rejects(api.dbQuery('SELECT 1'), /Sitzung abgelaufen/);
  assert.equal(sandbox.__reloads, 1, 'reload loop protection');
});

// ---- security_data history (public/assets/data-history.js + migrations/0009) ---------------------
test('data-history.js: groups one metric across AsOfDates, chronological, tolerates dd.mm.yyyy', () => {
  const sandbox = { console, Map, Set, Number, String, Array, Object, Math, Date, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/assets/data-history.js', import.meta.url), 'utf8'), sandbox);
  const DH = sandbox.DataHistory;
  const rows = [
    { RowId: 1, DataType: 'FundPortfolio', FieldNameID: 148, FieldName: 'P/E Ratio', NumericValue: 21.4, AsOfDate: '2026-09-29', Source: 'iShares' },
    { RowId: 2, DataType: 'FundPortfolio', FieldNameID: 148, FieldName: 'P/E Ratio', NumericValue: 19.8, AsOfDate: '2026-08-19', Source: 'iShares' },
    { RowId: 3, DataType: 'FundPortfolio', FieldNameID: 146, FieldName: 'P/B Ratio', NumericValue: 3.1, AsOfDate: '2026-08-19', Source: 'iShares' },
    { RowId: 4, DataType: 'FundOperations', FieldNameID: 133, FieldName: 'TER', NumericValue: 0.2, AsOfDate: '14.08.2026', Source: 'TEST' },
    { RowId: 5, DataType: 'TopHolding', FieldNameID: null, FieldName: 'Nestle', NumericValue: 5, AsOfDate: '2026-08-13' },
    { RowId: 6, DataType: 'TopHolding', FieldNameID: null, FieldName: 'nestle ', NumericValue: 6, AsOfDate: '2026-09-13' },
  ];
  const pe = DH.seriesFor(rows, DH.keyOf(rows[0]));
  assert.deepEqual(Array.from(pe, (r) => r.RowId), [2, 1]);
  assert.equal(DH.isoDate('14.08.2026'), '2026-08-14');
  assert.equal(DH.isoDate('13.08.2026 13:23:05'), '2026-08-13');
  assert.equal(DH.isoDate('2026-08-13 10:00:00'), '2026-08-13');
  assert.equal(DH.seriesFor(rows, DH.keyOf(rows[3]))[0]._date, '2026-08-14');
  const counts = DH.countsByKey(rows);
  assert.equal(counts.get(DH.keyOf(rows[0])), 2);
  assert.equal(counts.get(DH.keyOf(rows[2])), 1);
  assert.equal(counts.get(DH.keyOf(rows[4])), 2, 'holdings without ParameterID group by (normalised) name');
  assert.equal(DH.fmtCompact(1.5e9).endsWith('Mrd'), true);
});

test('migration 0009: ISO dates, duplicate cleanup, unique index per metric/date/source', () => {
  const m = new DatabaseSync(':memory:');
  m.exec(`CREATE TABLE security_data (id INTEGER PRIMARY KEY, SecurityID INTEGER NOT NULL, DataType TEXT NOT NULL, FieldNameID INTEGER,
    FieldName TEXT, FieldValue TEXT, NumericValue REAL, Unit TEXT, AsOfDate TEXT NOT NULL, Source TEXT, created_at TEXT);
  INSERT INTO security_data (id, SecurityID, DataType, FieldNameID, FieldName, FieldValue, NumericValue, Unit, AsOfDate, Source) VALUES
    (3927, 14969376, 'FundOperations', 133, 'TER', NULL, 0.2, '%', '14.08.2026', 'TEST'),
    (500, 1, 'UBS Quotes', 143, 'UBS', 'Name', NULL, NULL, '13.08.2026 13:23:05', 'UBS Quotes Import (Uploader)'),
    (11337, 3614439, 'FundOperations', 134, 'TradingCurrency', 'DE EUR', NULL, NULL, '2026-08-21', 'Manual Entry'),
    (11338, 3614439, 'FundOperations', 134, 'TradingCurrency', 'DE EUR', NULL, NULL, '2026-08-21', 'Manual Entry'),
    (61888, 35987944, 'FundOperations', 134, 'TradingCurrency', 'SIX CHF', NULL, NULL, '2026-11-20', 'Manual Entry'),
    (61889, 35987944, 'FundOperations', 134, 'TradingCurrency', NULL, 0.11, '%', '2026-11-20', 'Manual Entry'),
    (700, 1, 'Fundamental', 77, 'trailingPE', NULL, 20, NULL, '2026-10-11', 'yfinance'),
    (701, 1, 'Fundamental', 77, 'trailingPE', NULL, 20, NULL, '2026-10-11', 'yfinance'),
    (800, 1, 'TopHolding', NULL, 'Nestle', NULL, 5, '%', '2026-10-11', 'yfinance');`);
  m.exec(fs.readFileSync(new URL('../migrations/0009_security_data_history.sql', import.meta.url), 'utf8'));
  const get = (id) => m.prepare('SELECT * FROM security_data WHERE id = ?').get(id);
  assert.equal(get(3927).AsOfDate, '2026-08-14');
  assert.equal(get(500).AsOfDate, '2026-08-13');
  assert.equal(get(11338), undefined);
  assert.equal(get(61889).FieldNameID, 135);
  // a second manual value for the same metric/date/source is rejected, a new date is fine
  const ins = m.prepare(`INSERT INTO security_data (SecurityID, DataType, FieldNameID, NumericValue, AsOfDate, Source) VALUES (?,?,?,?,?,?)`);
  assert.throws(() => ins.run(35987944, 'FundOperations', 135, 0.12, '2026-11-20', 'Manual Entry'), /UNIQUE/);
  ins.run(35987944, 'FundOperations', 135, 0.12, '2026-11-27', 'Manual Entry');
  ins.run(35987944, 'FundOperations', 135, 0.12, '2026-11-20', 'SIX');
  // yfinance and holdings stay outside the index (collector not in this repo)
  ins.run(1, 'Fundamental', 77, 21, '2026-10-11', 'yfinance');
  // idempotent: running it again changes nothing and does not fail
  m.exec(fs.readFileSync(new URL('../migrations/0009_security_data_history.sql', import.meta.url), 'utf8'));
  assert.equal(get(11337).FieldValue, 'DE EUR');
});
