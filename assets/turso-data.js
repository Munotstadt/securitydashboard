// ============ Turso Config (Database URL + Auth Token, localStorage) ============
const TURSO_CFG_KEY = 'TURSO_CFG';
let TURSO = { url: '', token: '' };

function tursoLoadConfig() {
  try {
    const raw = localStorage.getItem(TURSO_CFG_KEY);
    if (raw) TURSO = JSON.parse(raw);
  } catch (e) {}
}
function tursoSaveConfig(cfg) {
  TURSO = { url: (cfg.url || '').replace(/\/+$/, ''), token: cfg.token || '' };
  localStorage.setItem(TURSO_CFG_KEY, JSON.stringify(TURSO));
}
function tursoConfigured() { return !!(TURSO.url && TURSO.token); }
tursoLoadConfig();

// ============ Value (de)serialization for the Turso /v2/pipeline HTTP API ============
function toTursoArg(v) {
  if (v === null || v === undefined || v === '') return { type: 'null' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  // Values pulled from <select>/<input> elements are always strings (e.g.
  // SecurityID "20"). Bound parameters have no inherent type affinity, so
  // don't rely on the server applying column-affinity coercion for
  // comparisons — coerce numeric-looking strings ourselves.
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return { type: 'integer', value: v };
  if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) return { type: 'float', value: parseFloat(v) };
  return { type: 'text', value: String(v) };
}
function fromTursoCell(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return parseInt(cell.value, 10);
  if (cell.type === 'float') return parseFloat(cell.value);
  return cell.value;
}

// ============ Core exec — pass several {sql, args} statements, executed in one round trip ============
async function tursoBatch(statements) {
  if (!tursoConfigured()) throw new Error('Turso Datenbank-URL/Token nicht konfiguriert (⚙ Repo/Token).');
  const requests = statements.map(s => ({
    type: 'execute',
    stmt: { sql: s.sql, args: (s.args || []).map(toTursoArg) }
  }));
  requests.push({ type: 'close' });

  const res = await fetch(`${TURSO.url}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TURSO.token}` },
    body: JSON.stringify({ requests })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Turso HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = [];
  for (const r of data.results || []) {
    if (r.type === 'error') throw new Error(r.error?.message || 'Turso Fehler');
    if (r.response?.type !== 'execute') continue;
    const result = r.response.result;
    const cols = (result.cols || []).map(c => c.name);
    const rows = (result.rows || []).map(row => {
      const obj = {};
      cols.forEach((name, i) => { obj[name] = fromTursoCell(row[i]); });
      return obj;
    });
    out.push({ rows, cols, affected: result.affected_row_count, lastInsertRowid: result.last_insert_rowid });
  }
  return out;
}
async function tursoQuery(sql, args = []) {
  const [result] = await tursoBatch([{ sql, args }]);
  return result ? result.rows : [];
}
async function tursoRun(sql, args = []) {
  const [result] = await tursoBatch([{ sql, args }]);
  return result || { rows: [], affected: 0, lastInsertRowid: null };
}

// ============ security_parameter lookups (generic FK-lookup pattern) ============
async function tursoParameterOptions(paraTable, paraField) {
  return tursoQuery(
    'SELECT ParameterID, ParameterName FROM security_parameter WHERE ParaTable = ? AND ParaField = ? ORDER BY ParameterID ASC',
    [paraTable, paraField]
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
// Parses "dd.mm.yyyy" -> Date | null
function parseSwissDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return isNaN(dt) ? null : dt;
}
// Parses "dd.mm.yyyy" or "dd.mm.yyyy hh:mm:ss" -> Date | null
function parseSwissDateTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return isNaN(dt) ? null : dt;
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
