-- Asset Allocation pro Security (2026-10-23). Verwaltet über public/aa.html.
-- Mehrere Zeilen pro SecurityID; die Weights (in %) einer Security müssen sich zu 100 summieren.
-- Das erzwingt aa.html beim Speichern (UI-Prüfung + atomarer Guard im selben Batch);
-- die View security_asset_allocation_check listet Abweichungen (z.B. nach manuellen Eingriffen).
-- Idempotent.

CREATE TABLE IF NOT EXISTS security_asset_allocation (
  AllocationID    INTEGER PRIMARY KEY AUTOINCREMENT,
  SecurityID      INTEGER NOT NULL REFERENCES security_master(SecurityID),
  AssetClass      TEXT NOT NULL CHECK (AssetClass IN ('Share','Bonds','Alternative')),
  Region          TEXT NOT NULL CHECK (Region IN ('Switzerland','USA','Europe','AsiaPacific','World')),
  Country         TEXT,
  -- SecurityID (als Text) einer Security aus security_master ODER freie manuelle Eingabe
  SubSecurity     TEXT,
  Sector          TEXT NOT NULL DEFAULT '_not defined' CHECK (Sector IN (
                    'Basic materials','Communication','Consumer discretionary','Consumer staples','Energy',
                    'Financials','Health Care','Industrials','Real Estate','Technology','Telecommunication',
                    'Utilities','_not defined')),
  Weight          REAL NOT NULL CHECK (Weight > 0 AND Weight <= 100),
  modified_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  created_at_utc  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS idx_security_asset_allocation_security ON security_asset_allocation (SecurityID);

-- Securities, deren Weights nicht 100 ergeben (Toleranz 0.005 wegen 2-Dezimalstellen-Eingabe).
CREATE VIEW IF NOT EXISTS security_asset_allocation_check AS
  SELECT SecurityID, COUNT(*) AS Rows, ROUND(SUM(Weight), 4) AS WeightSum, ROUND(SUM(Weight) - 100, 4) AS Deviation
    FROM security_asset_allocation
   GROUP BY SecurityID
  HAVING ABS(SUM(Weight) - 100) > 0.005;
