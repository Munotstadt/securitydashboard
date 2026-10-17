# Runbook: Turso/GitHub Pages/Neon → Cloudflare (Worker + D1)

Ziel: `https://security.munot.app`, Daten aus D1 `securities`, Deployment per Git-Push, Google-Login über Cloudflare Access.
Reihenfolge einhalten. Der Branch `cloudflare-migration` ersetzt `main` erst in Phase 5; bis dahin läuft die alte Seite unverändert weiter.

## Phase 1 – Worker bereitstellen (Cloudflare-Dashboard)
1. Workers & Pages → Create → **Import a repository** → `Munotstadt/securitydashboard`, Branch **`cloudflare-migration`**.
   Worker-Name **`securitydashboard`**, Root-Verzeichnis `/`, Deploy-Befehl `npx wrangler deploy`.
2. Nach dem ersten Build existiert die Custom Domain `security.munot.app` (kommt aus `wrangler.jsonc`, Zone `munot.app` liegt in diesem Account).
   Bis Phase 2 fertig ist, antwortet `/api/*` mit 503 (Absicht: fail closed).

## Phase 2 – Login (Zero Trust → Access → Applications)
1. **Add application → Self-hosted**, Domain `security.munot.app`, Identity Provider **Google** (wie bei den anderen Seiten), Policy „Allow“ für deine E-Mail(s).
2. (Entfallen: Service-Token für den CSV-Import wird nicht mehr benötigt.)
3. Auf der Application-Übersicht den **Application Audience (AUD) Tag** kopieren; Team-Domain = `<team>.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages / Team name).
4. In `wrangler.jsonc` unter `vars` eintragen und pushen: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. (Nicht im Dashboard setzen: `wrangler deploy` überschreibt Dashboard-Variablen.)
5. Test: `https://security.munot.app/index.html` → Google-Login → Seite lädt Daten.

## Phase 3 – Daten übernehmen (einmalig)
1. Worker → Settings → Variables and Secrets → **Secrets** `TURSO_DATABASE_URL` und `TURSO_AUTH_TOKEN` (Turso-Token mit Lesezugriff genügt).
2. `https://security.munot.app/migrate.html` und von oben nach unten:
   1 Prüfen → 2a/2b Parameter → 3a/3b Master → 4 fehlende Tabellen kopieren → 5 Indizes → 6a/6b Kurse → 7 Verifikation (`all_ok: true`).
   - Trockenläufe (a) zuerst ansehen. Master/Parameter: fehlt in D1 → einfügen; in Turso neuer (`modified_at`) → aktualisieren; D1 neuer/gleich → unberührt (steht im Ergebnis).
   - Kurse: Turso-Zeilen werden nur ergänzt, wenn D1 für dieselbe SecurityID + denselben Tag + dieselbe Quelle nichts hat (D1-Cleanup behält 1 Zeile/Tag/Quelle). Manuelle und UBS-Kurse kommen so nach D1.
   - Zeilen in `security_collector_runs`, `notes_*` bleiben unberührt (gehören D1).
3. Danach in D1 das echte Schema in `migrations/0001_baseline.sql` nachtragen (`SELECT sql FROM sqlite_master …`).

## Phase 4 – Abnahme
- Pro Seite kurz prüfen: Index, Portfolio (Δ-Werte), Security-Detail (Kurshistorie, Verteilungen), Editoren (Speichern/Löschen), Tasks, Admin (Import mit >100 Securities), Asset-Comparison.
- Auffälligkeit schon vorher in D1: Kurszeilen mit `Price_date` vor 1990 (Report zeigt die Anzahl) → prüfen/bereinigen.

## Phase 5 – Umschalten und aufräumen
1. Pull Request `cloudflare-migration` → `main` mergen. Workers Builds auf Branch `main` umstellen. GitHub Pages abschalten (Repo → Settings → Pages → None); die alte Pages-Access-App entfernen.
2. **Migration entfernen** (neuer Commit): `src/migrate.js`, `public/migrate.html`, Import und Route in `src/worker.js`; Secrets `TURSO_*` im Worker löschen.
3. GitHub-Repo-Secrets `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` löschen (Settings → Secrets and variables → Actions).
4. Worker `push-d1-to-turso-securitydb` löschen (schrieb D1 → Turso, wird nicht mehr gebraucht).
5. Auf `munotstadt.github.io` hängt noch `db_admin/assets/improvements-button.js` in allen Seiten. Das Skript muss unter der neuen Domain erreichbar sein und der Worker `db-admin` muss `https://security.munot.app` in seiner CORS-Liste haben (siehe offene Punkte).

## Phase 6 – Turso und Neon archivieren
Erst nach ein paar Tagen Betrieb ohne Auffälligkeiten.
- **Turso:** vollständigen Dump ablegen (`turso db shell munotstadtsecuritydb .dump > securitydb.sql`) und z. B. in OneDrive/R2 sichern, dann Datenbank löschen oder Token widerrufen.
- **Neon:** `pg_dump` der Datenbank `neondb` sichern. Vorher prüfen, ob noch ein Worker die Hyperdrive-Konfiguration `neon-securities` bindet (Worker → Settings → Bindings). Danach Hyperdrive-Konfiguration löschen und das Neon-Projekt pausieren/löschen.

## Offene Punkte (nicht durch dieses Repo lösbar)
| Punkt | Warum |
|---|---|
| `improvements-button.js` / CORS in `db-admin` | Lädt aktuell von `munotstadt.github.io`; nach Pages-Abschaltung 404. Muss dort (anderes Repo) neu gehostet und `https://security.munot.app` in der CORS-Liste ergänzt werden. Alternativ: das Skript-Tag aus den Seiten entfernen, die Seiten haben bereits eine eigene „Improvement“-Eingabe. |
| Master-Pflege | Collector-Worker lesen `security_master` aus D1. Nach dem Umschalten ist D1 die einzige Master-Quelle; Änderungen über `master_editor.html` wirken sofort auf die Collector. |
| Index-Seite im Repo | Die in `claude/index-formatting.md` beschriebene Überarbeitung der `index.html` (Kachel-Umbau, Top-Movers, Tasks-Teaser) ist im Repo-Stand nicht enthalten, falls sie nie hochgeladen wurde. Falls sie lokal existiert: in `public/index.html` übernehmen und `tursoQuery` → `dbQuery` ersetzen. |
