-- Einmalige Datenkorrektur: Pence-Preise (GBp) von Yahoo in GBP umrechnen.
-- Stand 2026-11-02: 127 Zeilen bei British Land (BLND.L, 374930) und iShares UK
-- Property (IUKP.L, 3007836), Werte ~380-470 statt ~3.8-4.7 GBP.
-- Die Bedingung "Price > 50" macht das Update idempotent: die echten GBP-Kurse dieser
-- beiden Titel lagen seit 2015 nie über 8, und ein zweiter Lauf ändert nichts mehr.
-- VOR dem Deploy des neuen Yahoo-Collectors ausführen, sonst blockiert dessen
-- Sprung-Check (Median der letzten 5 Pence-Preise vs. neuer GBP-Preis) die Titel.
--
--   npx wrangler d1 execute securities --remote --file collectors/fix-gbp-pence-prices.sql

-- Kontrolle vorher (erwartet: 127)
SELECT COUNT(*) AS rows_to_fix FROM security_prices
WHERE SecurityID IN (374930, 3007836) AND Price > 50;

UPDATE security_prices
SET Price          = Price / 100.0,
    Price_adjusted = CASE WHEN Price_adjusted > 50 THEN Price_adjusted / 100.0 ELSE Price_adjusted END,
    modified_at    = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE SecurityID IN (374930, 3007836) AND Price > 50;

-- iShares Core FTSE 100 (CUKX.L, 10737489): einzelner Ausreisser 22120 am
-- 2026-11-02 10:15:23 (GBp statt GBP). Löschen; der Collector holt den nächsten Kurs.
DELETE FROM security_prices
WHERE SecurityID = 10737489 AND Price > 10000
  AND source = 'Collector_Worker_YahooWeekday_0600-2000_UTC';
