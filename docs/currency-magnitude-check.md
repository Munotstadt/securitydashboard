# Kurssprung-/Währungskonventions-Check beim Preis-Import

**Status:** implementiert, noch nicht ins GitHub-Repo gepusht (liegt als lokaler Diff vor, siehe Chat vom 2026-08-19).
**Datei:** `admin.html` (Sektionen "Upload Prices (CSV/Excel)" und "UBS Quotes Import")

## Problem

Manuelle CSV/Excel-Preisuploads und der UBS-Quotes-Import landen beide unverändert in `security_prices.Price`. Manche Quellen/Konventionen notieren bestimmte Währungen (JPY, KRW, IDR, HUF, VND, ISK, CLP …) "je 100 Einheiten" statt "je 1 Einheit" — ein 100x-Fehler, der unbemerkt importiert wird, verfälscht Portfoliobewertungen massiv.

## Gewählter Ansatz

Kein Whitelist-Ansatz pro Quelle (zu fragil/pflegeintensiv, und admin.html kennt die exakte Quellkonvention nicht zuverlässig). Stattdessen: **Plausibilitätscheck gegen den letzten gespeicherten Kurs derselben Security** (kein externer Anker wie Yahoo nötig — diese Dashboard-Codebase hat keine Yahoo-Anbindung).

- `checkMagnitude(secId, price, currency)`: vergleicht den neuen Preis mit dem letzten `security_prices`-Eintrag derselben SecurityID. Ratio zwischen 40x–250x (bzw. 1/250–1/40) wird als "~100x-Sprung" geflaggt — echte Tagesbewegungen in diesem Wertebereich kommen für die getrackten Assets praktisch nie vor.
- `LOW_VALUE_CCY`-Set (JPY, KRW, IDR, HUF, VND, ISK, CLP) liefert nur einen **Hinweistext** ("Währung wird oft je 100 notiert"), ist aber nie Voraussetzung fürs Flaggen — greift so auch bei Dezimal-/Tippfehlern in jeder beliebigen Währung.
- Kein automatisches Korrigieren. Betroffene Zeilen werden in der Vorschau-Tabelle (Preis-CSV-Upload und UBS-Import) als "⚠ warn" markiert, blockieren den Import bis der Nutzer entweder auf den Korrektur-Vorschlag (÷100/×100-Button) klickt oder explizit "✓ so übernehmen" bestätigt.
- Ohne Preishistorie (neue Security) wird nichts geflaggt — der Check greift erst ab dem zweiten Preis-Datenpunkt.

## Betroffene Funktionen in admin.html

- `LOW_VALUE_CCY`, `ensureLastPrices()`, `checkMagnitude()`, `magnitudeLabel()` — geteilte Helper (direkt nach `resolveSecurity()`).
- `handlePriceFile()` / neue `renderPriceUploadPreview()` — CSV/Excel-Preis-Upload.
- `handleUbsFile()`, `markUbsMagnitudeWarnings()`, `ubsRowStatus()`, `UBS_STATUS_ORDER`, `renderUbsPreview()` — UBS-Import.
- `importPrices()` / `importUbsQuotes()` — Import-Filter schliessen unbestätigte Warnungen aus.

## Offene Punkte / mögliche Erweiterung

- `price_editor.html` (manuelle Einzelzeilen-Bearbeitung) hat den Check bewusst nicht bekommen — Scope war explizit "Import" (CSV + UBS).
- Falls künftig eine zuverlässige Quelle-→-Konvention-Zuordnung bekannt ist, könnte zusätzlich ein Whitelist-Ansatz (Ansatz A aus der ursprünglichen Diskussion) ergänzt werden, um den Vorschlag noch treffsicherer vorzuschlagen.
