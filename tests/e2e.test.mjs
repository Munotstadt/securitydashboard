import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../src/worker.js';
import { DatabaseSync, makeD1, makeAccess, tursoHandler, D1_SCHEMA } from './helpers.mjs';

const ORIGIN = 'https://security.munot.app';
const access = await makeAccess();

// ---- D1 fixture --------------------------------------------------------------------------------
const d1db = new DatabaseSync(':memory:');
d1db.exec('PRAGMA foreign_keys = ON');
d1db.exec(D1_SCHEMA);
d1db.exec(`
INSERT INTO security_parameter (ParameterID, ParameterName, ParaTable, ParaField, modified_at) VALUES
 (1,'Buy','security_transactions','TrxArt','2026-08-28 00:00:00'),(2,'Sell','security_transactions','TrxArt','2026-08-28 00:00:00'),
 (3,'Dashboard','security_master','DashboardGrouping','2026-08-28 00:00:00'),(4,'Collector A','security_master','Collector','2026-08-28 00:00:00');
INSERT INTO security_master (SecurityID, SecurityName, Collector, Ticker, Currency, DashboardGrouping, modified_at) VALUES
 (10,'Held Stock',4,'HLD','USD',NULL,'2026-08-30 00:00:00'),
 (11,'Pinned FX',4,'USDCHF=X','CHF',3,'2026-08-30 00:00:00'),
 (12,'Sold Out',4,'OLD','CHF',NULL,'2026-08-30 00:00:00'),
 (13,'Unused',4,'UNU','CHF',NULL,'2026-08-30 00:00:00');
INSERT INTO security_transactions (SecurityID, TrxArt, Quantity, TrxDate) VALUES (10,1,100,'2026-01-01'),(12,1,50,'2026-01-01'),(12,2,-50,'2026-02-01');
INSERT INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES
 (10,100,100,'2026-10-15 12:00:00','C'),(10,101,101,'2026-10-16 12:00:00','C'),(10,102,102,'2026-10-16 18:00:00','C'),
 (11,0.9,0.9,'2026-10-16 18:00:00','C'),(12,5,5,'2026-10-16 18:00:00','C'),(13,1,1,'2026-10-16 18:00:00','C');
`);
const env = {
  DB: makeD1(d1db), ASSETS: { fetch: async () => new Response('asset') },
  ACCESS_TEAM_DOMAIN: access.team, ACCESS_AUD: access.aud,
  TURSO_DATABASE_URL: 'libsql://turso.test', TURSO_AUTH_TOKEN: 'x',
};

// ---- network mocks (Access JWKS + Turso) -------------------------------------------------------
const tdb = new DatabaseSync(':memory:');
const turso = tursoHandler(tdb);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === `https://${access.team}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [access.jwk] }));
  if (url === 'https://turso.test/v2/pipeline') return turso(url, init);
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

test('/api/securityprices.csv: holdings + pinned securities only, latest price, sorted', async () => {
  const r = await call('/api/securityprices.csv');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), [
    'SecurityID,PriceDate,Price,Source',
    '10,2026-10-16 18:00:00,102,C',   // net qty 100, latest of 3 rows
    '11,2026-10-16 18:00:00,0.9,C',   // DashboardGrouping set, no position
    '',
  ].join('\n'));                       // 12 (net 0) and 13 (unused) are out of scope
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
    '\nthis.api = { dbQuery, dbRun, dbBatch, dbQueryIn, dbClearCache, dbCacheCount };', sandbox);
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

  // expired Access session -> one automatic reload, readable error
  sandbox.__expired = true;
  await assert.rejects(api.dbQuery('SELECT 1'), /Sitzung abgelaufen/);
  await assert.rejects(api.dbQuery('SELECT 1'), /Sitzung abgelaufen/);
  assert.equal(sandbox.__reloads, 1, 'reload loop protection');
});

// ---- migration module against a mock Turso ------------------------------------------------------
test('migration: report, sync (dry+real), copy, prices (dry+real), indexes, verify', async () => {
  tdb.exec(`
CREATE TABLE security_parameter (ParameterID integer PRIMARY KEY, ParameterName text NOT NULL, ParaTable text NOT NULL, ParaField text NOT NULL, created_at text, modified_at text);
CREATE TABLE security_master (SecurityID integer PRIMARY KEY, SecurityName text NOT NULL, Collector integer, Ticker text, ID_ISIN text, ID_Valor integer, Currency text, DashboardGrouping integer, Instrument integer, PortfolioGrouping integer, DateLaunch text, DateTerminated text, Status integer, Comments text, created_at text, modified_at text, TursoOnlyCol text);
CREATE TABLE security_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL, Price REAL NOT NULL, PriceDate TEXT NOT NULL, Source TEXT, created_at TEXT, UNIQUE(SecurityID, PriceDate));
CREATE TABLE security_transactions (TransactionID INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID), TrxArt INTEGER, Quantity REAL, TrxDate TEXT);
CREATE TABLE security_tasks (TaskID INTEGER PRIMARY KEY AUTOINCREMENT, TaskName TEXT NOT NULL, DateDue TEXT, Completed INTEGER DEFAULT 0);
CREATE INDEX idx_tasks_due ON security_tasks(DateDue);
CREATE TABLE security_collector_runs (id INTEGER PRIMARY KEY, collectortype text);
CREATE TABLE collector_runs (id INTEGER PRIMARY KEY, x text);
INSERT INTO security_parameter VALUES (1,'Buy','security_transactions','TrxArt',NULL,'2026-08-28 00:00:00'),(2,'Sell','security_transactions','TrxArt',NULL,'2026-08-28 00:00:00'),(3,'Dashboard','security_master','DashboardGrouping',NULL,'2026-08-28 00:00:00'),(4,'Collector A','security_master','Collector',NULL,'2026-08-28 00:00:00'),(5,'NewParam','security_master','Status',NULL,'2026-09-20 00:00:00');
INSERT INTO security_master (SecurityID, SecurityName, Collector, Ticker, Currency, DashboardGrouping, modified_at, TursoOnlyCol) VALUES
 (10,'Held Stock RENAMED',4,'HLD','USD',NULL,'2026-09-25 00:00:00','a'),
 (11,'Pinned FX',4,'USDCHF=X','CHF',3,'2026-08-01 00:00:00','b'),
 (12,'Sold Out',4,'OLD','CHF',NULL,'2026-08-30 00:00:00','c'),
 (13,'Unused',4,'UNU','CHF',NULL,'2026-08-30 00:00:00','d'),
 (14,'Added in Turso after Sep 1',4,'NEW','EUR',NULL,'2026-09-30 00:00:00','e');
INSERT INTO security_transactions (SecurityID, TrxArt, Quantity, TrxDate) VALUES (10,1,100,'2026-01-01'),(14,1,7,'2026-09-30'),(12,1,50,'2026-01-01');
INSERT INTO security_tasks (TaskName, DateDue) VALUES ('t1','2026-10-20'),('t2','2026-11-01');
INSERT INTO security_collector_runs VALUES (1,'old');
-- prices: (10) intraday rows already in D1 (any time same day+source) must NOT be re-added;
-- an old intraday row on a day D1 thinned still has its 1/day row -> skipped; manual + UBS rows are missing in D1 -> added
INSERT INTO security_prices (SecurityID, Price, PriceDate, Source) VALUES
 (10,100,'2026-10-15 09:00:00','C'),(10,100.5,'2026-10-15 15:00:00','C'),(10,101,'2026-10-16 12:00:00','C'),(10,102,'2026-10-16 18:00:00','C'),
 (10,99,'2026-09-01','UBS Quotes'),(10,98,'2026-09-02 10:00:00','manual'),
 (14,50,'2026-10-01','manual'),(11,0.9,'2026-10-16 18:00:00','C'),(11,0.8,'1999-01-01',NULL);
`);

  const rep = await (await call('/api/admin/migrate/report')).json();
  const by = Object.fromEntries(rep.tables.map((t) => [t.table, t]));
  assert.equal(by.security_tasks.in_d1, false);
  assert.match(by.security_tasks.plan, /copy/);
  assert.match(by.security_collector_runs.plan, /NOT touched/);
  assert.match(by.collector_runs.plan, /skipped/);
  assert.deepEqual(by.security_master.only_in_turso_columns, ['TursoOnlyCol']);

  d1db.exec('UPDATE security_master SET Comments = NULL WHERE SecurityID = 13'); // undo the client test's write
  // parameters + master: dry run changes nothing
  let s = await (await call('/api/admin/migrate/sync?table=security_parameter&dry=1', { method: 'POST' })).json();
  assert.deepEqual(s.to_insert, [5]);
  s = await (await call('/api/admin/migrate/sync?table=security_master&dry=1', { method: 'POST' })).json();
  assert.deepEqual(s.to_insert, [14]);
  assert.deepEqual(s.to_update.map((u) => u.id), [10]);       // Turso newer -> update
  assert.equal(s.differs_but_d1_newer_or_equal.length, 0);
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_master').get().n, 4);

  // real run: parameters first (FK), then master
  await call('/api/admin/migrate/sync?table=security_parameter', { method: 'POST' });
  s = await (await call('/api/admin/migrate/sync?table=security_master', { method: 'POST' })).json();
  assert.deepEqual(s.applied, { inserted: 1, updated: 1 }, JSON.stringify(s).slice(0, 400));
  assert.equal(d1db.prepare('SELECT SecurityName FROM security_master WHERE SecurityID=10').get().SecurityName, 'Held Stock RENAMED');
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_master').get().n, 5);
  // idempotent
  s = await (await call('/api/admin/migrate/sync?table=security_master&dry=1', { method: 'POST' })).json();
  assert.equal(s.to_insert.length + s.to_update.length, 0);

  // copy missing tables in small steps (rows=1 forces resumption), FK-defer for transactions to D1's existing rows
  d1db.exec('DELETE FROM security_transactions');           // table exists in D1 fixture but empty -> allowed
  let off = 0, steps = 0, r;
  do { r = await (await call(`/api/admin/migrate/copy?table=security_transactions&offset=${off}&rows=1`, { method: 'POST' })).json(); off = r.next_offset; steps++; } while (!r.done);
  assert.equal(steps, 3);
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_transactions').get().n, 3);
  r = await (await call('/api/admin/migrate/copy?table=security_tasks&offset=0&rows=100', { method: 'POST' })).json();
  assert.equal(r.done, true);
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_tasks').get().n, 2);
  // refuses to silently overwrite a non-empty table, allows explicit reset
  assert.match((await (await call('/api/admin/migrate/copy?table=security_tasks&offset=0', { method: 'POST' })).json()).error, /reset=1/);
  r = await (await call('/api/admin/migrate/copy?table=security_tasks&offset=0&reset=1', { method: 'POST' })).json();
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_tasks').get().n, 2);

  // indexes of copied tables
  const ix = await (await call('/api/admin/migrate/indexes', { method: 'POST' })).json();
  assert.ok(ix.created.includes('idx_tasks_due'));
  assert.ok(d1db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_tasks_due'").get());

  // prices: dry run first
  const beforePrices = d1db.prepare('SELECT COUNT(*) n FROM security_prices').get().n;
  let after = 0, add = 0, p;
  do { p = await (await call(`/api/admin/migrate/prices?after=${after}&limit=1&dry=1`, { method: 'POST' })).json(); if (!p.done) { after = p.next_after; add += p.would_insert_or_inserted; } } while (!p.done);
  assert.equal(add, 4);   // 10: UBS(09-01) + manual(09-02); 14: manual; 11: 1999 row with NULL source
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_prices').get().n, beforePrices);
  after = 0;
  do { p = await (await call(`/api/admin/migrate/prices?after=${after}&limit=2`, { method: 'POST' })).json(); if (!p.done) after = p.next_after; } while (!p.done);
  assert.equal(d1db.prepare('SELECT COUNT(*) n FROM security_prices').get().n, beforePrices + 4);
  const manual = d1db.prepare("SELECT Price, Price_adjusted FROM security_prices WHERE SecurityID=10 AND source='manual'").get();
  assert.deepEqual({ ...manual }, { Price: 98, Price_adjusted: 98 });
  // intraday rows that D1 already covers (same day+source) were NOT duplicated
  assert.equal(d1db.prepare("SELECT COUNT(*) n FROM security_prices WHERE SecurityID=10 AND source='C'").get().n, 3);
  // re-run is a no-op
  after = 0; add = 0;
  do { p = await (await call(`/api/admin/migrate/prices?after=${after}&limit=5&dry=1`, { method: 'POST' })).json(); if (!p.done) { after = p.next_after; add += p.would_insert_or_inserted; } } while (!p.done);
  assert.equal(add, 0);

  const v = await (await call('/api/admin/migrate/verify')).json();
  assert.equal(v.all_ok, true);
  assert.ok(!v.tables.some((t) => t.table === 'security_collector_runs'));
  assert.match((await (await call('/api/admin/migrate/copy?table=security_collector_runs&offset=0&reset=1', { method: 'POST' })).json()).error, /owned by D1/);
  assert.match((await (await call('/api/admin/migrate/copy?table=collector_runs&offset=0', { method: 'POST' })).json()).error, /legacy/);
  assert.ok(!d1db.prepare("SELECT 1 FROM sqlite_master WHERE name='collector_runs'").get());
  assert.ok(v.tables.find((t) => t.table === 'security_tasks').ok);

  // migration endpoints need the secrets
  const r503 = await worker.fetch(new Request(ORIGIN + '/api/admin/migrate/report', { headers: { 'Cf-Access-Jwt-Assertion': await access.token() } }), { ...env, TURSO_AUTH_TOKEN: '' });
  assert.equal(r503.status, 503);
});
