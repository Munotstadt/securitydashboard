// collector-worker-securitydata-monthly
// Ersetzt die GitHub Actions collect_fund_data.py / collect_share_data.py (Repo securitydatacollector_turso),
// die noch nach Turso schrieben. Holt einmal im Monat von Yahoo (quoteSummary) und schreibt nach D1 security_data:
//   ETF/Funds (Instrument 'ETF/Funds'): TopHolding, AssetClass, SectorWeight, BondRating, FundOverview
//   Shares    (Instrument 19):          Fundamental (marketCap, trailingPE, priceToBook, sharesOutstanding, ...)
// Gleiche Feldnamen/Skalierung wie die Python-Collector (yfinance), damit die Historie nahtlos weiterläuft.
//
// Ablauf: Cron "*/10 2-5 1 * *" = am 1. des Monats 02:00-05:50 UTC alle 10 Minuten (24 Slots).
// Jeder Slot verarbeitet BATCH_SIZE Securities (sortiert nach SecurityID) -> bis 600 Securities, und jeder Aufruf
// bleibt unter dem Subrequest-Limit (50 im Free-Plan). Pro Security und Tag ist der Lauf idempotent:
// vorhandene yfinance-Zeilen desselben Tages werden vor dem Insert gelöscht.
//
// Manuell (Secret RUN_TOKEN nötig): /?slot=3 | /?ids=123,456 | /?ticker=NESN.SW, Token als &token=<RUN_TOKEN> oder Header Authorization: Bearer

export const SOURCE = "yfinance";
export const BATCH_SIZE = 25;
export const SLOT_START_HOUR_UTC = 2;
export const SLOT_MINUTES = 10;
const MAX_FETCHES = 45; // Reserve unter dem 50er-Subrequest-Limit (Free-Plan)
const RUN_LOG_LABEL = "Yahoo Fund/Share Data (monthly)";
const INSTRUMENT_SHARES_ID = 19;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const FUND_MODULES = "topHoldings,fundProfile,summaryProfile";
export const SHARE_MODULES = "summaryDetail,defaultKeyStatistics,financialData";
export const DATA_TYPES = ["TopHolding", "AssetClass", "SectorWeight", "BondRating", "FundOverview", "Fundamental"];
const CATEGORICAL = new Set(["AssetClass", "SectorWeight", "BondRating", "FundOverview", "Fundamental"]);

// Gleiche Liste wie FUNDAMENTAL_KEYS in collect_share_data.py.
export const FUNDAMENTAL_KEYS = [
	"marketCap", "enterpriseValue",
	"trailingPE", "forwardPE", "priceToBook", "priceToSalesTrailing12Months",
	"pegRatio", "enterpriseToRevenue", "enterpriseToEbitda",
	"dividendYield", "dividendRate", "payoutRatio", "fiveYearAvgDividendYield",
	"beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fiftyDayAverage", "twoHundredDayAverage",
	"profitMargins", "operatingMargins", "grossMargins", "ebitdaMargins",
	"returnOnAssets", "returnOnEquity",
	"revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
	"totalRevenue", "totalDebt", "totalCash", "freeCashflow", "operatingCashflow",
	"debtToEquity", "currentRatio", "quickRatio",
	"trailingEps", "forwardEps", "bookValue",
	"sharesOutstanding", "floatShares", "heldPercentInsiders", "heldPercentInstitutions",
	"shortRatio", "shortPercentOfFloat",
	"targetMeanPrice", "targetHighPrice", "targetLowPrice", "recommendationMean",
	"numberOfAnalystOpinions",
];
// yfinance liefert dividendYield in Prozent (Yahoo roh: Bruch). Bestehende Daten in D1 sind in Prozent (NESN 4.08).
const PERCENT_SCALED_KEYS = new Set(["dividendYield"]);
const ASSET_CLASS_KEYS = ["cashPosition", "stockPosition", "bondPosition", "preferredPosition", "convertiblePosition", "otherPosition"];

export default {
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runSlot(env, slotFromTime(event.scheduledTime), "Scheduled"));
	},
	async fetch(request, env) {
		const url = new URL(request.url);
		// Token als Header (curl) oder als ?token=... in der Adresse (Browser).
		const auth = request.headers.get("authorization") || "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7) : (url.searchParams.get("token") || "");
		if (!env.RUN_TOKEN || token !== env.RUN_TOKEN) {
			return json({ error: "forbidden (Secret RUN_TOKEN setzen und als ?token=... oder Bearer-Token mitsenden)" }, 403);
		}
		try {
			const ids = (url.searchParams.get("ids") || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
			const ticker = (url.searchParams.get("ticker") || "").trim();
			const slot = url.searchParams.has("slot") ? Number(url.searchParams.get("slot")) : null;
			let result;
			if (ids.length || ticker) result = await runSelection(env, { ids, ticker }, "Manual");
			else if (slot !== null && Number.isInteger(slot) && slot >= 0) result = await runSlot(env, slot, "Manual");
			else return json({ error: "Parameter slot, ids oder ticker angeben" }, 400);
			return json(result);
		} catch (e) {
			return json({ error: String(e), stack: e.stack }, 500);
		}
	},
};

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- Slots
export function slotFromTime(ms) {
	const d = new Date(ms);
	const minutes = (d.getUTCHours() - SLOT_START_HOUR_UTC) * 60 + d.getUTCMinutes();
	return Math.max(0, Math.floor(minutes / SLOT_MINUTES));
}
export function sliceForSlot(list, slot, size = BATCH_SIZE) {
	return list.slice(slot * size, (slot + 1) * size);
}

export async function loadSecurities(env) {
	const sql = `SELECT sm.SecurityID, sm.SecurityName, sm.Ticker,
	    CASE WHEN ip.ParameterName = 'ETF/Funds' THEN 'fund' ELSE 'share' END AS Kind
	  FROM security_master sm
	  LEFT JOIN security_parameter ip ON ip.ParameterID = sm.Instrument
	  WHERE sm.Ticker IS NOT NULL AND TRIM(sm.Ticker) <> ''
	    AND (sm.Instrument = ? OR (ip.ParaTable = 'security_master' AND ip.ParaField = 'Instrument' AND ip.ParameterName = 'ETF/Funds'))
	  ORDER BY sm.SecurityID`;
	const res = await env.DB.prepare(sql).bind(INSTRUMENT_SHARES_ID).all();
	return res.results || [];
}

export async function runSlot(env, slot, trigger) {
	const all = await loadSecurities(env);
	const batch = sliceForSlot(all, slot);
	if (!batch.length) return { slot, total: all.length, processed: 0, note: "Slot leer" };
	const result = await collect(env, batch);
	await logResult(env, result, trigger, `Slot ${slot} (${slot * BATCH_SIZE + 1}-${slot * BATCH_SIZE + batch.length} von ${all.length})`);
	return Object.assign({ slot, total: all.length }, result);
}

export async function runSelection(env, { ids, ticker }, trigger) {
	const all = await loadSecurities(env);
	const batch = all.filter((s) => ids.includes(Number(s.SecurityID)) || (ticker && s.Ticker === ticker)).slice(0, BATCH_SIZE);
	if (!batch.length) return { processed: 0, note: "Keine passende Security (nur ETF/Funds und Shares mit Ticker)" };
	const result = await collect(env, batch);
	await logResult(env, result, trigger, "Auswahl " + batch.map((s) => s.Ticker).join(", "));
	return result;
}

// ---------------------------------------------------------------- Yahoo
export function makeYahoo(fetchImpl = fetch) {
	let session = null;
	let fetches = 0;
	const f = (url, init) => {
		if (++fetches > MAX_FETCHES) throw new Error("Subrequest-Budget erschöpft");
		return fetchImpl(url, init);
	};
	async function newSession() {
		const r1 = await f("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
		const raw = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
		const cookie = raw.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
		if (!cookie) throw new Error("Yahoo: kein Cookie von fc.yahoo.com (HTTP " + r1.status + ")");
		const r2 = await f("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
		const crumb = (await r2.text()).trim();
		if (!r2.ok || !crumb || crumb.length > 64 || /[<{\s]/.test(crumb)) throw new Error("Yahoo: kein Crumb (HTTP " + r2.status + ")");
		session = { cookie, crumb };
	}
	async function quoteSummary(ticker, modules) {
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (!session) await newSession();
			const url = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + encodeURIComponent(ticker)
				+ "?modules=" + modules + "&crumb=" + encodeURIComponent(session.crumb);
			const res = await f(url, { headers: { "User-Agent": UA, Cookie: session.cookie } });
			if (res.status === 401 || res.status === 403) { session = null; continue; } // Crumb abgelaufen -> neu holen
			if (res.status === 404) return null;
			if (!res.ok) throw new Error("Yahoo HTTP " + res.status);
			const data = await res.json();
			const err = data && data.quoteSummary && data.quoteSummary.error;
			if (err) {
				if (/not found/i.test(err.code || "") || /no fundamentals/i.test(err.description || "")) return null;
				throw new Error("Yahoo: " + (err.description || err.code));
			}
			return (data.quoteSummary.result || [])[0] || null;
		}
		throw new Error("Yahoo: Zugriff verweigert (Crumb/Cookie)");
	}
	return { quoteSummary, fetchCount: () => fetches };
}

// Yahoo-Werte kommen als {raw, fmt}, als {} (fehlt) oder direkt als Zahl/Text.
export function rawValue(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === "object") return "raw" in v ? v.raw : null;
	return v;
}

function fact(dataType, fieldName, numericValue, fieldValue, unit) {
	return { dataType, fieldName, numericValue, fieldValue, unit };
}
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// Entspricht collect_fund_data.py (yfinance funds_data). Bewusst nicht übernommen: fund_operations,
// equity/bond holdings - die landeten wegen der Spaltennamen nie in der DB (siehe Python: value_col None).
export function factsForFund(result) {
	const out = [];
	if (!result) return out;
	const th = result.topHoldings || {};
	for (const h of th.holdings || []) {
		const pct = rawValue(h.holdingPercent);
		const symbol = h.symbol ? String(h.symbol) : null;
		const name = h.holdingName ? String(h.holdingName) : symbol;
		if (!isNum(pct) && !symbol) continue;
		out.push(fact("TopHolding", name, isNum(pct) ? pct * 100 : null, symbol, isNum(pct) ? "%" : null));
	}
	for (const key of ASSET_CLASS_KEYS) {
		const v = rawValue(th[key]);
		if (isNum(v)) out.push(fact("AssetClass", key, v * 100, null, null));
	}
	for (const [list, dataType] of [[th.sectorWeightings, "SectorWeight"], [th.bondRatings, "BondRating"]]) {
		for (const entry of list || []) {
			for (const [key, val] of Object.entries(entry || {})) {
				const v = rawValue(val);
				if (isNum(v)) out.push(fact(dataType, key, v * 100, null, null));
			}
		}
	}
	const fp = result.fundProfile || {};
	for (const key of ["categoryName", "family", "legalType"]) {
		const v = rawValue(fp[key]);
		if (v !== null && v !== undefined && v !== "") out.push(fact("FundOverview", key, isNum(v) ? v : null, isNum(v) ? null : String(v), null));
	}
	const desc = result.summaryProfile && rawValue(result.summaryProfile.longBusinessSummary);
	if (desc) out.push(fact("FundOverview", "description", null, String(desc).slice(0, 2000), null));
	return out;
}

// Entspricht collect_share_data.py (yfinance .info, das summaryDetail/defaultKeyStatistics/financialData zusammenführt).
export function factsForShare(result) {
	const out = [];
	if (!result) return out;
	const modules = [result.summaryDetail, result.defaultKeyStatistics, result.financialData].filter(Boolean);
	for (const key of FUNDAMENTAL_KEYS) {
		let v = null;
		for (const m of modules) {
			const c = rawValue(m[key]);
			if (c !== null && c !== undefined && c !== "") { v = c; break; }
		}
		if (v === null) continue;
		if (isNum(v)) out.push(fact("Fundamental", key, PERCENT_SCALED_KEYS.has(key) ? Math.round(v * 100 * 1e6) / 1e6 : v, null, null));
		else if (typeof v === "string") out.push(fact("Fundamental", key, null, v, null));
	}
	return out;
}

// ---------------------------------------------------------------- D1
export function todayZurich(now = new Date()) {
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" })
		.formatToParts(now).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day}`;
}
function nowZurich() {
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
		.formatToParts(new Date()).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

async function loadParams(env) {
	const res = await env.DB.prepare("SELECT ParameterID, ParaField, ParameterName FROM security_parameter WHERE ParaTable = 'security_data'").all();
	const map = new Map();
	for (const r of res.results || []) map.set(r.ParaField + "|" + r.ParameterName, r.ParameterID);
	return map;
}

// Legt fehlende security_parameter-Einträge an (wie resolve_parameter_id in Python) - ein Batch für alle.
async function ensureParams(env, params, facts) {
	const missing = new Map();
	for (const f of facts) {
		if (!CATEGORICAL.has(f.dataType)) continue;
		const k = f.dataType + "|" + f.fieldName;
		if (!params.has(k)) missing.set(k, f);
	}
	if (!missing.size) return params;
	await env.DB.batch([...missing.values()].map((f) => env.DB.prepare(
		"INSERT INTO security_parameter (ParameterName, ParaTable, ParaField, created_at) SELECT ?, 'security_data', ?, datetime('now') "
		+ "WHERE NOT EXISTS (SELECT 1 FROM security_parameter WHERE ParaTable = 'security_data' AND ParaField = ? AND ParameterName = ?)"
	).bind(f.fieldName, f.dataType, f.dataType, f.fieldName)));
	return loadParams(env);
}

const INSERT_SQL = "INSERT INTO security_data (SecurityID, DataType, FieldNameID, FieldName, FieldValue, NumericValue, Unit, AsOfDate, Source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)";
const DELETE_SQL = `DELETE FROM security_data WHERE SecurityID = ? AND Source = ? AND AsOfDate = ? AND DataType IN (${DATA_TYPES.map(() => "?").join(",")})`;

export async function collect(env, batch, { fetchImpl, today } = {}) {
	const yahoo = makeYahoo(fetchImpl);
	const asOf = today || todayZurich();
	const collected = []; // { sec, facts }
	const errors = [];
	let skipped = 0;
	for (const sec of batch) {
		try {
			const result = await yahoo.quoteSummary(sec.Ticker, sec.Kind === "fund" ? FUND_MODULES : SHARE_MODULES);
			const facts = sec.Kind === "fund" ? factsForFund(result) : factsForShare(result);
			if (!facts.length) { skipped++; continue; }
			collected.push({ sec, facts });
		} catch (e) {
			errors.push({ ticker: sec.Ticker, securityId: sec.SecurityID, error: String(e && e.message || e) });
			if (/Budget|Crumb|Cookie|verweigert/.test(String(e))) break; // weitere Versuche sinnlos
		}
	}

	let rows = 0;
	if (collected.length) {
		let params = await loadParams(env);
		params = await ensureParams(env, params, collected.flatMap((c) => c.facts));
		const created = nowZurich();
		// Pro Security: DELETE (gleicher Tag) + INSERTs. Chunks enthalten nur ganze Securities (je Chunk eine Transaktion).
		let chunk = [];
		const flush = async () => { if (chunk.length) { await env.DB.batch(chunk); chunk = []; } };
		for (const { sec, facts } of collected) {
			const stmts = [env.DB.prepare(DELETE_SQL).bind(sec.SecurityID, SOURCE, asOf, ...DATA_TYPES)];
			for (const f of facts) {
				const pid = CATEGORICAL.has(f.dataType) ? params.get(f.dataType + "|" + f.fieldName) ?? null : null;
				stmts.push(env.DB.prepare(INSERT_SQL).bind(
					sec.SecurityID, f.dataType, pid, pid === null ? f.fieldName : null,
					f.fieldValue ?? null, f.numericValue ?? null, f.unit ?? null, asOf, SOURCE, created));
			}
			if (chunk.length + stmts.length > 400) await flush();
			chunk.push(...stmts);
			rows += facts.length;
		}
		await flush();
	}
	return {
		processed: batch.length, ok: collected.length, skipped, failed: errors.length, rows,
		asOfDate: asOf, yahooRequests: yahoo.fetchCount(), errors,
	};
}

async function logResult(env, r, trigger, scope) {
	const status = r.failed ? "ERROR" : "OK";
	let detail = `${scope}: ${r.ok} ok, ${r.skipped} ohne Daten, ${r.failed} Fehler`;
	if (r.errors && r.errors.length) detail += " - " + r.errors.map((e) => `${e.ticker} ${e.error}`).join("; ");
	try {
		await env.DB.prepare("INSERT INTO security_collector_runs (collectortype, runat, status, datapoints, detail, trigger, runid, runnumber) VALUES (?,?,?,?,?,?,?,?)")
			.bind(RUN_LOG_LABEL, nowZurich(), status, String(r.rows), detail.slice(0, 2000), trigger, "", "").run();
	} catch (e) {
		console.log("[run_log] konnte security_collector_runs nicht schreiben: " + String(e));
	}
}
