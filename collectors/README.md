# Collector-Worker

Die Collector-Worker laufen als eigene Cloudflare-Worker und schreiben direkt in D1 `securities`. Sie werden nicht über dieses Repo deployt. Hier liegt der Quellcode als Referenz.

## Yahoo-Collector (`yahoo/worker.js`)

Alle sechs Yahoo-Worker verwenden denselben Code. Pro Worker werden oben in der Datei nur `COLLECTOR_ID` und `SOURCE_NAME` gesetzt:

| Cloudflare-Worker | `COLLECTOR_ID` | `SOURCE_NAME` |
|---|---|---|
| `collector-worker-yahoodaily-0001-2359-utc` | 2 | `Collector_Worker_YahooDaily_0001-2359_UTC` |
| `collector-worker-yahooweekday-0600-2000-utc` | 4 | `Collector_Worker_YahooWeekday_0600-2000_UTC` |
| `collector-worker-yahooweekday-1200-2259-utc` | 5 | `Collector_Worker_YahooWeekday_1200-2259_UTC` |
| `collector-worker-yahooweekday-0300-2259-utc` | 6 | `Collector_Worker_YahooWeekday_0300-2259_UTC` |
| `collector-worker-yahooweekday-2135-utc` | 43 | `Collector_Worker_YahooWeekday_2135_UTC` |

### Währungen / Pence

`security_prices.Price` wird in der Währung von `security_master.Currency` geführt. Die Währung der Yahoo-Notierung steht in `chart.result[0].meta.currency` und wird bei jedem Abruf ausgewertet:

- **Untereinheiten** werden durch 100 geteilt: `GBp`/`GBX` → GBP (London), `ZAc` → ZAR (Johannesburg), `ILA` → ILS (Tel Aviv). Ob umgerechnet wird, hängt von der Yahoo-Währung ab, nicht vom Ticker-Suffix `.L`. An der LSE notieren viele ETFs in USD, EUR oder GBP.
- **Abgleich mit dem Master:** Weicht die (umgerechnete) Yahoo-Währung von `security_master.Currency` ab, wird nichts gespeichert. Der Fehler erscheint in `security_collector_runs.detail`. In diesem Fall zeigt der Ticker auf die falsche Handelslinie, z.B. die GBp-Linie eines USD-ETF.
- **Sprung-Check:** Weicht der neue Preis um mehr als Faktor 40 vom Median der letzten 5 Preise dieses Collectors ab, wird er nicht gespeichert. Das fängt Yahoos gelegentliche Wechsel zwischen GBp und GBP ab.

### Deploy

1. Einmalig zuerst `fix-gbp-pence-prices.sql` ausführen. Es korrigiert die bereits gespeicherten Pence-Kurse; ohne diesen Schritt blockiert der Sprung-Check die betroffenen Titel.
2. Pro Worker im Cloudflare-Dashboard (Workers → Worker → Edit code) den Inhalt von `yahoo/worker.js` einfügen, `COLLECTOR_ID`/`SOURCE_NAME` gemäss Tabelle setzen und deployen.
3. Kontrolle: Den Worker einmal über die URL aufrufen (die `fetch`-Route startet einen Lauf) und `errorDetails` prüfen.

Tests: `npm test` (`tests/yahoo-collector.test.mjs`).
