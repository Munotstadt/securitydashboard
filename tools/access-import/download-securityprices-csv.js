// download-securityprices-csv.js
// ---------------------------------------------------------------------------------------------
// Laedt die Kurse aus der Cloudflare-D1-Datenbank "securities" (ueber die API des Dashboards) als CSV
// und legt sie dort ab, wo die verknuepfte Access-Tabelle FIGIT_SecurityPrices_tbl_link sie erwartet.
//
// Ordner auf dem PC:  C:\MunotstadtTools\AccessERP\
//   download-securityprices-csv.js   dieses Skript
//   secrets.json                     Zugangsdaten (Service Token) - NIE ins Git, NIE weitergeben
//   download.log                     Protokoll aller Laeufe (wird vom Skript geschrieben)
//
// Frage beim Start (wie VBA/Access sie stellt, oder hier in der Konsole, wenn ohne Parameter gestartet):
//   1) Aktuellste Kurse        -> je Wertschrift der juengste Kurs in D1
//   2) Schlusskurse per Stichtag (z.B. 15.10.2026)
//                              -> je Wertschrift der letzte Kurs bis und mit Stichtag
//
// Aufruf:
//   node download-securityprices-csv.js                              (fragt interaktiv)
//   node download-securityprices-csv.js --mode=latest
//   node download-securityprices-csv.js --mode=close --asof=15.10.2026   (auch --asof=2026-10-15)
//
// Exit-Codes (VBA wertet sie aus):  0 = OK,  1 = Fehler (Details in download.log),  2 = Abbruch / ungueltige Eingabe
// ---------------------------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Konfiguration ---------------------------------------------------------------------------
const API_URL = process.env.SECURITYPRICES_API_URL || 'https://security.munot.app/api/securityprices.csv';   // Env nur fuer Tests
// Zielpfad der CSV. NICHT aendern, solange die Access-Verknuepfung darauf zeigt (sonst Verknuepfung neu erstellen).
const OUT_PATH = process.env.SECURITYPRICES_OUT || 'C:\\Users\\phili\\OneDrive\\1_Finance\\Data Management\\securityprices.csv';   // Env nur fuer Tests
const SECRETS_FILE = path.join(__dirname, 'secrets.json');   // { "clientId": "...", "clientSecret": "..." }
const LOG_FILE = path.join(__dirname, 'download.log');
const TIMEOUT_MS = 60000;

// --- Hilfsfunktionen -------------------------------------------------------------------------
class UserError extends Error {}   // Eingabe-/Abbruchfehler -> Exit-Code 2

function log(msg) {
  const line = `${new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}  ${msg}`;
  console.log(msg);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 500000) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* Logfehler duerfen den Download nicht verhindern */ }
}

function loadSecrets() {
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return { clientId: process.env.CF_ACCESS_CLIENT_ID, clientSecret: process.env.CF_ACCESS_CLIENT_SECRET };
  }
  if (!fs.existsSync(SECRETS_FILE)) throw new Error(`Zugangsdaten fehlen: ${SECRETS_FILE} nicht gefunden (Vorlage: secrets.example.json)`);
  let s;
  try { s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error(`secrets.json ist kein gueltiges JSON: ${e.message}`); }
  if (!s.clientId || !s.clientSecret) throw new Error('secrets.json braucht die Felder "clientId" und "clientSecret"');
  return s;
}

// Akzeptiert DD.MM.YYYY oder YYYY-MM-DD; liefert { iso, display } oder null.
function parseDate(v) {
  let x, y, m, d;
  v = String(v || '').trim();
  if ((x = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else if ((x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  return { iso: `${y}-${p2(m)}-${p2(d)}`, display: `${p2(d)}.${p2(m)}.${y}` };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--(mode|asof)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else throw new UserError(`Unbekannter Parameter: ${a}  (erlaubt: --mode=latest|close, --asof=DD.MM.YYYY)`);
  }
  return out;
}

function ask(rl, q) { return new Promise((resolve) => rl.question(q, resolve)); }

async function askInteractively() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Welche Kurse sollen geladen werden?');
    console.log('  1 = Aktuellste Kurse');
    console.log('  2 = Schlusskurse per Stichtag');
    const a = (await ask(rl, 'Auswahl [1/2, leer = Abbruch]: ')).trim();
    if (a === '1') return { mode: 'latest' };
    if (a === '2') {
      const today = parseDate(new Date().toISOString().slice(0, 10)).display;
      const d = (await ask(rl, `Stichtag (DD.MM.YYYY, z.B. ${today}): `)).trim();
      return { mode: 'close', asof: d };
    }
    throw new UserError('Abgebrochen.');
  } finally { rl.close(); }
}

// --- Hauptablauf -----------------------------------------------------------------------------
async function main() {
  let opts = parseArgs(process.argv.slice(2));
  if (!opts.mode) {
    if (!process.stdin.isTTY) throw new UserError('Kein --mode angegeben (latest oder close) und keine Konsole fuer die Rueckfrage.');
    opts = await askInteractively();
  }
  const mode = String(opts.mode).toLowerCase();
  if (mode !== 'latest' && mode !== 'close') throw new UserError(`Ungueltiger Modus "${opts.mode}" (latest oder close)`);

  let url = `${API_URL}?mode=${mode}`;
  let label = 'aktuellste Kurse';
  if (mode === 'close') {
    const d = parseDate(opts.asof);
    if (!d) throw new UserError(`Ungueltiger Stichtag "${opts.asof || ''}" - erwartet DD.MM.YYYY, z.B. 15.10.2026`);
    if (d.iso > new Date().toISOString().slice(0, 10)) throw new UserError(`Der Stichtag ${d.display} liegt in der Zukunft.`);
    url += `&asof=${d.iso}`;
    label = `Schlusskurse per ${d.display}`;
  }

  const { clientId, clientSecret } = loadSecrets();
  log(`Start: ${label}`);

  const res = await fetch(url, {
    headers: { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret },
    redirect: 'manual',   // Weiterleitung = Access hat den Token nicht akzeptiert (Login-Seite)
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) {
    const redirect = res.status >= 300 && res.status < 400;
    throw new Error(`Download fehlgeschlagen: HTTP ${res.status}` +
      (redirect ? ' (Weiterleitung zum Access-Login: Service Token oder Service-Auth-Policy pruefen)' :
        res.status === 400 ? ` (${(await res.text()).slice(0, 200)})` : ''));
  }
  const text = await res.text();
  if (!/^SecurityID,PriceDate,Price,Source/.test(text)) throw new Error('Unerwarteter Inhalt (keine Kurs-CSV)');
  const rows = text.trim().split('\n').length - 1;
  if (rows < 1) throw new Error(`Keine Kurse fuer: ${label}. Die bestehende CSV wurde nicht ueberschrieben.`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH + '.tmp', text);
  fs.renameSync(OUT_PATH + '.tmp', OUT_PATH);   // atomar: Access sieht nie eine halbe Datei
  log(`OK: ${label}, ${rows} Zeilen -> ${OUT_PATH}`);
}

main().catch((e) => {
  const user = e instanceof UserError;
  log(`${user ? 'ABBRUCH' : 'FEHLER'}: ${e.message}`);
  // process.exitCode statt process.exit(): sauberes Beenden, sonst bricht Node unter Windows nach der
  // Konsolenabfrage mit "Assertion failed ... UV_HANDLE_CLOSING" ab.
  process.exitCode = user ? 2 : 1;
});
