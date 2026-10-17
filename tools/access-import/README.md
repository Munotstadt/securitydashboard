# Kurs-Import nach MS Access (D1 → CSV → Access)

Dokumentation des gesamten Ablaufs: vom Klick auf den Button in Access bis zu den Kursen in `SEC_Value_log_tbl`.
Betrifft **nur** den Kurs-Download (`securityprices`). Der Buchhaltungs-Download (`download-csv.js`) ist ein separater
Prozess und bleibt unverändert.

## 1. Überblick

```
Access-Button "SecurityPricesImportButton"
   │  1. Frage: aktuellste Kurse ODER Schlusskurse per Stichtag (TT.MM.JJJJ)
   ▼
node.exe  C:\MunotstadtTools\AccessERP\download-securityprices-csv.js --mode=… [--asof=…]
   │  2. liest secrets.json (Service Token)
   │  3. HTTPS GET  https://security.munot.app/api/securityprices.csv?mode=…&asof=…
   ▼
Cloudflare Access  (prüft den Service Token, Policy "Service Auth")
   ▼
Cloudflare Worker "securitydashboard"  (prüft zusätzlich das Access-JWT)
   │  4. SQL auf D1 "securities"  (security_master, security_transactions, security_prices)
   ▼
CSV  SecurityID,PriceDate,Price,Source
   │  5. Skript schreibt C:\Users\phili\OneDrive\1_Finance\Data Management\securityprices.csv
   ▼
Access: verknüpfte Tabelle FIGIT_SecurityPrices_tbl_link  →  Abfragen  →  SEC_Value_log_tbl
        (FIGIT_SecurityPrices_import_aqry, wird vom Button nach dem Download ausgeführt)
```

## 2. Dateien

| Ort | Datei | Zweck | Ins Git? |
|---|---|---|---|
| `C:\MunotstadtTools\AccessERP\` | `download-securityprices-csv.js` | Download-Skript (Node.js) | ja (Repo: `tools/access-import/`) |
| `C:\MunotstadtTools\AccessERP\` | `secrets.json` | Zugangsdaten (Service Token) | **nein** (`.gitignore`) |
| `C:\MunotstadtTools\AccessERP\` | `download.log` | Protokoll aller Läufe, wird vom Skript angelegt | nein |
| Repo | `secrets.example.json` | Vorlage für `secrets.json` | ja (ohne Werte) |
| Repo | `SecurityPricesImportButton_Click.vba.txt` | VBA-Code des Buttons | ja |
| `C:\Users\phili\OneDrive\1_Finance\Data Management\` | `securityprices.csv` | Ausgabe; Quelle der Access-Verknüpfung | nein |

Der Zielpfad der CSV steht oben im Skript (`OUT_PATH`). Er darf nicht geändert werden, solange die Access-Verknüpfung
`FIGIT_SecurityPrices_tbl_link` darauf zeigt.

## 3. Einrichtung (einmalig)

1. **Ordner** `C:\MunotstadtTools\AccessERP\` anlegen und `download-securityprices-csv.js` hineinkopieren.
   Voraussetzung: Node.js ≥ 18 unter `C:\Program Files\nodejs\node.exe` (wegen `fetch`).
2. **Service Token** erstellen: Cloudflare Zero Trust → *Access controls* → *Service credentials* → *Create service token*,
   Name `securitydashboard-access-import`, Laufzeit lang. **Client ID und Client Secret sofort kopieren** (das Secret wird nur einmal angezeigt).
3. **Policy** in der Access-App `security` (Domain `security.munot.app`): neue Policy, Aktion **Service Auth**,
   Include **Service Token** = `securitydashboard-access-import`.
4. **`secrets.json`** im Ordner `C:\MunotstadtTools\AccessERP\` anlegen (Vorlage: `secrets.example.json`):
   ```json
   { "clientId": "xxxx.access", "clientSecret": "xxxx" }
   ```
   Die Datei nicht weitergeben, nicht in OneDrive-Freigaben und nicht ins Git legen.
5. **VBA-Code**: Inhalt von `SecurityPricesImportButton_Click.vba.txt` im VBA-Editor (Alt+F11) in das Code-Modul des
   Formulars einfügen, das den Button `SecurityPricesImportButton` enthält (alte Version ersetzen).
6. **Test** (siehe Abschnitt 5).

## 4. Bedienung

Button drücken → Frage:

| Antwort | Bedeutung |
|---|---|
| **Ja** | Aktuellste Kurse: je Wertschrift der jüngste Kurs in D1 |
| **Nein** | Schlusskurse per Stichtag: Datum im Format `TT.MM.JJJJ` eingeben, z.B. `15.10.2026` |
| **Abbrechen** | nichts passiert |

Danach lädt das Skript die CSV und Access führt die Import-Abfrage aus. Am Ende erscheint eine Erfolgsmeldung
(oder bei Fehlern die letzte Zeile aus `download.log`).

Das Skript lässt sich auch direkt in der Konsole starten:

```
cd C:\MunotstadtTools\AccessERP
node download-securityprices-csv.js                                  (fragt interaktiv: 1 = aktuell, 2 = Stichtag)
node download-securityprices-csv.js --mode=latest
node download-securityprices-csv.js --mode=close --asof=15.10.2026   (auch --asof=2026-10-15)
```

## 5. Ablauf im Detail

### 5.1 Skript `download-securityprices-csv.js`

1. **Parameter lesen** (`--mode`, `--asof`). Ohne `--mode` fragt das Skript in der Konsole; ohne Konsole (z.B. Aufruf aus VBA ohne Parameter) bricht es mit Code 2 ab.
2. **Eingaben prüfen**: Modus `latest` oder `close`; Stichtag muss ein echtes Datum sein (`31.02.2026` wird abgelehnt) und darf nicht in der Zukunft liegen.
3. **Zugangsdaten laden** aus `secrets.json` (Felder `clientId`, `clientSecret`). Alternativ aus den Umgebungsvariablen `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.
4. **Abruf** `GET https://security.munot.app/api/securityprices.csv?mode=latest` bzw. `?mode=close&asof=2026-10-15` mit den Headern `CF-Access-Client-Id` und `CF-Access-Client-Secret`. Eine Weiterleitung (HTTP 3xx) bedeutet, dass Access den Token nicht akzeptiert hat. Zeitlimit 60 Sekunden.
5. **Antwort prüfen**: HTTP 200, Kopfzeile `SecurityID,PriceDate,Price,Source`, mindestens eine Datenzeile. Bei 0 Zeilen (z.B. Stichtag vor dem ersten Kurs) wird eine **bestehende CSV nicht überschrieben**.
6. **Schreiben** in `securityprices.csv.tmp`, dann Umbenennen auf `securityprices.csv` (atomar: Access sieht nie eine halbe Datei).
7. **Protokoll** in `download.log` (Zeitpunkt, Modus, Stichtag, Zeilenzahl oder Fehler).

Exit-Codes: `0` = OK · `1` = Fehler (Netz, Token, Server, leere Antwort) · `2` = Abbruch oder ungültige Eingabe.

### 5.2 API `GET /api/securityprices.csv` (Worker `securitydashboard`)

| Parameter | Bedeutung |
|---|---|
| `mode=latest` (Standard) | je Wertschrift der Kurs mit dem jüngsten `Price_date` |
| `mode=close&asof=DATUM` | je Wertschrift der letzte Kurs **bis und mit Ende des Stichtags** (`Price_date` < Stichtag + 1 Tag). `DATUM` = `YYYY-MM-DD` oder `DD.MM.YYYY` |

* **Welche Wertschriften** (Scope): Nettobestand (Buy/Sell aus `security_transactions`) ≠ 0 **oder** `security_master.DashboardGrouping` gesetzt.
  Im Modus `close` zählen nur Transaktionen **bis und mit Stichtag** (`DateTrx`, Format `TT.MM.JJJJ`). Eine inzwischen verkaufte Position ist also per Stichtag noch enthalten.
* **Gleicher Tag mehrere Kurse**: der jüngste (`Price_date`, dann höchste `id`).
* **Kein Kurs am Stichtag** (Wochenende, Feiertag): der letzte frühere Kurs wird verwendet. Die Spalte `PriceDate` zeigt das tatsächliche Datum des Kurses.
* **Spalten**: `SecurityID,PriceDate,Price,Source` (`PriceDate` im Format der Datenbank: `YYYY-MM-DD HH:MM:SS` oder `YYYY-MM-DD`, `Source` = Kursquelle).
* **Schutz**: Cloudflare Access am Rand (Service Token); der Worker prüft zusätzlich das Access-JWT (Signatur, Aussteller, Audience, Ablauf). Nur lesender Zugriff: Der Worker lässt Service Tokens (JWT ohne E-Mail) ausschliesslich diesen Endpunkt abrufen; `/api/db`, `/api/improvements` usw. antworten ihnen mit 403.
* Dieselbe Scope-Logik wie der Button „⬇ Valuation CSV" in `portfolio.html` (dieser exportiert nur die aktuellen Werte).

### 5.3 Access-Teil

Nach erfolgreichem Download führt der Button die Abfrage `FIGIT_SecurityPrices_import_aqry` aus
(Aufbau: siehe `docs/portfolio-valuation-csv-automation.md`, Abschnitt Access-Objekte). `PriceDate` muss in der
verknüpften Tabelle `FIGIT_SecurityPrices_tbl_link` als Text eingelesen und über `FIGIT_SecurityPrices_DateConv_qry`
umgewandelt werden, da das Format mit und ohne Uhrzeit vorkommt (`2026-10-15` oder `2026-10-15 23:45:21`).

## 6. VBA-Code im Detail (`SecurityPricesImportButton_Click`)

Vollständiger Code: `SecurityPricesImportButton_Click.vba.txt`.

| Schritt | Was passiert |
|---|---|
| Konstanten | Pfad von `node.exe`, Ordner `C:\MunotstadtTools\AccessERP\`, Skriptname, Logdatei, Name der Import-Abfrage |
| 1 Pfade prüfen | Fehlt `node.exe` oder das Skript, erscheint eine Meldung und die Prozedur endet |
| 2 Frage | `MsgBox` mit Ja/Nein/Abbrechen. Bei *Nein* fragt `InputBox` den Stichtag ab und wiederholt, bis ein gültiges Datum (`ParseSwissDate`, nicht in der Zukunft) eingegeben ist. Leere Eingabe = Abbruch |
| Parameter bauen | `--mode=latest` oder `--mode=close --asof=TT.MM.JJJJ` |
| 3 Skript starten | `WScript.Shell.Run` mit Arbeitsordner `AccessERP`, Fenster versteckt (`0`), VBA wartet bis zum Ende (`True`). Der Rückgabewert ist der Exit-Code |
| 4 Fehler | Exit-Code ≠ 0: Meldung mit der letzten Zeile aus `download.log` (`LastLogLine`); die Import-Abfrage wird **nicht** ausgeführt |
| 5 Import | `DoCmd.SetWarnings False`, `DoCmd.OpenQuery "FIGIT_SecurityPrices_import_aqry"`, `SetWarnings True`; danach Erfolgsmeldung mit Modus und `Me.Requery` |
| Fehlerbehandlung | `ImportError:` stellt Warnungen und Mauszeiger wieder her und zeigt `Err.Description` |
| Hilfsfunktionen | `ParseSwissDate` (TT.MM.JJJJ → Date, unabhängig von den Regionseinstellungen, erkennt z.B. 31.02.), `LastLogLine` (letzte Logzeile) |

## 7. Fehlersuche

| Meldung in `download.log` / Access | Ursache | Lösung |
|---|---|---|
| `Zugangsdaten fehlen: …secrets.json nicht gefunden` | Datei fehlt oder liegt im falschen Ordner | `secrets.json` in `C:\MunotstadtTools\AccessERP\` anlegen |
| `secrets.json braucht die Felder "clientId" und "clientSecret"` | falsche Feldnamen | Vorlage `secrets.example.json` verwenden |
| `HTTP 302 (Weiterleitung zum Access-Login …)` | Token ungültig/abgelaufen oder Policy „Service Auth" fehlt | Token und Policy in Zero Trust prüfen, ggf. neuen Token erstellen und `secrets.json` aktualisieren |
| `HTTP 401` | Access-JWT fehlt oder Audience stimmt nicht | Policy gehört zur App `security`? Worker-Variablen `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` prüfen |
| `HTTP 400 (… asof required …)` | Stichtag fehlt/ungültig | Datum als `TT.MM.JJJJ` eingeben |
| `Keine Kurse für: Schlusskurse per …` | vor dem Stichtag existiert kein Kurs | späteren Stichtag wählen; die alte CSV bleibt unverändert |
| `fetch failed` / Zeitüberschreitung | kein Internet, Firewall, Proxy | Verbindung prüfen; `https://security.munot.app` im Browser öffnen |
| Access importiert nichts Neues | Abfrage fügt nur Kurse an, die noch nicht in `SEC_Value_log_tbl` stehen | erwartetes Verhalten (`ExistingPrices48`-Abfrage) |
| `node.exe wurde nicht gefunden` | Node.js fehlt oder anderer Pfad | Node.js (≥ 18) installieren oder `NODE_PATH` im VBA-Code anpassen |

## 8. Sicherheit

* `secrets.json` enthält den Service Token. Wer ihn hat, kann die Kurs-CSV abrufen (nur diesen Endpunkt, nur lesen). Nicht ins Git, nicht per Mail/Chat weitergeben.
* Verdacht auf Missbrauch oder Datei verloren: in Zero Trust den Token löschen bzw. neu erstellen und `secrets.json` ersetzen.
* Der Token gilt nur, wenn die Policy „Service Auth" in der App `security` gesetzt ist.
