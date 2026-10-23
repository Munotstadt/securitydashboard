-- security_master.Sector (2026-10-23): FK auf security_parameter (ParaTable 'security_master', ParaField 'Sector').
-- Bereits am 2026-10-23 in D1 "securities" ausgeführt (Parameter-IDs 154-166). Dokumentation / Nachvollziehbarkeit.
-- Achtung: ALTER TABLE ... ADD COLUMN ist nicht idempotent - nicht erneut ausführen.

INSERT INTO security_parameter (ParameterName, ParaTable, ParaField) VALUES
  ('Basic materials','security_master','Sector'), ('Communication','security_master','Sector'),
  ('Consumer discretionary','security_master','Sector'), ('Consumer staples','security_master','Sector'),
  ('Energy','security_master','Sector'), ('Financials','security_master','Sector'), ('Health Care','security_master','Sector'),
  ('Industrials','security_master','Sector'), ('Real Estate','security_master','Sector'), ('Technology','security_master','Sector'),
  ('Telecommunication','security_master','Sector'), ('Utilities','security_master','Sector'), ('_not defined','security_master','Sector');

ALTER TABLE security_master ADD COLUMN Sector INTEGER REFERENCES security_parameter(ParameterID);
