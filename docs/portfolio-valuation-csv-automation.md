# Portfolio valuation CSV automation (data/securityprices.csv)

## Status: fully working end-to-end as of 2026-08-22

GitHub Actions → data/securityprices.csv → local download script → Access linked table →
Access append query → SEC_Value_log_tbl. VBA button code updated to match; still needs the button
itself wired up and enabled in the live Access form (last unconfirmed step).

## Step 1 — Scheduled CSV generation (GitHub side)

### Scope/eligibility logic (must match portfolio.html's Valuation CSV button)

A SecurityID is included if EITHER:
- net Quantity != 0 (sum of Buy/Sell transaction Quantity from security_transactions, joined to
  security_parameter for TrxArt name), OR
- security_master.DashboardGrouping IS NOT NULL

For each eligible security, export the latest price row (max PriceDate). Output columns, sorted by
numeric SecurityID: `SecurityID,PriceDate,Price,Source`. Mirrors `buildValuationCsv()` /
`netQuantity()` / DashboardGrouping check in portfolio.html — keep the two in sync if that logic ever
changes.

### Files (in Munotstadt/securitydashboard repo; this session has no push access, user edits via GitHub web UI)

- `scripts/generate-security-prices.js` — talks to Turso via raw `/v2/pipeline` HTTP API, no npm deps,
  reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` env vars.
- `.github/workflows/update-security-prices.yml` — cron at UTC 01:00, 13:00, 17:00, 18:00, 19:00 daily
  + `workflow_dispatch`. Commits `data/securityprices.csv` only if changed — uses `git add` then
  `git status --porcelain` (NOT `git diff --quiet`, which misses untracked files — bug found and fixed
  during rollout). Repo secrets `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are set; workflow confirmed
  working, file confirmed present at data/securityprices.csv on main.

## Step 2 — MS Access import (client side)

### Files delivered to user (SendUserFile, not via repo)

- `download-securityprices-csv.js` — lives in `C:\MunotstadtTools\AccessERP_GithubImport\` (script
  location). Downloads the raw CSV from
  `https://raw.githubusercontent.com/Munotstadt/securitydashboard/main/data/securityprices.csv` and
  saves it to **`C:\Users\phili\OneDrive\1_Finance\Data Management\securityprices.csv`** (output path -
  chosen by user, same folder as their existing unrelated `accounting.csv`, different filename).
  Deliberately NOT named `download-csv.js` — that name is already used in
  `C:\MunotstadtTools\AccessERP_GithubImport\` by an unrelated accounting-feed script (different repo:
  accountingdatacollector, different output file: accounting.csv). Must not collide.
- `ImportSecurityPrices.bas` — VBA sub **`SecurityPricesImportButton_Click`** (renamed from
  `ImportButton_Click` to avoid colliding with the user's existing accounting-import button/procedure).
  Runs download-securityprices-csv.js via WSH (waits for completion), then runs
  `FIGIT_SecurityPrices_import_aqry` (query name updated 2026-08-22, was briefly
  `FIGIT_Import_aqry`/`FIGIT_SecurityPrices_import_aqry` during naming iteration — CONFIRM this is the
  final name, matches the query the user built and confirmed working).
- `SETUP.md` — STALE, written before naming collisions/path changes were discovered. Do not follow
  literally; this doc is authoritative.

### Access-side objects the user built directly in the .accdb (this session cannot create/edit these)

Linked table: `FIGIT_SecurityPrices_tbl_link` — linked to the CSV above. IMPORTANT: `PriceDate` must be
linked/imported as **Text**, not Number or Date/Time — first attempt used default type detection and
got `#Num!` errors on every PriceDate cell. Fixed by deleting the link and recreating it via
Externe Daten → Textdatei → Verknüpfung → Erweitert, setting PriceDate's column type to Text explicitly.

Target table: `SEC_Value_log_tbl` (fields: LogID autonumber, MainID number = SecurityID FK,
ValueDefinitionID number, ValueDate date/time, AmountLC number, ValueComment short text, Source short
text, DateAdd date/time, DateModified date/time).

Mapping used: MainID=SecurityID, ValueDefinitionID=48 (fixed constant for "security price" value type),
ValueDate=converted PriceDate, AmountLC=Price, ValueComment=Null, Source="GitAuto" & csv.Source,
DateAdd=Now(), DateModified=Now().

Three saved queries were needed (not one) because Access's Jet/ACE SQL engine rejected: (a) `IIf()`
expressions directly inside a JOIN's `ON` clause ("Join expression not supported"), and (b) mixing an
inline derived-table subquery with a multi-condition JOIN that included a literal constant comparison.
Splitting into separate saved queries, each simple, worked:

1. **`FIGIT_SecurityPrices_DateConv_qry`** — selects from `FIGIT_SecurityPrices_tbl_link`, computes
   `ValDate: IIf(IsDate(PriceDate), CDate(PriceDate), Null)`, filters `WHERE IsDate(PriceDate)`.
2. **`FIGIT_SecurityPrices_ExistingPrices48_qry`** — `SELECT MainID, ValueDate FROM SEC_Value_log_tbl
   WHERE ValueDefinitionID = 48` (pre-filters existing rows of this value type for the dedup join).
3. **`FIGIT_SecurityPrices_import_aqry`** — the actual append query: `INSERT INTO SEC_Value_log_tbl (...)
   SELECT ... FROM FIGIT_SecurityPrices_DateConv_qry AS csv LEFT JOIN
   FIGIT_SecurityPrices_ExistingPrices48_qry AS existing ON csv.SecurityID = existing.MainID AND
   csv.ValDate = existing.ValueDate WHERE existing.MainID Is Null`. Only 2 field=field join conditions,
   no literals in ON — this version worked. **User confirmed this query runs successfully** (2026-08-22).
   Duplicate protection: re-running with unchanged CSV data appends 0 rows.

### Still open (not yet confirmed by user)

- Wiring an actual command button (e.g. named `SecurityPricesImportButton`) in the Access form to call
  `SecurityPricesImportButton_Click`, and confirming the "Windows Script Host Object Model" VBA
  reference is enabled.
- End-to-end test: click the button (not just running the query manually) and confirm both the download
  and the import happen automatically in sequence.
