// ============ D1 access via the same-origin Worker API (POST /api/db) ============
// The page and the API live on the same hostname (security.munot.app), behind
// Cloudflare Access. No tokens or URLs are configured in the browser any more.
// Statements run server-side against the D1 database "securities" in one
// batch (= one transaction). Only SELECT/INSERT/UPDATE/DELETE are accepted;
// schema changes go through migrations/*.sql.

// Numeric-looking strings (e.g. SecurityID "20" from a <select>) are sent as
// numbers so comparisons against INTEGER columns behave the same everywhere.
function toDbArg(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^-?\d+$/.test(v) && Math.abs(Number(v)) <= Number.MAX_SAFE_INTEGER) return parseInt(v, 10);
  if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// ============ Session cache (sessionStorage) for read-heavy queries ============
// Opt-in per call via dbQuery(sql, args, ttlMs). Any non-SELECT statement in
// a batch clears the entire cache, so edits never risk serving stale data.
const DB_CACHE_PREFIX = 'SECURITYDASHBOARD_DB_CACHE_';
function dbCacheKey(sql, args) { return DB_CACHE_PREFIX + JSON.stringify({ sql, args }); }
function dbCacheGet(key, ttlMs) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { ts, rows } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) return null;
    return rows;
  } catch (e) { return null; }
}
function dbCacheSet(key, rows) {
  try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), rows })); } catch (e) {}
}
function dbClearCache() {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith(DB_CACHE_PREFIX)) keys.push(k); }
    keys.forEach(k => sessionStorage.removeItem(k));
  } catch (e) {}
}
function dbCacheCount() {
  try {
    let n = 0;
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith(DB_CACHE_PREFIX)) n++; }
    return n;
  } catch (e) { return 0; }
}

// Distinct currency codes for Currency <select> dropdowns, sourced from
// security_currencies. Falls back to a small default list if the table is
// empty/unreachable (e.g. before the schema/backfill has run once).
const CURRENCY_OPTS_FALLBACK = ['CHF','EUR','USD','GBP','JPY','INR','CNY','SEK','CAD'];
async function dbCurrencyOptions(){
  try {
    const rows = await dbQuery(
      "SELECT DISTINCT Cry FROM security_currencies WHERE Cry IS NOT NULL AND Cry <> '' ORDER BY Cry ASC",
      [], 3600000
    );
    const list = rows.map(r => r.Cry).filter(Boolean);
    return list.length ? list : CURRENCY_OPTS_FALLBACK;
  } catch(e) {
    return CURRENCY_OPTS_FALLBACK;
  }
}

// ============ Currency conversion-factor lookup (security_currencies.ConversionFactor) ============
// Low-value currencies (JPY, KRW, IDR, HUF, VND, ISK, CLP, ...) are stored in
// security_prices at their raw per-1-unit rate (e.g. 1 JPY = 0.0052 CHF) -
// canonical and calculation-friendly, see Currency magnitude check.md - but
// that's an unreadable number for a human. security_currencies.ConversionFactor
// (100 for these, 1 for normal currencies) says how many units they're
// conventionally quoted per. This lookup backs BOTH the admin.html import
// magnitude-check hint AND the "XXX/CHF"-security price display (×factor +
// "(factor/CHF)" label) everywhere such a price is shown. Display-only -
// never mutates stored data.
let currencyFactorCache = null;
async function currencyFactors(){
  if (currencyFactorCache) return currencyFactorCache;
  currencyFactorCache = new Map();
  try {
    const rows = await dbQuery(
      "SELECT Cry, ConversionFactor FROM security_currencies WHERE Cry IS NOT NULL AND Cry <> ''",
      [], 3600000
    );
    rows.forEach(r => {
      const f = Number(r.ConversionFactor);
      currencyFactorCache.set(String(r.Cry).toUpperCase().trim(), (isFinite(f) && f > 0) ? f : 1);
    });
  } catch (e) { /* leave cache empty -> every lookup below falls back to factor 1 */ }
  return currencyFactorCache;
}
function currencyFactorFor(factorMap, ccy){
  if (!ccy || !factorMap) return 1;
  return factorMap.get(String(ccy).toUpperCase().trim()) || 1;
}

// Extracts the base currency from an FX-security's SecurityName ("JPY/CHF"
// -> "JPY"). Mirrors the pattern security.html already uses to find FX-rate
// securities for cross-currency conversion (see fxMatches there).
function fxBaseCurrency(securityName){
  const m = (securityName || '').trim().match(/^([A-Za-z]{3})\/CHF$/i);
  return m ? m[1].toUpperCase() : null;
}

// Formats a stored FX rate for display. rawPrice is always the canonical
// per-1-unit rate as stored in security_prices - this is presentation-only,
// it never changes what's in the DB. For a low-value base currency
// (ConversionFactor > 1) this returns the "per N units" figure instead of
// the raw, unreadably small per-1 rate, e.g. 0.0052 -> "0.5233" with
// suffix "(100/CHF)". For everything else (non-FX securities, or FX pairs
// with factor 1) suffix is null and the caller should show its normal
// currency label instead.
function fxDisplayPrice(rawPrice, securityName, factorMap, decimals = 4){
  if (rawPrice === null || rawPrice === undefined || isNaN(rawPrice)) return { text: '—', suffix: null };
  const base = fxBaseCurrency(securityName);
  const factor = currencyFactorFor(factorMap, base);
  if (!base || factor === 1) return { text: fmtDecimal(rawPrice, decimals), suffix: null };
  return { text: fmtDecimal(rawPrice * factor, decimals), suffix: `(${factor}/CHF)` };
}

// ============ Core exec — pass several {sql, args} statements, executed in one round trip ============
// If the Cloudflare Access session has expired the edge answers with a redirect
// to the login page. That is detected here and handled with ONE automatic page
// reload (top-level navigation -> Google login -> back to this page), instead of
// a cryptic network error.
const DB_RELOAD_KEY = 'SECURITYDASHBOARD_DB_RELOAD_AT';
function dbSessionExpired() {
  try {
    const last = Number(sessionStorage.getItem(DB_RELOAD_KEY) || 0);
    if (Date.now() - last > 60000) {
      sessionStorage.setItem(DB_RELOAD_KEY, String(Date.now()));
      location.reload();
    }
  } catch (e) {}
  return new Error('Sitzung abgelaufen – bitte Seite neu laden (Google-Login).');
}
async function dbBatch(statements) {
  const hasWrite = statements.some(s => !/^\s*(select|with)\b/i.test(s.sql));
  if (hasWrite) dbClearCache();
  let res;
  try {
    res = await fetch('/api/db', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statements: statements.map(s => ({ sql: s.sql, args: (s.args || []).map(toDbArg) })) })
    });
  } catch (e) {
    throw dbSessionExpired();
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw dbSessionExpired();
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    let msg = txt.slice(0, 300);
    try { msg = JSON.parse(txt).error || msg; } catch (e) {}
    throw new Error(`DB HTTP ${res.status}: ${msg}`);
  }
  const data = await res.json();
  return (data.results || []).map(r => ({ rows: r.rows || [], affected: r.affected, lastInsertRowid: r.lastInsertRowid }));
}
// ttlMs > 0: cache SELECT results in sessionStorage for that many ms (per exact sql+args).
// Cache is auto-cleared on any write anywhere in the app, so this never serves stale data after an edit.
async function dbQuery(sql, args = [], ttlMs = 0) {
  const isSelect = /^\s*(select|with)\b/i.test(sql);
  if (isSelect && ttlMs > 0) {
    const key = dbCacheKey(sql, args);
    const cached = dbCacheGet(key, ttlMs);
    if (cached) return cached;
    const [result] = await dbBatch([{ sql, args }]);
    const rows = result ? result.rows : [];
    dbCacheSet(key, rows);
    return rows;
  }
  const [result] = await dbBatch([{ sql, args }]);
  return result ? result.rows : [];
}
async function dbRun(sql, args = []) {
  const [result] = await dbBatch([{ sql, args }]);
  return result || { rows: [], affected: 0, lastInsertRowid: null };
}

// ============ security_parameter lookups (generic FK-lookup pattern) ============
// Cached for 5 min by default — dropdown option lists (Collector, DashboardGrouping,
// Instrument, PortfolioGrouping, TrxArt) change rarely.
async function dbParameterOptions(paraTable, paraField, ttlMs = 3600000) {
  return dbQuery(
    'SELECT ParameterID, ParameterName FROM security_parameter WHERE ParaTable = ? AND ParaField = ? ORDER BY ParameterName COLLATE NOCASE ASC',
    [paraTable, paraField], ttlMs
  );
}

// ============ Date / Time — dd.mm.yyyy [hh:mm:ss], Europe/Zurich ============
function zurichParts(date) {
  const fmt = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = {};
  fmt.formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  return parts;
}
function nowZurichString() {
  const p = zurichParts(new Date());
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}
function nowZurichDateString() {
  const p = zurichParts(new Date());
  return `${p.day}.${p.month}.${p.year}`;
}
// Same as nowZurichDateString() but ISO (yyyy-mm-dd), which is what
// <input type="date"> requires - setting a dd.mm.yyyy value on such an
// input is silently rejected by the browser and leaves the field empty.
function nowZurichIsoDateString() {
  const p = zurichParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}
// Parses "dd.mm.yyyy" OR ISO "yyyy-mm-dd" -> Date | null
// (the collector writes ISO timestamps; manual entries use Swiss format)
function parseSwissDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const [, y, mo, d] = m; const dt = new Date(Number(y), Number(mo) - 1, Number(d)); return isNaN(dt) ? null : dt; }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) { const [, d, mo, y] = m; const dt = new Date(Number(y), Number(mo) - 1, Number(d)); return isNaN(dt) ? null : dt; }
  return null;
}
// Parses "dd.mm.yyyy [hh:mm:ss]" OR ISO "yyyy-mm-dd[ hh:mm:ss]" -> Date | null
function parseSwissDateTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { const [, y, mo, d, h = '0', mi = '0', se = '0'] = m; const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)); return isNaN(dt) ? null : dt; }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { const [, d, mo, y, h = '0', mi = '0', se = '0'] = m; const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)); return isNaN(dt) ? null : dt; }
  return null;
}
// Formats a Date back to Swiss dd.mm.yyyy [hh:mm:ss] using its own local
// components (mirrors how parseSwissDateTime constructed it) — used to
// normalize ISO-stored dates to the display format everywhere in the app.
function toSwissDate(date) {
  if (!date || isNaN(date)) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(date.getDate())}.${p2(date.getMonth() + 1)}.${date.getFullYear()}`;
}
function toSwissDateTime(date) {
  if (!date || isNaN(date)) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${toSwissDate(date)} ${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}
// ISO format for writing to columns with a CHECK constraint like
// PriceDate GLOB '????-??-??' OR '????-??-?? ??:??:??' — reading still
// accepts both formats via parseSwissDate/parseSwissDateTime.
function toIsoDate(date) {
  if (!date || isNaN(date)) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
}
function toIsoDateTime(date) {
  if (!date || isNaN(date)) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${toIsoDate(date)} ${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}
function fmtShortDateTime(date) {
  if (!date || isNaN(date)) return '—';
  const p = zurichParts(date);
  const nowYear = zurichParts(new Date()).year;
  return p.year === nowYear ? `${p.day}.${p.month}. ${p.hour}:${p.minute}` : `${p.day}.${p.month}.${p.year}`;
}
function fmtDecimal(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
}
function decideAxisDecimals(maxAbs) {
  if (maxAbs > 9999) return 0;
  if (maxAbs < 9.99) return 4;
  return 2;
}

// ============ Period reference-price logic (Day/WTD/MTD/YTD) ============
// Collapses a security's price rows to one "close" per calendar day, then
// finds the closest available close at/before a cutoff date. Works uniformly
// for weekday-only and 7-day securities: if a Sunday has no row, the search
// naturally lands on the preceding Friday close.
function dailyCloses(rowsForSecurity) {
  const withDt = rowsForSecurity
    .map(r => ({ ...r, dt: parseSwissDateTime(r.PriceDate) }))
    .filter(r => r.dt)
    .sort((a, b) => a.dt - b.dt);
  const byDay = new Map();
  for (const r of withDt) {
    const key = `${r.dt.getFullYear()}-${r.dt.getMonth()}-${r.dt.getDate()}`;
    byDay.set(key, r); // last row of each day wins (rows are ascending)
  }
  return [...byDay.values()].sort((a, b) => a.dt - b.dt);
}
function latestOnOrBefore(closes, cutoff) {
  let found = null;
  for (const c of closes) { if (c.dt <= cutoff) found = c; else break; }
  return found;
}
function periodReferences(rowsForSecurity, today = new Date()) {
  const closes = dailyCloses(rowsForSecurity);
  if (!closes.length) return { last: null, day: null, wtd: null, mtd: null, ytd: null };
  const last = closes[closes.length - 1];
  const day = closes.length > 1 ? closes[closes.length - 2] : null;

  const dow = today.getDay(); // 0=So
  const lastSunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);
  const wtdCutoff = new Date(lastSunday.getFullYear(), lastSunday.getMonth(), lastSunday.getDate() - 1, 23, 59, 59);

  const mtdCutoff = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59); // letzter Tag Vormonat

  const ytdCutoff = new Date(today.getFullYear() - 1, 11, 31, 23, 59, 59);

  return {
    last, day,
    wtd: latestOnOrBefore(closes, wtdCutoff),
    mtd: latestOnOrBefore(closes, mtdCutoff),
    ytd: latestOnOrBefore(closes, ytdCutoff),
  };
}
