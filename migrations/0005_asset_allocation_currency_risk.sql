-- Currency Risk pro Allokationszeile (2026-10-23). Gepflegt über public/aa.html.
-- Währungscode (CHF, USD, ...) oder 'Others'. In Produktion bereits angewendet
-- (ALTER TABLE security_asset_allocation ADD COLUMN CurrencyRisk TEXT);
-- für frische Datenbanken nach 0003 ausführen. Nicht idempotent (SQLite kennt kein IF NOT EXISTS für Spalten).
ALTER TABLE security_asset_allocation ADD COLUMN CurrencyRisk TEXT;
