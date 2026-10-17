// download-securityprices-csv.js  (runs locally on the Windows PC, called from the Access VBA button)
//
// Downloads the valuation CSV from the Cloudflare Worker and saves it where the Access linked table
// FIGIT_SecurityPrices_tbl_link expects it.
//
//   https://security.munot.app/api/securityprices.csv   (protected by Cloudflare Access)
//
// Access login for scripts = a Cloudflare Access SERVICE TOKEN (Zero Trust -> Access -> Service Auth).
// Put its two values next to this script in  access-token.json  (never commit that file):
//   { "clientId": "xxxx.access", "clientSecret": "xxxx" }
// or set the environment variables CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
//
// Usage:  node download-securityprices-csv.js
// Name is deliberately NOT download-csv.js (that one belongs to the accounting feed).

const fs = require('fs');
const path = require('path');

const URL_CSV = 'https://security.munot.app/api/securityprices.csv';
const OUT = 'C:\\Users\\phili\\OneDrive\\1_Finance\\Data Management\\securityprices.csv';

function credentials() {
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return { clientId: process.env.CF_ACCESS_CLIENT_ID, clientSecret: process.env.CF_ACCESS_CLIENT_SECRET };
  }
  const f = path.join(__dirname, 'access-token.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  throw new Error('No Access service token: create access-token.json next to this script or set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET');
}

(async () => {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(URL_CSV, {
    headers: { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret },
    redirect: 'manual', // a redirect means: Access did not accept the token (it would send us to the login page)
  });
  if (res.status !== 200) throw new Error(`Download failed: HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirect to Access login - check the service token and its policy)' : ''}`);
  const text = await res.text();
  if (!/^SecurityID,PriceDate,Price,Source/.test(text)) throw new Error('Unexpected content (not the valuation CSV)');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + '.tmp', text);
  fs.renameSync(OUT + '.tmp', OUT); // atomic: Access never sees a half-written file
  console.log(`OK ${text.trim().split('\n').length - 1} rows -> ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
