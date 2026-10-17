-- Performance: Zeitfenster-Abfragen auf security_prices (dbRecentDailyPrices in public/assets/db-data.js).
-- Bereits am 2026-10-17 in D1 "securities" angelegt; idempotent.
CREATE INDEX IF NOT EXISTS idx_security_prices_date ON security_prices (Price_date);
