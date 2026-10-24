# Asset Allocation – Regeln (Stand 2026-10-24)

Tabelle `security_asset_allocation` (Migration 0007), Pflege über `aa.html`. Weights je SecurityID = 100 %.

| AssetClass  | Region (Pflicht)                                              | SubRegion        | Subclass (`SubCategory`)                                                      |
|-------------|---------------------------------------------------------------|------------------|--------------------------------------------------------------------------------|
| Share       | Switzerland, USA, Europe, Asia Pacific, Emerging Markets      | nur bei Europe: UK, Eurozone, Nordics | – (NULL)                                           |
| Bonds       | Switzerland, USA, Europe                                      | nur bei Europe: UK, Eurozone, Nordics | – (NULL)                                           |
| Alternative | optional-Wert aus: Switzerland, USA, Europe, Asia Pacific, Emerging Markets, World | nur bei Europe | **Pflicht**: Real Estate, Commodities & Metals, Real Assets, Crypto Currencies, FX Hedges |

- Nordics = Sweden, Norway, Denmark. Canada bleibt unter USA. Country ist Freitext (Vorschläge je Region).
- Wert-Mapping gegenüber früher (für ERP-Auswertung / Import-Skripte): `AsiaPacific` → `Asia Pacific`; Share/`World` → `Emerging Markets`; neue SubRegion `Nordics`; `SubCategory` = Subclass.
- Backup der alten Tabelle: `security_asset_allocation_bak_20261024` (später löschen).
