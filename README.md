# securitydashboard

Wertschriften-Dashboard (Vanilla HTML/CSS/JS) auf Cloudflare: **ein Worker** liefert die Seiten (`public/`) und die API (`/api/*`) unter **https://security.munot.app**. Daten liegen in der Cloudflare-D1-Datenbank `securities`. Login über Cloudflare Access (Google).

```
Browser ──► security.munot.app ──► Cloudflare Access (Google-Login)
                                    ├─ /*      statische Seiten  (public/)
                                    └─ /api/*  Worker (src/worker.js) ──► D1 "securities"
```

| Pfad | Inhalt |
|---|---|
| `public/` | Seiten + `assets/db-data.js` (DB-Zugriff über `POST /api/db`, Cache, Datums-/Währungshelfer) |
| `src/worker.js` | API: `/api/db` (SELECT/INSERT/UPDATE/DELETE als Batch = Transaktion), `/api/me`; prüft das Access-JWT |
| `wrangler.jsonc` | Worker-Konfiguration (Assets, D1-Binding, Custom Domain, Access-Variablen) |
| `migrations/` | D1-Schema-Dokumentation (Schemaänderungen nur hier, nicht aus dem Browser) |
| `tests/` | `npm test`: Worker, Access-JWT, Client-Bibliothek, Migration (lokal, ohne Cloudflare) |
| `docs/` | Runbook, CSV-Automation, Währungs-Magnitude-Check |

## Deployment
Push auf den verbundenen Branch → Cloudflare Workers Builds (`npx wrangler deploy`). Keine Tokens in GitHub; D1 ist per Binding angebunden, Secrets liegen nur in Cloudflare.

## Wichtige Eigenheiten
- **D1 erlaubt max. 100 Parameter pro Statement.** Für `IN (…)`-Listen `dbQueryIn()` verwenden (chunked, eine Round-Trip).
- **Kurstabelle** (`security_prices`): Spalten `Price`, `Price_adjusted` (NOT NULL), `Price_date`, `source`. Die Seiten lesen per Alias (`Price_date AS PriceDate`, `source AS Source`) und schreiben mit D1-Namen. Eindeutig ist `(SecurityID, Price_date, source)`.
- Die Collector-Worker (`collector-worker-*`) und `cleanup-prices-weekly` schreiben direkt in D1 und sind von diesem Repo unabhängig.
- `workers_dev` und Preview-URLs sind aus: sonst wäre der Worker an Access vorbei erreichbar. Die API prüft das Access-JWT zusätzlich selbst und antwortet 503, solange `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` fehlen.
