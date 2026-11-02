// Yahoo-Collector-Worker: ein Code für alle collector-worker-yahoo*.
// COLLECTOR_ID (ParameterID in security_parameter) und SOURCE_NAME kommen pro Worker
// als Variablen aus collectors/yahoo/wrangler.jsonc (Environments), siehe collectors/README.md.
const MAX_RETRIES = 2;

// Yahoo notiert manche Börsen in der Untereinheit der Währung (LSE: Pence "GBp"/"GBX",
// JSE: Cents "ZAc", TASE: Agorot "ILA"). security_prices führt Preise in der
// Hauptwährung (security_master.Currency), daher: Yahoo-Code -> [ISO-Währung, Divisor].
export const MINOR_UNIT_CURRENCIES = {
	"GBp": ["GBP", 100],
	"GBX": ["GBP", 100],
	"ZAc": ["ZAR", 100],
	"ZAC": ["ZAR", 100],
	"ILA": ["ILS", 100]
};

// Preissprung gegenüber dem Referenzpreis (siehe fetchLastPrices), ab dem nicht
// gespeichert wird (fängt Yahoos gelegentliche GBp/GBP-Wechsel ab). Gleiche
// Schwelle wie der Import-Check in admin.html (docs/currency-magnitude-check.md).
export const MAX_JUMP_FACTOR = 40;

export default {
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runCollector(env));
	},
	async fetch(request, env) {
		try {
			const result = await runCollector(env);
			return new Response(JSON.stringify(result, null, 2), {
				headers: { "content-type": "application/json" }
			});
		} catch (e) {
			return new Response(JSON.stringify({ error: String(e), stack: e.stack }, null, 2), {
				status: 500,
				headers: { "content-type": "application/json" }
			});
		}
	}
};

export function collectorConfig(env) {
	const collectorId = Number(env.COLLECTOR_ID);
	const sourceName = env.SOURCE_NAME;
	if (!Number.isInteger(collectorId) || collectorId <= 0 || !sourceName) {
		throw new Error("Variablen COLLECTOR_ID/SOURCE_NAME fehlen (wrangler.jsonc, Environment des Workers)");
	}
	return { collectorId: collectorId, sourceName: sourceName };
}

export async function runCollector(env) {
	const cfg = collectorConfig(env);
	const securities = await fetchSecurities(env);
	const lastPrices = await fetchLastPrices(env);
	const priceDate = nowInZurich();

	const priceRecords = [];
	let fetchErrors = 0;
	const errorDetails = [];

	for (const item of securities) {
		const SecurityID = item.SecurityID;
		const Ticker = item.Ticker;
		try {
			const quote = await fetchPriceWithRetry(Ticker);
			const price = toMasterCurrency(quote, item.Currency);
			checkJump(price, lastPrices.get(SecurityID));
			priceRecords.push({ securityId: SecurityID, price: price, priceDate: priceDate });
		} catch (e) {
			fetchErrors++;
			errorDetails.push({ ticker: Ticker, securityId: SecurityID, error: String(e) });
		}
	}

	let added = 0;
	let skipped = 0;
	let dbErrors = 0;

	if (priceRecords.length > 0) {
		try {
			const results = await insertPricesBatch(env, priceRecords);
			for (const r of results) {
				if (r) {
					added++;
				} else {
					skipped++;
				}
			}
		} catch (e) {
			dbErrors = priceRecords.length;
			errorDetails.push({ error: "Batch insert failed: " + String(e) });
		}
	}

	const status = (fetchErrors === 0 && dbErrors === 0) ? "OK" : "ERROR";
	let detail = (fetchErrors || dbErrors) ? (fetchErrors + " fetch error(s), " + dbErrors + " db error(s)") : "";
	if (errorDetails.length) {
		detail += ": " + errorDetails.map(function (d) { return (d.ticker || "") + " " + d.error; }).join("; ");
	}
	await logRun(env, cfg.sourceName, status, added, detail.slice(0, 2000));

	return {
		added: added,
		skipped: skipped,
		fetchErrors: fetchErrors,
		dbErrors: dbErrors,
		errorDetails: errorDetails,
		totalSecurities: securities.length,
		priceDate: priceDate,
		timestamp: new Date().toISOString()
	};
}

// Rechnet den Yahoo-Preis in die Währung aus security_master.Currency um
// (nur Untereinheit -> Hauptwährung, keine FX-Umrechnung). Liefert Yahoo eine andere
// Währung als im Master hinterlegt, wird nicht gespeichert: dann ist der Ticker
// falsch (z.B. die GBp-Linie eines USD-ETF an der LSE).
export function toMasterCurrency(quote, masterCurrency) {
	const yahooCcy = quote.currency;
	if (!yahooCcy) {
		// Bei manchen Tickern (z.B. MSCI-Indizes ^990100-USD-STRD) liefert Yahoo keine
		// Währung. Dann unverändert übernehmen wie bisher; Untereinheiten (GBp usw.)
		// kommen immer mit Währungsangabe, und der Sprung-Check greift weiterhin.
		return quote.price;
	}
	const minor = MINOR_UNIT_CURRENCIES[yahooCcy];
	const isoCcy = minor ? minor[0] : String(yahooCcy).toUpperCase();
	const divisor = minor ? minor[1] : 1;

	const master = masterCurrency ? String(masterCurrency).trim().toUpperCase() : "";
	if (master && master !== isoCcy) {
		throw new Error("Währung passt nicht: Yahoo " + yahooCcy + ", security_master " + master + " (Ticker prüfen)");
	}
	return quote.price / divisor;
}

export function checkJump(price, lastPrice) {
	if (!lastPrice || !(lastPrice > 0) || !(price > 0)) return;
	const ratio = price / lastPrice;
	if (ratio > MAX_JUMP_FACTOR || ratio < 1 / MAX_JUMP_FACTOR) {
		throw new Error("Unplausibler Preissprung: " + price + " vs. Referenzpreis (Median letzte 5) " + lastPrice + " (Faktor " + ratio.toFixed(2) + ")");
	}
}

export function median(values) {
	const s = values.slice().sort(function (a, b) { return a - b; });
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function fetchSecurities(env) {
	const query = 'SELECT "SecurityID", "Ticker", "Currency" FROM "security_master" WHERE "Collector" = ? AND "Ticker" IS NOT NULL AND "Ticker" != \'\'';
	const stmt = env.DB.prepare(query).bind(collectorConfig(env).collectorId);
	const response = await stmt.all();
	return response.results;
}

// Referenzpreis je Security für checkJump: Median der letzten 5 Preise der letzten
// 60 Tage, über alle Quellen (Collector, UBS Quotes, Uploads). Dass alle Quellen
// zählen, ist wichtig: Steht von diesem Collector nur ein einziger falscher Wert in
// der DB, wäre er sonst die Referenz und würde jeden korrekten Preis blockieren.
// Der Median sorgt dafür, dass ein einzelner Ausreisser nicht durchschlägt.
async function fetchLastPrices(env) {
	const query = 'SELECT "SecurityID", "Price" FROM (SELECT p."SecurityID", p."Price", ROW_NUMBER() OVER (PARTITION BY p."SecurityID" ORDER BY p."Price_date" DESC) AS rn FROM "security_prices" p JOIN "security_master" m ON m."SecurityID" = p."SecurityID" WHERE m."Collector" = ? AND p."Price_date" >= date(\'now\', \'-60 days\') AND p."Price" > 0) WHERE rn <= 5';
	const map = new Map();
	try {
		const response = await env.DB.prepare(query).bind(collectorConfig(env).collectorId).all();
		const bySec = new Map();
		for (const r of response.results) {
			if (!bySec.has(r.SecurityID)) bySec.set(r.SecurityID, []);
			bySec.get(r.SecurityID).push(Number(r.Price));
		}
		for (const [id, prices] of bySec) {
			map.set(id, median(prices));
		}
	} catch (e) {
		console.log("[last_prices] Konnte letzte Preise nicht lesen (Sprung-Check entfällt): " + String(e));
	}
	return map;
}

async function fetchPriceWithRetry(ticker) {
	let lastError;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await fetchYahooPrice(ticker);
		} catch (e) {
			lastError = e;
			if (attempt < MAX_RETRIES) {
				await sleep(500 * attempt);
			}
		}
	}
	throw lastError;
}

async function fetchYahooPrice(ticker) {
	const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + "?interval=1d&range=1d";
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (compatible; MunotstadtCollector/1.0)" }
	});
	if (!res.ok) {
		throw new Error("Yahoo HTTP " + res.status);
	}
	const data = await res.json();
	const meta = data.chart.result[0].meta;
	const price = meta.regularMarketPrice;
	if (price === null || price === undefined) {
		throw new Error("regularMarketPrice ist null oder undefined");
	}
	return { price: Number(price), currency: meta.currency };
}

function sleep(ms) {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

function nowInZurich() {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Zurich",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false
	});
	const parts = formatter.formatToParts(new Date());
	const values = {};
	for (let i = 0; i < parts.length; i++) {
		values[parts[i].type] = parts[i].value;
	}
	return values.year + "-" + values.month + "-" + values.day + " " + values.hour + ":" + values.minute + ":" + values.second;
}

async function insertPricesBatch(env, priceRecords) {
	const query = 'INSERT INTO "security_prices" ("SecurityID", "Price", "Price_adjusted", "Price_date", "source", "created_at", "modified_at") VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT("SecurityID", "Price_date", "source") DO UPDATE SET "Price" = excluded."Price", "Price_adjusted" = excluded."Price_adjusted", "modified_at" = excluded."modified_at"';

	const sourceName = collectorConfig(env).sourceName;
	const statements = priceRecords.map(function (r) {
		return env.DB.prepare(query).bind(r.securityId, r.price, r.price, r.priceDate, sourceName, r.priceDate, r.priceDate);
	});

	const results = await env.DB.batch(statements);
	return results.map(function (res) {
		return res.meta.changes > 0;
	});
}

async function logRun(env, collectorType, status, dataPoints, detail) {
	try {
		const createTableSql = 'CREATE TABLE IF NOT EXISTS "security_collector_runs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "collectortype" text, "runat" text, "status" text, "datapoints" text, "detail" text, "trigger" text, "runid" text, "runnumber" text, "created_at" text NOT NULL DEFAULT (datetime(\'now\')))';
		await env.DB.prepare(createTableSql).run();

		const insertSql = 'INSERT INTO "security_collector_runs" ("collectortype", "runat", "status", "datapoints", "detail", "trigger", "runid", "runnumber") VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
		await env.DB.prepare(insertSql).bind(
			collectorType,
			nowInZurich(),
			status,
			String(dataPoints),
			detail || "",
			"Scheduled",
			"",
			""
		).run();
	} catch (e) {
		console.log("[run_log] Konnte security_collector_runs-Eintrag nicht schreiben (ignoriert): " + String(e));
	}
}
