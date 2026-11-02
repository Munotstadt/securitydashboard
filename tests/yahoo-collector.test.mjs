// Tests für collectors/yahoo/worker.js: GBp->GBP-Umrechnung, Währungsabgleich, Sprung-Check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeD1 } from './helpers.mjs';
import { toMasterCurrency, checkJump, median, runCollector, collectorConfig } from '../collectors/yahoo/worker.js';

const SOURCE = 'Collector_Worker_YahooWeekday_0600-2000_UTC';

test('Pence werden durch 100 geteilt', () => {
  assert.equal(toMasterCurrency({ price: 425, currency: 'GBp' }, 'GBP'), 4.25);
  assert.equal(toMasterCurrency({ price: 425, currency: 'GBX' }, 'GBP'), 4.25);
  assert.equal(toMasterCurrency({ price: 1500, currency: 'ZAc' }, 'ZAR'), 15);
  assert.equal(toMasterCurrency({ price: 1500, currency: 'ILA' }, 'ILS'), 15);
});

test('Hauptwährungen bleiben unverändert', () => {
  assert.equal(toMasterCurrency({ price: 117.4, currency: 'GBP' }, 'GBP'), 117.4);
  assert.equal(toMasterCurrency({ price: 144.3, currency: 'USD' }, 'usd'), 144.3);
  assert.equal(toMasterCurrency({ price: 10, currency: 'CHF' }, null), 10);
  // MSCI-Indizes: Yahoo liefert keine Währung -> unverändert
  assert.equal(toMasterCurrency({ price: 4862.72, currency: undefined }, 'USD'), 4862.72);
  assert.equal(toMasterCurrency({ price: 4862.72, currency: null }, 'USD'), 4862.72);
});

test('Währung passt nicht zum Master -> Fehler (z.B. GBp-Linie eines USD-ETF)', () => {
  assert.throws(() => toMasterCurrency({ price: 7736, currency: 'GBp' }, 'USD'), /Währung passt nicht/);
});

test('Sprung-Check und Median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  checkJump(4.3, 4.25);
  checkJump(4.3, undefined);
  assert.throws(() => checkJump(425, 4.25), /Preissprung/);
  assert.throws(() => checkJump(4.25, 425), /Preissprung/);
});

test('runCollector speichert GBP und lässt Mismatch/Sprünge weg', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE security_master (SecurityID integer PRIMARY KEY, Ticker text, Currency text, Collector integer);
    CREATE TABLE security_prices (SecurityID integer, Price real, Price_adjusted real, Price_date text, source text, created_at text, modified_at text);
    CREATE UNIQUE INDEX u ON security_prices (SecurityID, Price_date, source);
    INSERT INTO security_master VALUES (1,'BLND.L','GBP',4),(2,'IWRD.L','USD',4),(3,'VUSD.L','USD',4),(4,'CUKX.L','GBP',4);
    INSERT INTO security_master VALUES (5,'GLCH.L','GBP',4);
    -- Realfall CUKX 2026-11-02: nur ein (falscher) Collector-Preis, daneben UBS-Kurse.
    INSERT INTO security_prices VALUES
      (4,220.0,220.0,datetime('now','-20 days'),'UBS Quotes Import (Uploader)','',''),
      (4,218.85,218.85,datetime('now','-10 days'),'UBS Quotes Import (Uploader)','',''),
      (4,221.0,221.0,datetime('now','-3 days'),'UBS Quotes','',''),
      (4,22110,22110,datetime('now','-1 hours'),'${SOURCE}','',''),
      (4,99999,99999,datetime('now','-200 days'),'${SOURCE}','',''),
      (5,221.0,221.0,datetime('now','-3 days'),'UBS Quotes','','');
  `);
  const quotes = {
    'BLND.L': { regularMarketPrice: 425, currency: 'GBp' },
    'IWRD.L': { regularMarketPrice: 7736, currency: 'GBp' },
    'VUSD.L': { regularMarketPrice: 144.31, currency: 'USD' },
    'CUKX.L': { regularMarketPrice: 22150, currency: 'GBp' },
    'GLCH.L': { regularMarketPrice: 22110, currency: 'GBP' }, // Pence-Wert mit falschem Währungslabel
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const t = decodeURIComponent(new URL(url).pathname.split('/').pop());
    return new Response(JSON.stringify({ chart: { result: [{ meta: quotes[t] }] } }));
  };
  try {
    const r = await runCollector({ DB: makeD1(db), COLLECTOR_ID: '4', SOURCE_NAME: SOURCE });
    assert.equal(r.added, 3);
    assert.equal(r.fetchErrors, 2);
    assert.match(r.errorDetails[0].error, /Währung passt nicht/);
    assert.match(r.errorDetails[1].error, /Preissprung/);
    const latest = (id) => db.prepare('SELECT Price FROM security_prices WHERE SecurityID=? ORDER BY Price_date DESC LIMIT 1').get(id)?.Price;
    assert.equal(latest(1), 4.25);
    assert.equal(latest(2), undefined);
    assert.equal(latest(3), 144.31);
    assert.equal(latest(4), 221.5); // Referenz = Median über alle Quellen (220), nicht 22110
    assert.equal(latest(5), 221.0); // 22110 mit Label GBP wird nicht gespeichert
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fehlende Worker-Variablen -> klarer Fehler', () => {
  assert.throws(() => collectorConfig({}), /COLLECTOR_ID\/SOURCE_NAME fehlen/);
  assert.deepEqual(collectorConfig({ COLLECTOR_ID: '43', SOURCE_NAME: 'X' }), { collectorId: 43, sourceName: 'X' });
});
