-- 0009: security_data als Zeitreihe absichern (2026-11-22).
-- Hintergrund: security_data speichert pro Kennzahl und Stichtag (AsOfDate) eine eigene Zeile; die Historie
-- (P/E, P/B, Total Net Assets, Spread, Std. Dev. 3y, ...) zeigt assets/data-history.js. Dafür muss AsOfDate
-- einheitlich ISO sein (Sortierung per Textvergleich) und es darf pro Kennzahl/Tag/Quelle nur einen Wert geben.
-- Ausführen in D1 "securities" (Konsole oder `wrangler d1 execute securities --remote --file=...`).
-- Ausgeführt am 2026-11-22 in D1 "securities": 314 Datumswerte auf ISO, 1 Duplikat gelöscht, 1 Zeile auf TradingSpread
-- umgehängt, Index angelegt. Kontrolle danach: 0 Nicht-ISO, 0 Duplikate.

-- Vorher-Check (erwartet: 314 Nicht-ISO-Zeilen, 2 Duplikat-Gruppen):
--   SELECT COUNT(*) FROM security_data WHERE AsOfDate NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*';
--   SELECT SecurityID, FieldNameID, AsOfDate, Source, COUNT(*), GROUP_CONCAT(id) FROM security_data
--    WHERE FieldNameID IS NOT NULL GROUP BY SecurityID, FieldNameID, AsOfDate, COALESCE(Source,'') HAVING COUNT(*) > 1;

-- ---- 1. AsOfDate auf ISO yyyy-mm-dd ------------------------------------------------------------------
-- Betrifft die alten "UBS Quotes"-Matching-Zeilen (FieldNameID 143, Format "dd.mm.yyyy hh:mm:ss",
-- admin.html schreibt heute schon ISO) und eine FundOperations-Zeile ("14.08.2026").
-- Nur das Datum wird übernommen; die Uhrzeit hatte bei diesen Zeilen keine Bedeutung.
UPDATE security_data
SET AsOfDate = substr(AsOfDate, 7, 4) || '-' || substr(AsOfDate, 4, 2) || '-' || substr(AsOfDate, 1, 2)
WHERE AsOfDate GLOB '[0-3][0-9].[01][0-9].[12][0-9][0-9][0-9]*';

-- ---- 2. Duplikate pro Kennzahl/Tag/Quelle bereinigen ---------------------------------------------------
-- 2a) SecurityID 3614439, TradingCurrency 2026-08-21: zwei identische Zeilen ("DE EUR") -> jüngere löschen.
DELETE FROM security_data WHERE id = 11338
  AND EXISTS (SELECT 1 FROM security_data WHERE id = 11337 AND FieldValue = 'DE EUR');
-- 2b) SecurityID 35987944, 2026-11-20: 0.11 % wurde als TradingCurrency (134) erfasst, gemeint war
--     TradingSpread (135; Wert numerisch mit Einheit %). -> auf TradingSpread umhängen.
UPDATE security_data SET FieldNameID = 135, FieldName = 'TradingSpread'
WHERE id = 61889 AND FieldNameID = 134 AND NumericValue = 0.11 AND Unit = '%'
  AND NOT EXISTS (SELECT 1 FROM security_data WHERE SecurityID = 35987944 AND FieldNameID = 135 AND AsOfDate = '2026-11-20');

-- ---- 3. Unique-Index: ein Wert pro Security + Kennzahl + Stichtag + Quelle -------------------------
-- Gilt für Parameter-Zeilen (FieldNameID gesetzt); Holdings (FieldNameID NULL) bleiben aussen vor.
-- Bewusst OHNE Source 'yfinance': der Fund-Data-Collector liegt nicht in diesem Repo und es ist nicht
-- geprüft, ob er bei einem zweiten Lauf am selben Tag ein INSERT OR REPLACE / Upsert macht. Mit Index würde
-- ein solcher Lauf sonst fehlschlagen. Sobald das geklärt ist, kann die WHERE-Bedingung entfallen.
-- security_data.html prüft dieselbe Regel vor dem Speichern (findSameDayRow) und bietet Überschreiben an.
CREATE UNIQUE INDEX IF NOT EXISTS ux_security_data_metric_date_source
  ON security_data (SecurityID, FieldNameID, AsOfDate, COALESCE(Source, ''))
  WHERE FieldNameID IS NOT NULL AND COALESCE(Source, '') <> 'yfinance';

-- Kontrolle danach (beide 0):
--   SELECT COUNT(*) FROM security_data WHERE AsOfDate NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*';
--   SELECT COUNT(*) FROM (SELECT 1 FROM security_data WHERE FieldNameID IS NOT NULL
--     GROUP BY SecurityID, FieldNameID, AsOfDate, COALESCE(Source,'') HAVING COUNT(*) > 1);
