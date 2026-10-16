-- Baseline des D1-Schemas "securities" (Stand 2026-10-16, vor der Turso-Migration).
-- Dokumentation, wird nicht automatisch ausgeführt. Die Tabellen, die bisher nur in Turso lagen
-- (security_transactions, security_distributions, security_data, security_data_log, security_tasks,
-- security_task_completions, security_currencies, asset_comparison_*, security_name_mapping, ...)
-- legt die Migration (src/migrate.js) mit dem DDL aus Turso an. Nach der Migration das tatsächliche
-- Schema hier nachtragen:  SELECT sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name;

CREATE TABLE security_parameter (
  ParameterID integer PRIMARY KEY, ParameterName text NOT NULL, ParaTable text NOT NULL, ParaField text NOT NULL,
  created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));

CREATE TABLE security_master (
  SecurityID integer PRIMARY KEY, SecurityName text NOT NULL,
  Collector integer REFERENCES security_parameter(ParameterID), Ticker text, ID_ISIN text, ID_Valor integer, Currency text,
  DashboardGrouping integer REFERENCES security_parameter(ParameterID), Instrument integer REFERENCES security_parameter(ParameterID),
  PortfolioGrouping integer REFERENCES security_parameter(ParameterID), DateLaunch text, DateTerminated text,
  Status integer REFERENCES security_parameter(ParameterID), Comments text, UBSQuotesName text, TER real,
  created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));

CREATE TABLE security_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, SecurityID INTEGER NOT NULL REFERENCES security_master(SecurityID),
  Price REAL NOT NULL, Price_adjusted REAL NOT NULL, Price_date text NOT NULL, source text,
  created_at text NOT NULL DEFAULT (datetime('now')), modified_at text NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_security_prices_unique ON security_prices (SecurityID, Price_date, source);

CREATE TABLE security_collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collectortype text, runat text, status text, datapoints text, detail text,
  trigger text, runid text, runnumber text, created_at text NOT NULL DEFAULT (datetime('now')));

CREATE TABLE notes_log (
  NoteID INTEGER PRIMARY KEY AUTOINCREMENT, Date TEXT NOT NULL, Note_text TEXT, SecurityID TEXT, NoteCategory TEXT, NoteFlag TEXT,
  created_at TEXT DEFAULT (datetime('now')), modified_at TEXT DEFAULT (datetime('now')));
CREATE INDEX idx_notes_log_date ON notes_log(Date);
CREATE INDEX idx_notes_log_security ON notes_log(SecurityID);

CREATE TABLE notes_jpgs (
  ImageID INTEGER PRIMARY KEY AUTOINCREMENT, NoteID INTEGER NOT NULL, filename TEXT, content_type TEXT, r2_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (NoteID) REFERENCES notes_log(NoteID));
CREATE INDEX idx_notes_jpgs_noteid ON notes_jpgs(NoteID);
