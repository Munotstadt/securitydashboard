#!/usr/bin/env node
// ============================================================
// generate-security-prices.js
//
// Regenerates data/securityprices.csv with the latest stored price for
// every SecurityID that is currently "in scope" for the dashboard:
//   - net Quantity != 0 (a real portfolio holding), OR
//   - security_master.DashboardGrouping IS NOT NULL (pinned reference
//     security, e.g. FX rates / benchmarks)
//
// This mirrors the exact "Valuation CSV" logic already implemented in
// portfolio.html (buildValuationCsv / netQuantity / DashboardGrouping
// check) so the two exports never drift apart. Output columns:
//   SecurityID,PriceDate,Price,Source
//
// Requires two env vars (set as GitHub Actions repo secrets):
//   TURSO_DATABASE_URL   e.g. libsql://munotstadtsecuritydb-munotstadt.aws-eu-west-1.turso.io
//   TURSO_AUTH_TOKEN
//
// Talks to Turso via the plain /v2/pipeline HTTP API (same one
// assets/turso-data.js uses in the browser) so no extra npm dependency is
// needed - just Node's built-in fetch (Node 18+).
// ============================================================

const fs = require('fs');
const path = require('path');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').replace(/\/+$/, '').replace(/^libsql:/, 'https:');
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL and/or TURSO_AUTH_TOKEN environment variables.');
  process.exit(1);
}

// ---------- Turso HTTP API helpers (mirrors assets/turso-data.js) ----------
function toTursoArg(v) {
  if (v === null || v === undefined || v === '') return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}
function fromTursoCell(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return parseInt(cell.value, 10);
  if (cell.type === 'float') return parseFloat(cell.value);
  return cell.value;
}
async function tursoQuery(sql, args = []) {
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TURSO_TOKEN}` },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(toTursoArg) } }, { type: 'close' }] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Turso HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  for (const r of data.results || []) {
    if (r.type === 'error') throw new Error(r.error?.message || 'Turso error');
    if (r.response?.type !== 'execute') continue;
    const result = r.response.result;
    const cols = (result.cols || []).map((c) => c.name);
    return (result.rows || []).map((row) => {
      const obj = {};
      cols.forEach((name, i) => { obj[name] = fromTursoCell(row[i]); });
      return obj;
    });
  }
  return [];
}

// ---------- Date parsing (mirrors parseSwissDateTime in assets/turso-data.js) ----------
function parseSwissDateTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { const [, y, mo, d, h = '0', mi = '0', se = '0'] = m; const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)); return isNaN(dt) ? null : dt; }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { const [, d, mo, y, h = '0', mi = '0', se = '0'] = m; const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)); return isNaN(dt) ? null : dt; }
  return null;
}

// ---------- Portfolio logic (mirrors netQuantity in portfolio.html) ----------
function netQuantity(secId, txnRows) {
  return txnRows
    .filter((t) => t.SecurityID === secId && (t.TrxArtName === 'Buy' || t.TrxArtName === 'Sell'))
    .reduce((s, t) => s + (Number(t.Quantity) || 0), 0);
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const [master, txns, prices] = await Promise.all([
    tursoQuery(`SELECT SecurityID, DashboardGrouping FROM security_master`),
    tursoQuery(`SELECT t.SecurityID, t.Quantity, ta.ParameterName AS TrxArtName
                FROM security_transactions t
                LEFT JOIN security_parameter ta ON ta.ParameterID = t.TrxArt`),
    tursoQuery(`SELECT SecurityID, Price, PriceDate, Source FROM security_prices`),
  ]);

  const pricesBySecId = new Map();
  for (const p of prices) {
    if (!pricesBySecId.has(p.SecurityID)) pricesBySecId.set(p.SecurityID, []);
    pricesBySecId.get(p.SecurityID).push(p);
  }

  // Latest price row per security (max PriceDate; last row wins on tie),
  // same "dailyCloses(...).pop()" result as portfolio.html's periods.last.
  function latestPrice(secId) {
    const rows = pricesBySecId.get(secId) || [];
    let best = null, bestDt = null;
    for (const r of rows) {
      const dt = parseSwissDateTime(r.PriceDate);
      if (!dt) continue;
      if (!bestDt || dt >= bestDt) { bestDt = dt; best = r; }
    }
    return best;
  }

  const exportRows = [];
  for (const m of master) {
    const qty = netQuantity(m.SecurityID, txns);
    const inPortfolio = Math.abs(qty) >= 1e-9;
    const onDashboard = m.DashboardGrouping !== null && m.DashboardGrouping !== undefined;
    if (!inPortfolio && !onDashboard) continue;
    const last = latestPrice(m.SecurityID);
    if (!last) continue;
    exportRows.push({ secId: m.SecurityID, last });
  }

  exportRows.sort((a, b) => Number(a.secId) - Number(b.secId));

  const header = ['SecurityID', 'PriceDate', 'Price', 'Source'];
  const lines = [header.join(',')];
  for (const p of exportRows) {
    lines.push([csvField(p.secId), csvField(p.last.PriceDate), csvField(p.last.Price), csvField(p.last.Source)].join(','));
  }
  const csv = lines.join('\r\n') + '\r\n';

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'securityprices.csv');
  fs.writeFileSync(outPath, '﻿' + csv, 'utf8');
  console.log(`Wrote ${exportRows.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
