-- 0008: security_distributions.DistributionType (Text) -> distribution_type (ParameterID, FK auf security_parameter)
-- Stufe 1 (am 2026-10-25 direkt in D1 "securities" ausgeführt, additiv, rückwärtskompatibel):
INSERT INTO security_parameter (ParameterName, ParaTable, ParaField) VALUES
  ('Dividends',              'security_distributions', 'distribution_type'),   -- ParameterID 167
  ('Capital',                'security_distributions', 'distribution_type'),   -- 168
  ('Swiss Tax Income (CHF)', 'security_distributions', 'distribution_type');   -- 169

ALTER TABLE security_distributions ADD COLUMN distribution_type INTEGER REFERENCES security_parameter(ParameterID);

UPDATE security_distributions SET distribution_type = (
  SELECT ParameterID FROM security_parameter
  WHERE ParaTable='security_distributions' AND ParaField='distribution_type'
    AND ParameterName = CASE DistributionType WHEN 'Dividend' THEN 'Dividends' WHEN 'Capital' THEN 'Capital' END)
WHERE DistributionType IN ('Dividend','Capital');
-- Zeilen ohne Typ (NULL) bleiben NULL und zählen weiterhin als Dividende/Return-relevant.

-- Stufe 2 (erst NACH dem Deploy von distribution_editor.html + security.html ausführen):
-- Backfill nochmals laufen lassen (falls der alte Editor zwischenzeitlich noch Text geschrieben hat), dann alte Spalte entfernen:
--   UPDATE security_distributions SET distribution_type = (SELECT ParameterID FROM security_parameter WHERE ParaTable='security_distributions' AND ParaField='distribution_type' AND ParameterName = CASE DistributionType WHEN 'Dividend' THEN 'Dividends' WHEN 'Capital' THEN 'Capital' END) WHERE DistributionType IN ('Dividend','Capital') AND distribution_type IS NULL;
--   ALTER TABLE security_distributions DROP COLUMN DistributionType;
