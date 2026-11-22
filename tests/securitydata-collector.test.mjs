// collectors/securitydata/worker.js: Yahoo quoteSummary -> security_data (Fund-Daten + Aktien-Fundamentals), gegen node:sqlite und gemockte Yahoo-Antworten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, makeD1 } from './helpers.mjs';
import worker, {
  collect, factsForFund, factsForShare, slotFromTime, sliceForSlot, loadSecurities, rawValue,
} from '../collectors/securitydata/worker.js';

const FUND = {
  topHoldings: {
    cashPosition: { raw: 0.0379, fmt: '3.79%' }, stockPosition: { raw: 0.9621 }, bondPosition: { raw: 0 },
    preferredPosition: {}, convertiblePosition: { raw: 0 }, otherPosition: { raw: 0 },
    holdings: [
      { symbol: '2330.TW', holdingName: 'Taiwan Semiconductor Manufacturing Co Ltd', holdingPercent: { raw: 0.0949141 } },
      { symbol: 'NTES', holdingName: 'NetEase Inc ADR', holdingPercent: { raw: 0.0562947 } },
    ],
    sectorWeightings: [{ realestate: { raw: 0.0205 } }, { technology: { raw: 0.3665 } }, { brand_new_sector: { raw: 0.01 } }],
    bondRatings: [{ aaa: { raw: 0 } }, { b: { raw: 1 } }],
    equityHoldings: { priceToEarnings: { raw: 0.05 } },
  },
  fundProfile: { family: 'UBS Asset Management (Europe) S.A.', legalType: 'Exchange Traded Fund', categoryName: null },
  summaryProfile: { longBusinessSummary: 'The fund tracks the MSCI China index.' },
};
const SHARE = {
  summaryDetail: { marketCap: { raw: 195591602176 }, trailingPE: { raw: 19.8 }, dividendYield: { raw: 0.0408 }, fiveYearAvgDividendYield: { raw: 3.04 }, beta: { raw: 0.45 }, forwardPE: {} },
  defaultKeyStatistics: { priceToBook: { raw: 5.6 }, sharesOutstanding: { raw: 2572220000 }, forwardPE: { raw: 17.2 }, beta: { raw: 0.99 } },
  financialData: { profitMargins: { raw: 0.0838 }, recommendationMean: { raw: 2.6 }, targetMeanPrice: { raw: 95.5 } },
};

test('securitydata: facts mirror the yfinance/Python collectors', () => {
  const f = factsForFund(FUND);
  const by = (dt, name) => f.find((x) => x.dataType === dt && x.fieldName === name);
  assert.equal(by('TopHolding', 'NetEase Inc ADR').fieldValue, 'NTES');
  assert.ok(Math.abs(by('TopHolding', 'NetEase Inc ADR').numericValue - 5.62947) < 1e-9);
  assert.equal(by('TopHolding', 'NetEase Inc ADR').unit, '%');
  assert.ok(Math.abs(by('AssetClass', 'stockPosition').numericValue - 96.21) < 1e-9);
  assert.equal(by('AssetClass', 'preferredPosition'), undefined, 'empty {} is skipped');
  assert.equal(by('AssetClass', 'bondPosition').numericValue, 0, 'zeros are kept like before');
  assert.equal(by('BondRating', 'b').numericValue, 100);
  assert.equal(by('FundOverview', 'family').fieldValue, 'UBS Asset Management (Europe) S.A.');
  assert.equal(by('FundOverview', 'categoryName'), undefined);
  assert.equal(by('FundOverview', 'description').fieldValue, 'The fund tracks the MSCI China index.');

  const s = factsForShare(SHARE);
  const v = (k) => s.find((x) => x.fieldName === k)?.numericValue;
  assert.equal(v('marketCap'), 195591602176);
  assert.equal(v('dividendYield'), 4.08, 'dividendYield in percent like yfinance');
  assert.equal(v('fiveYearAvgDividendYield'), 3.04);
  assert.equal(v('forwardPE'), 17.2, 'empty {} in summaryDetail falls through to defaultKeyStatistics');
  assert.equal(v('beta'), 0.45, 'summaryDetail wins (first non-empty module)');
  assert.equal(v('priceToBook'), 5.6);
  assert.equal(v('pegRatio'), undefined);
  assert.equal(rawValue({}), null);
});

test('securitydata: slots cover the 1st of the month 02:00-05:50 UTC in 25er-Portionen', () => {
  assert.equal(slotFromTime(Date.UTC(2026, 11, 1, 2, 0)), 0);
  assert.equal(slotFromTime(Date.UTC(2026, 11, 1, 2, 10)), 1);
  assert.equal(slotFromTime(Date.UTC(2026, 11, 1, 5, 50)), 23);
  const list = Array.from({ length: 60 }, (_, i) => i);
  assert.deepEqual(sliceForSlot(list, 2), list.slice(50, 60));
  assert.deepEqual(sliceForSlot(list, 3), []);
});

function setupDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE security_parameter (ParameterID INTEGER PRIMARY KEY, ParameterName TEXT NOT NULL, ParaTable TEXT NOT NULL, ParaField TEXT NOT NULL, created_at TEXT);
    CREATE TABLE security_master (SecurityID INTEGER PRIMARY KEY, SecurityName TEXT, Ticker TEXT, Instrument INTEGER);
    CREATE TABLE security_data (id INTEGER PRIMARY KEY, SecurityID INTEGER NOT NULL, DataType TEXT NOT NULL, FieldNameID INTEGER, FieldName TEXT, FieldValue TEXT, NumericValue REAL, Unit TEXT, AsOfDate TEXT NOT NULL, Source TEXT, created_at TEXT);
    CREATE UNIQUE INDEX ux ON security_data (SecurityID, FieldNameID, AsOfDate, COALESCE(Source,'')) WHERE FieldNameID IS NOT NULL;
    CREATE TABLE security_collector_runs (id INTEGER PRIMARY KEY, collectortype TEXT, runat TEXT, status TEXT, datapoints TEXT, detail TEXT, trigger TEXT, runid TEXT, runnumber TEXT);
    INSERT INTO security_parameter VALUES (19,'Shares','security_master','Instrument',NULL),(21,'ETF/Funds','security_master','Instrument',NULL),
      (45,'stockPosition','security_data','AssetClass',NULL),(75,'marketCap','security_data','Fundamental',NULL),(54,'technology','security_data','SectorWeight',NULL);
    INSERT INTO security_master VALUES (1,'MSCI China ETF','MCHI',21),(2,'Nestle','NESN.SW',19),(3,'No Data Fund','0PXXX',21),(4,'Bond',NULL,21),(5,'Crypto','BTC-USD',99);
    INSERT INTO security_data (SecurityID, DataType, FieldNameID, NumericValue, AsOfDate, Source) VALUES (2,'Fundamental',75,1,'2026-12-01','yfinance'),(2,'Fundamental',75,2,'2026-11-01','yfinance');
  `);
  return db;
}

function yahooMock({ failCrumbOnce = false } = {}) {
  const calls = [];
  let crumbCalls = 0;
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Domain=.yahoo.com; Path=/' } });
    if (url.includes('/getcrumb')) {
      assert.equal(init.headers.Cookie, 'A3=abc');
      crumbCalls++;
      return new Response(crumbCalls === 1 && failCrumbOnce ? 'old' : 'Cr0mb');
    }
    const ticker = decodeURIComponent(url.split('/quoteSummary/')[1].split('?')[0]);
    if (url.includes('crumb=old')) return new Response('{}', { status: 401 });
    if (ticker === 'MCHI') { assert.match(url, /modules=topHoldings,fundProfile,summaryProfile/); return Response.json({ quoteSummary: { result: [FUND], error: null } }); }
    if (ticker === 'NESN.SW') { assert.match(url, /modules=summaryDetail/); return Response.json({ quoteSummary: { result: [SHARE], error: null } }); }
    return Response.json({ quoteSummary: { result: null, error: { code: 'Not Found', description: 'Quote not found for symbol: ' + ticker } } }, { status: 404 });
  };
  return { fetchImpl, calls };
}

test('securitydata: collect writes security_data, creates new parameters, is idempotent per day', async () => {
  const db = setupDb();
  const env = { DB: makeD1(db) };
  const secs = await loadSecurities(env);
  assert.deepEqual(secs.map((s) => [s.SecurityID, s.Kind]), [[1, 'fund'], [2, 'share'], [3, 'fund']], 'only ETF/Funds + Shares with ticker');

  const y = yahooMock({ failCrumbOnce: true });
  const r = await collect(env, secs, { fetchImpl: y.fetchImpl, today: '2026-12-01' });
  assert.equal(r.ok, 2); assert.equal(r.skipped, 1); assert.equal(r.failed, 0, JSON.stringify(r.errors));
  assert.ok(r.yahooRequests <= 10);

  const q = (sql, ...a) => db.prepare(sql).all(...a);
  // same-day yfinance rows were replaced (old value 1 gone), older months stay as history
  assert.deepEqual(q("SELECT AsOfDate, NumericValue FROM security_data WHERE SecurityID=2 AND FieldNameID=75 ORDER BY AsOfDate").map((x) => [x.AsOfDate, x.NumericValue]),
    [['2026-11-01', 2], ['2026-12-01', 195591602176]]);
  // existing parameter reused, new ones created once
  assert.equal(q("SELECT FieldNameID FROM security_data WHERE SecurityID=1 AND DataType='AssetClass' AND NumericValue > 90")[0].FieldNameID, 45);
  const newSector = q("SELECT ParameterID FROM security_parameter WHERE ParaField='SectorWeight' AND ParameterName='brand_new_sector'");
  assert.equal(newSector.length, 1);
  assert.equal(q("SELECT COUNT(*) n FROM security_data WHERE FieldNameID=?", newSector[0].ParameterID)[0].n, 1);
  // TopHolding: name in FieldName, symbol in FieldValue, no FieldNameID
  const th = q("SELECT FieldNameID, FieldName, FieldValue, Unit FROM security_data WHERE DataType='TopHolding' ORDER BY NumericValue DESC")[0];
  assert.deepEqual({ ...th }, { FieldNameID: null, FieldName: 'Taiwan Semiconductor Manufacturing Co Ltd', FieldValue: '2330.TW', Unit: '%' });

  const before = q('SELECT COUNT(*) n FROM security_data')[0].n;
  await collect(env, secs, { fetchImpl: yahooMock().fetchImpl, today: '2026-12-01' });
  assert.equal(q('SELECT COUNT(*) n FROM security_data')[0].n, before, 'second run on the same day replaces, does not duplicate');
});

test('securitydata: fetch endpoint requires RUN_TOKEN; scheduled run logs to security_collector_runs', async () => {
  const db = setupDb();
  const env = { DB: makeD1(db), RUN_TOKEN: 'secret' };
  assert.equal((await worker.fetch(new Request('https://x/?slot=0'), env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://x/?slot=0', { headers: { authorization: 'Bearer nope' } }), { DB: env.DB })).status, 403);
  assert.equal((await worker.fetch(new Request('https://x/', { headers: { authorization: 'Bearer secret' } }), env)).status, 400);

  const realFetch = globalThis.fetch;
  globalThis.fetch = yahooMock().fetchImpl;
  try {
    let pending;
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 11, 1, 2, 0) }, env, { waitUntil: (p) => { pending = p; } });
    await pending;
    const res = await worker.fetch(new Request('https://x/?ticker=NESN.SW', { headers: { authorization: 'Bearer secret' } }), env);
    assert.equal((await res.json()).ok, 1);
  } finally { globalThis.fetch = realFetch; }
  const runs = db.prepare('SELECT collectortype, status, trigger, detail FROM security_collector_runs ORDER BY id').all();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].trigger, 'Scheduled');
  assert.equal(runs[0].status, 'OK');
  assert.match(runs[0].detail, /Slot 0 \(1-3 von 3\): 2 ok, 1 ohne Daten/);
  assert.equal(runs[1].trigger, 'Manual');
});
