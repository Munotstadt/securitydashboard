# Collector-Worker

Die Collector-Worker laufen als eigene Cloudflare-Worker und schreiben direkt in D1 `securities`. Die Yahoo-Collector werden aus diesem Repo per Wrangler deployt (siehe unten). `collector-worker-master`, `collector-worker-others-*` und `cleanup-prices-weekly` sind hier nicht enthalten und werden weiterhin im Dashboard gepflegt.

## Yahoo-Collector (`yahoo/worker.js`)

Alle fünf Yahoo-Worker verwenden denselben Code. `COLLECTOR_ID` und `SOURCE_NAME` kommen pro Worker als Variablen aus `yahoo/wrangler.jsonc` (ein Environment pro Worker):

| Environment | Cloudflare-Worker | `COLLECTOR_ID` | `SOURCE_NAME` |
|---|---|---|---|
| `yahoo-daily` | `collector-worker-yahoodaily-0001-2359-utc` | 2 | `Collector_Worker_YahooDaily_0001-2359_UTC` |
| `yahoo-0600-2000` | `collector-worker-yahooweekday-0600-2000-utc` | 4 | `Collector_Worker_YahooWeekday_0600-2000_UTC` |
| `yahoo-1200-2259` | `collector-worker-yahooweekday-1200-2259-utc` | 5 | `Collector_Worker_YahooWeekday_1200-2259_UTC` |
| `yahoo-0300-2259` | `collector-worker-yahooweekday-0300-2259-utc` | 6 | `Collector_Worker_YahooWeekday_0300-2259_UTC` |
| `yahoo-2135` | `collector-worker-yahooweekday-2135-utc` | 43 | `Collector_Worker_YahooWeekday_2135_UTC` |

### Währungen / Pence

`security_prices.Price` wird in der Währung von `security_master.Currency` geführt. Die Währung der Yahoo-Notierung steht in `chart.result[0].meta.currency` und wird bei jedem Abruf ausgewertet:

- **Untereinheiten** werden durch 100 geteilt: `GBp`/`GBX` → GBP (London), `ZAc` → ZAR (Johannesburg), `ILA` → ILS (Tel Aviv). Ob umgerechnet wird, hängt von der Yahoo-Währung ab, nicht vom Ticker-Suffix `.L`. An der LSE notieren viele ETFs in USD, EUR oder GBP.
- **Abgleich mit dem Master:** Weicht die (umgerechnete) Yahoo-Währung von `security_master.Currency` ab, wird nichts gespeichert. Der Fehler erscheint in `security_collector_runs.detail`. In diesem Fall zeigt der Ticker auf die falsche Handelslinie, z.B. die GBp-Linie eines USD-ETF.
- **Sprung-Check:** Weicht der neue Preis um mehr als Faktor 40 vom Median der letzten 5 Preise (letzte 60 Tage, **alle Quellen** inkl. UBS) ab, wird er nicht gespeichert. Das fängt Yahoos gelegentliche Wechsel zwischen GBp und GBP ab, auch wenn Yahoo einen Pence-Wert mit dem Label `GBP` liefert. Weil alle Quellen zählen, kann ein einzelner falscher Collector-Wert in der DB den Titel nicht blockieren.

### Deploy vom eigenen PC

Einmalig einrichten (Node.js 20 oder neuer muss installiert sein):

```bash
git clone https://github.com/Munotstadt/securitydashboard.git
cd securitydashboard
npm install
npx wrangler login
```

`wrangler login` öffnet den Browser für die Anmeldung bei Cloudflare. Ein API-Token ist nicht nötig.

Deployen:

```bash
npm test
npm run deploy:collectors
```

Varianten:
- `npm run deploy:collectors -- yahoo-2135`: nur einen Worker deployen
- `npm run deploy:collectors -- --dry-run`: nur prüfen, nichts hochladen

Hinweise:
- **Cron-Trigger** stehen bewusst nicht in `wrangler.jsonc`. Wrangler lässt die bestehenden Zeitpläne dann unverändert, sie werden weiter im Dashboard gepflegt. Wer `triggers` einträgt, überschreibt sie.
- `keep_vars: true`: Im Dashboard gesetzte Variablen bleiben erhalten.
- Kontrolle nach dem Deploy: Den Worker einmal über seine URL aufrufen (die `fetch`-Route startet einen Lauf) und `errorDetails` prüfen.
- Die einmalige Datenkorrektur `fix-gbp-pence-prices.sql` wurde am 2026-11-02 in D1 ausgeführt.

Tests: `npm test` (`tests/yahoo-collector.test.mjs`).
