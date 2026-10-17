// One-time migration helper: Turso (libSQL) -> Cloudflare D1 "securities".
//
// TEMPORARY. Remove this file, its import/route in worker.js, public/migrate.html and
// the TURSO_* secrets once the migration is verified (see docs/migration-runbook.md).
//
// Needs two Worker secrets (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
//   TURSO_DATABASE_URL   e.g. libsql://munotstadtsecuritydb-munotstadt.aws-eu-west-1.turso.io
//   TURSO_AUTH_TOKEN     read access is enough
// The token never touches GitHub or the browser. Turso is only READ, D1 is the only thing written.
//
// All actions are idempotent and resumable (the UI in public/migrate.html loops over them):
//   GET  /api/admin/migrate/report
//   POST /api/admin/migrate/sync       ?table=security_parameter|security_master&dry=1
//   POST /api/admin/migrate/copy       ?table=<name>&offset=<n>&rows=<n>&reset=1   (tables missing in D1)
//   POST /api/admin/migrate/prices     ?after=<SecurityID>&limit=<n>&dry=1
//   POST /api/admin/migrate/indexes
//   GET  /api/admin/migrate/verify

const SPECIAL = new Set(['security_master', 'security_parameter', 'security_prices']);
// Tables D1 already owns (written by the Cloudflare collectors / notes app): never copied, not part of verify.
const D1_OWNED = new Set(['security_collector_runs', 'notes_log', 'notes_jpgs']);
// Legacy tables that nothing reads any more: not copied (they stay in the Turso dump that gets archived).
const LEGACY = new Set(['collector_runs']);
const MAX_PARAMS = 95; // D1 allows 100 bound parameters per statement
const BATCH_STATEMENTS = 50;

export async function handleMigrate(request, env, url) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    return json({ error: 'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN secrets are not set on this Worker' }, 503);
  }
  const action = url.pathname.replace(/^\/api\/admin\/migrate\/?/, '');
  const q = url.searchParams;
  switch (action) {
    case 'report': return json(await report(env));
    case 'sync': return json(await syncTable(env, q.get('table'), q.get('dry') === '1'));
    case 'copy': return json(await copyTable(env, q.get('table'), Number(q.get('offset') || 0), Number(q.get('rows') || 100), q.get('reset') === '1'));
    case 'prices': return json(await syncPrices(env, Number(q.get('after') || 0), Number(q.get('limit') || 12), q.get('dry') === '1'));
    case 'indexes': return json(await createIndexes(env));
    case 'verify': return json(await verify(env));
    default: return json({ error: 'unknown action' }, 404);
  }
}

// ------------------------------------------------------------------ Turso
async function turso(env, sql, args = []) {
  const base = env.TURSO_DATABASE_URL.replace(/\/+$/, '').replace(/^libsql:/, 'https:');
  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}` },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(toTursoArg) } }, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  const r = (data.results || [])[0];
  if (!r) throw new Error('Turso: empty response');
  if (r.type === 'error') throw new Error('Turso: ' + (r.error && r.error.message));
  const result = r.response.result;
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = fromTursoCell(row[i]); });
    return o;
  });
  return { cols, rows };
}
function toTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}
function fromTursoCell(c) {
  if (!c || c.type === 'null') return null;
  if (c.type === 'integer') return parseInt(c.value, 10);
  if (c.type === 'float') return parseFloat(c.value);
  if (c.type === 'blob') throw new Error('BLOB columns are not supported by this migration');
  return c.value;
}
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

async function tursoTables(env) {
  const { rows } = await turso(env, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name");
  return rows;
}
async function d1Columns(env, table) {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(table).all();
  return (results || []).map((r) => r.name);
}
async function d1Exists(env, table) {
  const r = await env.DB.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?1`).bind(table).first();
  return !!r;
}
async function count(env, table) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).first();
  return r.n;
}

// ----------------------------------------------------------------- report
async function report(env) {
  const tables = await tursoTables(env);
  const out = [];
  for (const t of tables) {
    const exists = await d1Exists(env, t.name);
    const tc = (await turso(env, `SELECT COUNT(*) AS n FROM ${q(t.name)}`)).rows[0].n;
    const row = { table: t.name, turso_rows: tc, in_d1: exists, d1_rows: exists ? await count(env, t.name) : null };
    if (exists) {
      const tcols = (await turso(env, `SELECT name FROM pragma_table_info(?)`, [t.name])).rows.map((r) => r.name);
      const dcols = await d1Columns(env, t.name);
      row.only_in_turso_columns = tcols.filter((c) => !dcols.includes(c));
      row.only_in_d1_columns = dcols.filter((c) => !tcols.includes(c));
    }
    row.plan = SPECIAL.has(t.name)
      ? (t.name === 'security_prices' ? 'prices: add missing (day+source) rows' : 'sync: add missing, update where Turso is newer')
      : (LEGACY.has(t.name) ? 'skipped (legacy, not read by any page; stays in the Turso dump)'
        : D1_OWNED.has(t.name) || exists ? 'exists in D1 -> NOT touched (check manually)' : 'copy (schema + rows)');
    out.push(row);
  }
  const odd = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(Price_date) AS min_date FROM security_prices WHERE Price_date < '1990'`).first();
  return { tables: out, d1_price_rows_before_1990: odd };
}

// --------------------------------------------------- master / parameter sync
async function syncTable(env, table, dry) {
  if (table !== 'security_master' && table !== 'security_parameter') return { error: 'table must be security_master or security_parameter' };
  const pk = table === 'security_master' ? 'SecurityID' : 'ParameterID';
  const dcols = await d1Columns(env, table);
  const tRows = (await turso(env, `SELECT * FROM ${q(table)}`)).rows;
  const tcols = tRows.length ? Object.keys(tRows[0]) : [];
  const cols = tcols.filter((c) => dcols.includes(c));
  const { results } = await env.DB.prepare(`SELECT * FROM ${q(table)}`).all();
  const d1 = new Map(results.map((r) => [r[pk], r]));

  const toInsert = [], toUpdate = [], same = [];
  const tursoOlder = [];
  for (const r of tRows) {
    const cur = d1.get(r[pk]);
    if (!cur) { toInsert.push(r); continue; }
    const diff = cols.filter((c) => c !== pk && c !== 'created_at' && c !== 'modified_at' && String(r[c] ?? '') !== String(cur[c] ?? ''));
    if (!diff.length) { same.push(r[pk]); continue; }
    const tm = String(r.modified_at ?? ''), dm = String(cur.modified_at ?? '');
    if (tm > dm) toUpdate.push({ row: r, diff }); else tursoOlder.push({ id: r[pk], columns: diff });
  }
  const summary = {
    table, dry,
    turso_rows: tRows.length, d1_rows: results.length,
    identical: same.length,
    to_insert: toInsert.map((r) => r[pk]),
    to_update: toUpdate.map((u) => ({ id: u.row[pk], columns: u.diff })),
    differs_but_d1_newer_or_equal: tursoOlder, // left untouched: D1 row is newer (or same age)
    only_in_d1: results.filter((r) => !tRows.some((t) => t[pk] === r[pk])).length,
    ignored_turso_columns: tcols.filter((c) => !dcols.includes(c)),
  };
  if (dry) return summary;

  const stmts = [env.DB.prepare('PRAGMA defer_foreign_keys = on')];
  // created_at / modified_at are NOT NULL with a default in D1: if Turso has NULL there, let the default apply.
  const usable = (r, c) => !((c === 'created_at' || c === 'modified_at') && r[c] == null);
  for (const r of toInsert) {
    const use = cols.filter((c) => usable(r, c));
    stmts.push(env.DB.prepare(`INSERT INTO ${q(table)} (${use.map(q).join(',')}) VALUES (${use.map(() => '?').join(',')})`).bind(...use.map((c) => r[c] ?? null)));
  }
  for (const u of toUpdate) {
    const set = cols.filter((c) => c !== pk && c !== 'created_at' && usable(u.row, c));
    stmts.push(env.DB.prepare(`UPDATE ${q(table)} SET ${set.map((c) => q(c) + '=?').join(',')} WHERE ${q(pk)}=?`).bind(...set.map((c) => u.row[c] ?? null), u.row[pk]));
  }
  for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) await env.DB.batch(stmts.slice(i, i + BATCH_STATEMENTS));
  summary.applied = { inserted: toInsert.length, updated: toUpdate.length };
  return summary;
}

// ------------------------------------------------ copy tables missing in D1
async function copyTable(env, table, offset, rows, reset) {
  const tables = await tursoTables(env);
  const t = tables.find((x) => x.name === table);
  if (!t) return { error: 'table not found in Turso' };
  if (SPECIAL.has(table)) return { error: 'use sync/prices for ' + table };
  if (D1_OWNED.has(table)) return { error: table + ' is owned by D1 and must not be copied' };
  if (LEGACY.has(table)) return { error: table + ' is a legacy table and is intentionally not copied' };

  if (!(await d1Exists(env, table))) {
    await env.DB.prepare(t.sql).run(); // identical DDL as in Turso (same SQLite dialect)
  } else if (offset === 0 && !reset) {
    const n = await count(env, table);
    if (n > 0) return { error: `D1 table ${table} already has ${n} rows - pass reset=1 to empty and re-copy it` };
  }
  if (offset === 0 && reset) await env.DB.prepare(`DELETE FROM ${q(table)}`).run();

  const total = (await turso(env, `SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n;
  const { rows: data } = await turso(env, `SELECT * FROM ${q(table)} ORDER BY rowid LIMIT ? OFFSET ?`, [rows, offset]);
  if (data.length) {
    const cols = Object.keys(data[0]);
    const perStmt = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    if (cols.length > MAX_PARAMS) return { error: `${table} has ${cols.length} columns (> ${MAX_PARAMS})` };
    const stmts = [env.DB.prepare('PRAGMA defer_foreign_keys = on')];
    for (let i = 0; i < data.length; i += perStmt) {
      const part = data.slice(i, i + perStmt);
      const ph = '(' + cols.map(() => '?').join(',') + ')';
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO ${q(table)} (${cols.map(q).join(',')}) VALUES ${part.map(() => ph).join(',')}`)
        .bind(...part.flatMap((r) => cols.map((c) => r[c] ?? null))));
    }
    for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) await env.DB.batch(stmts.slice(i, i + BATCH_STATEMENTS));
  }
  const next = offset + data.length;
  return { table, total, copied_this_step: data.length, next_offset: next, done: next >= total };
}

async function createIndexes(env) {
  const { rows } = await turso(env, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name");
  const done = [], skipped = [];
  for (const ix of rows) {
    if (SPECIAL.has(ix.tbl_name) || !(await d1Exists(env, ix.tbl_name))) { skipped.push(ix.name); continue; }
    const sql = ix.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF NOT EXISTS\s+)?/i, (m, u) => `CREATE ${u ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS `);
    try { await env.DB.prepare(sql).run(); done.push(ix.name); } catch (e) { skipped.push(`${ix.name}: ${e.message}`); }
  }
  return { created: done, skipped };
}

// ------------------------------------------------------------------ prices
// Turso holds the intraday rows the D1 weekly cleanup deliberately thinned out, plus
// manual / UBS-import rows that never existed in D1. A Turso row is added to D1 only if
// D1 has NO row for the same SecurityID + calendar day + source (the same granularity the
// cleanup-prices-weekly worker keeps). Price_adjusted = Price for those rows.
async function syncPrices(env, after, limit, dry) {
  const ids = (await turso(env, `SELECT DISTINCT SecurityID FROM security_prices WHERE SecurityID > ? ORDER BY SecurityID LIMIT ?`, [after, limit])).rows.map((r) => r.SecurityID);
  if (!ids.length) return { done: true, next_after: after, securities: 0, would_insert_or_inserted: 0 };

  let added = 0, checked = 0;
  const perSecurity = [];
  const bySource = {};
  for (const id of ids) {
    const t = (await turso(env, `SELECT PriceDate, Price, Source FROM security_prices WHERE SecurityID = ?`, [id])).rows;
    const { results } = await env.DB.prepare(`SELECT substr(Price_date,1,10) AS d, COALESCE(source,'') AS s FROM security_prices WHERE SecurityID = ?1 GROUP BY 1, 2`).bind(id).all();
    const have = new Set(results.map((r) => r.d + '|' + r.s));
    const missingRows = [];
    for (const r of t) {
      checked++;
      if (r.Price === null || !/^\d{4}-\d{2}-\d{2}/.test(String(r.PriceDate))) continue;
      const key = String(r.PriceDate).slice(0, 10) + '|' + (r.Source ?? '');
      if (!have.has(key)) { have.add(key); missingRows.push(r); }
    }
    if (missingRows.length) {
      perSecurity.push({ SecurityID: id, rows: missingRows.length });
      for (const r of missingRows) bySource[r.Source ?? '(NULL)'] = (bySource[r.Source ?? '(NULL)'] || 0) + 1;
      added += missingRows.length;
      if (!dry) {
        const stmts = missingRows.map((r) => env.DB.prepare(`INSERT OR IGNORE INTO security_prices (SecurityID, Price, Price_adjusted, Price_date, source) VALUES (?1, ?2, ?2, ?3, ?4)`)
          .bind(id, r.Price, r.PriceDate, r.Source ?? null));
        for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) await env.DB.batch(stmts.slice(i, i + BATCH_STATEMENTS));
      }
    }
  }
  return { done: false, dry, next_after: ids[ids.length - 1], securities: ids.length, turso_rows_checked: checked, would_insert_or_inserted: added, by_source: bySource, detail: perSecurity };
}

// ------------------------------------------------------------------ verify
async function verify(env) {
  const tables = await tursoTables(env);
  const out = [];
  for (const t of tables) {
    if (t.name === 'security_prices' || D1_OWNED.has(t.name) || LEGACY.has(t.name)) continue; // not 1:1 by design (see syncPrices / D1-owned)
    const tc = (await turso(env, `SELECT COUNT(*) AS n FROM ${q(t.name)}`)).rows[0].n;
    const exists = await d1Exists(env, t.name);
    const dc = exists ? await count(env, t.name) : null;
    out.push({ table: t.name, turso: tc, d1: dc, ok: exists && dc >= tc });
  }
  return { tables: out, all_ok: out.every((r) => r.ok) };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
