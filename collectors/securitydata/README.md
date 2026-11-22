# collector-worker-securitydata-monthly

Ersetzt die GitHub Actions `collect_fund_data.py` und `collect_share_data.py` (Repo `securitydatacollector_turso`), die nach Turso schrieben. Schreibt direkt in D1 `securities` → `security_data`, Source `yfinance`, mit denselben Feldnamen und derselben Skalierung wie bisher.

| Instrument | Yahoo-Module | DataTypes |
|---|---|---|
| ETF/Funds | topHoldings, fundProfile, summaryProfile | TopHolding, AssetClass, SectorWeight, BondRating, FundOverview |
| Shares (19) | summaryDetail, defaultKeyStatistics, financialData | Fundamental (marketCap, trailingPE, priceToBook, sharesOutstanding, …) |

Zeitplan: am 1. jedes Monats, 02:00–05:50 UTC alle 10 Minuten (24 Slots à 25 Securities, bis 600 Securities). So bleibt jeder Aufruf unter dem Subrequest-Limit. Ein zweiter Lauf am selben Tag ersetzt die Werte dieses Tages statt sie zu duplizieren. Jeder Slot schreibt eine Zeile in `security_collector_runs` (`Yahoo Fund/Share Data (monthly)`).

## Einrichten im Cloudflare-Dashboard
1. **Workers & Pages → Create → Worker** („Hello World“), Name `collector-worker-securitydata-monthly`, Deploy.
2. **Edit code**: Inhalt von `worker.js` komplett einfügen → Deploy.
3. **Settings → Bindings → Add → D1 database**: Variablenname `DB`, Datenbank `securities`.
4. **Settings → Trigger Events → Add → Cron Trigger**: `*/10 2-5 1 * *`
5. **Settings → Variables and Secrets → Add → Secret** `RUN_TOKEN` (beliebige lange Zufallszeichenkette). Nur nötig für den manuellen Start.

## Manuell starten / testen
```bash
curl -H "Authorization: Bearer <RUN_TOKEN>" "https://collector-worker-securitydata-monthly.<subdomain>.workers.dev/?ticker=NESN.SW"
```
Weitere Varianten: `?slot=0` (Securities 1–25, `?slot=1` 26–50, …) oder `?ids=123,456` (max. 25). Die Antwort zeigt `ok`, `skipped` (Yahoo ohne Daten), `failed` und die Fehler.

## Danach
- Turso existiert nicht mehr: Die alten Workflows `Collect_funddata_weekly.yml` und `collect_share_data.yml` im Repo `securitydatacollector_turso` schlagen nur noch fehl. Deaktivieren (GitHub → Actions → Workflow → „Disable workflow“) oder das Repo archivieren.
- Die Stichtage zwischen 11.10.2026 (letzter Turso-Lauf, nach D1 übernommen) und dem ersten Lauf dieses Workers lassen sich nicht nachholen: Yahoo liefert keine historischen Fundamentals. Für einen sofortigen Stichtag nach dem Einrichten die Slots von Hand starten (`?slot=0` bis `?slot=7` bei rund 190 Securities).
