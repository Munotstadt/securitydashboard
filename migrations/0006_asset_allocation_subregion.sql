-- SubRegion pro Allokationszeile (2026-10-24), z.B. 'Eurozone', 'UK' unter Region 'Europe'. Freitext;
-- gepflegt über public/aa.html (Vorschläge aus den bereits erfassten Werten).
-- In Produktion (D1 "securities") existiert die Spalte bereits (ALTER TABLE security_asset_allocation ADD COLUMN SubRegion TEXT),
-- ebenso eine Spalte SubCategory TEXT (derzeit nur in der DB, noch ohne UI). Diese Datei dokumentiert SubRegion für frische
-- Datenbanken (nach 0003/0005 ausführen). Nicht idempotent (SQLite kennt kein IF NOT EXISTS für Spalten).
ALTER TABLE security_asset_allocation ADD COLUMN SubRegion TEXT;
