-- Asset-Allocation-Regeln (2026-10-24). Ergebnis: security_asset_allocation erzwingt die Definition per CHECK.
--
--   Share        Region: Switzerland, USA, Europe, Asia Pacific, Emerging Markets
--   Bonds        Region: Switzerland, USA, Europe
--   Alternative  Subclass (Spalte SubCategory) Pflicht: Real Estate, Commodities & Metals, Real Assets,
--                Crypto Currencies, FX Hedges. Region wählbar (Switzerland, USA, Europe, Asia Pacific,
--                Emerging Markets, World), Standard World.
--   Sub-Region   nur bei Region Europe (optional): UK, Eurozone, Nordics (Sweden, Norway, Denmark)
--   SubCategory  nur bei Alternative, sonst NULL
--   Country      Freitext (Vorschläge je Region in aa.html), keine Bereinigung der Altwerte
--
-- Datenumstellung: Share 'World' -> 'Emerging Markets' (alles EM-Fonds/China), 'AsiaPacific' -> 'Asia Pacific',
-- Europe-Zeilen mit Country Sweden/Norway/Denmark -> SubRegion 'Nordics', Leerstrings -> NULL.
-- Spaltenreihenfolge bleibt wie bisher (positionelle Leser).
--
-- In Produktion (D1 "securities") am 2026-10-24 ausgeführt. Nicht erneut ausführen. Vorher Backup in
-- security_asset_allocation_bak_20261024 (nach stabilem Betrieb löschen: DROP TABLE security_asset_allocation_bak_20261024).
-- Für frische Datenbanken: nach 0003, 0005, 0006 (und der Spalte SubCategory TEXT) ausführen.

-- 1) Backup
CREATE TABLE security_asset_allocation_bak_20261024 AS SELECT * FROM security_asset_allocation;

-- 2) Neue Tabelle mit den Regeln
CREATE TABLE security_asset_allocation_new (
  AllocationID    INTEGER PRIMARY KEY AUTOINCREMENT,
  SecurityID      INTEGER NOT NULL REFERENCES security_master(SecurityID),
  AssetClass      TEXT NOT NULL CHECK (AssetClass IN ('Share','Bonds','Alternative')),
  Region          TEXT NOT NULL,
  Country         TEXT,
  SubSecurity     TEXT,
  Sector          TEXT NOT NULL DEFAULT '_not defined' CHECK (Sector IN (
                    'Basic materials','Communication','Consumer discretionary','Consumer staples','Energy',
                    'Financials','Health Care','Industrials','Real Estate','Technology','Telecommunication',
                    'Utilities','_not defined')),
  Weight          REAL NOT NULL CHECK (Weight > 0 AND Weight <= 100),
  modified_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  created_at_utc  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  CurrencyRisk    TEXT,
  SubRegion       TEXT,
  SubCategory     TEXT,
  CHECK (
    (AssetClass = 'Share'       AND Region IN ('Switzerland','USA','Europe','Asia Pacific','Emerging Markets')) OR
    (AssetClass = 'Bonds'       AND Region IN ('Switzerland','USA','Europe')) OR
    (AssetClass = 'Alternative' AND Region IN ('Switzerland','USA','Europe','Asia Pacific','Emerging Markets','World'))),
  CHECK (SubRegion IS NULL OR (Region = 'Europe' AND SubRegion IN ('UK','Eurozone','Nordics'))),
  -- Achtung: NULL in einem CHECK gilt in SQLite als bestanden, daher explizit IS NOT NULL
  CHECK ((AssetClass = 'Alternative' AND SubCategory IS NOT NULL AND SubCategory IN ('Real Estate','Commodities & Metals','Real Assets','Crypto Currencies','FX Hedges'))
      OR (AssetClass <> 'Alternative' AND SubCategory IS NULL))
);

-- 3) Daten kopieren und umstellen (Zeilen, die sich ändern, bekommen ein neues modified_at_utc)
INSERT INTO security_asset_allocation_new
  (AllocationID, SecurityID, AssetClass, Region, Country, SubSecurity, Sector, Weight, modified_at_utc, created_at_utc, CurrencyRisk, SubRegion, SubCategory)
SELECT AllocationID, SecurityID, AssetClass,
       CASE WHEN AssetClass = 'Share' AND Region = 'World' THEN 'Emerging Markets'
            WHEN Region = 'AsiaPacific' THEN 'Asia Pacific'
            ELSE Region END,
       Country, SubSecurity, Sector, Weight,
       CASE WHEN (AssetClass = 'Share' AND Region = 'World') OR Region = 'AsiaPacific'
              OR (Region = 'Europe' AND Country IN ('Sweden','Norway','Denmark') AND COALESCE(SubRegion,'') <> 'Nordics')
            THEN strftime('%Y-%m-%d %H:%M:%S','now') ELSE modified_at_utc END,
       created_at_utc,
       NULLIF(CurrencyRisk, ''),
       CASE WHEN Region = 'Europe' AND Country IN ('Sweden','Norway','Denmark') THEN 'Nordics' ELSE NULLIF(SubRegion, '') END,
       NULLIF(SubCategory, '')
  FROM security_asset_allocation;

-- 4) Tausch
DROP VIEW IF EXISTS security_asset_allocation_check;
DROP TABLE security_asset_allocation;
ALTER TABLE security_asset_allocation_new RENAME TO security_asset_allocation;
CREATE INDEX idx_security_asset_allocation_security ON security_asset_allocation (SecurityID);
CREATE VIEW security_asset_allocation_check AS
  SELECT SecurityID, COUNT(*) AS Rows, ROUND(SUM(Weight), 4) AS WeightSum, ROUND(SUM(Weight) - 100, 4) AS Deviation
    FROM security_asset_allocation
   GROUP BY SecurityID
  HAVING ABS(SUM(Weight) - 100) > 0.005;
