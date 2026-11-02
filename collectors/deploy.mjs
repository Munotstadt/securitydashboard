// Deployt alle Yahoo-Collector-Worker nacheinander (läuft unter Windows, macOS, Linux).
//   npm run deploy:collectors              -> alle
//   npm run deploy:collectors -- yahoo-2135 -> nur dieses Environment
//   npm run deploy:collectors -- --dry-run -> nur bauen/prüfen, nichts hochladen
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// wrangler direkt über node starten (ohne Shell): robust bei Leerzeichen im Pfad, auch unter Windows.
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const config = fileURLToPath(new URL('./yahoo/wrangler.jsonc', import.meta.url));
const allEnvs = [...readFileSync(config, 'utf8').matchAll(/^\s{4}"(yahoo-[\w-]+)": \{/gm)].map((m) => m[1]);

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const picked = args.filter((a) => !a.startsWith('--'));
const unknown = picked.filter((e) => !allEnvs.includes(e));
if (unknown.length) {
  console.error(`Unbekannt: ${unknown.join(', ')}. Verfügbar: ${allEnvs.join(', ')}`);
  process.exit(1);
}

const failed = [];
for (const env of picked.length ? picked : allEnvs) {
  console.log(`\n=== ${env} ===`);
  const r = spawnSync(process.execPath, [wrangler, 'deploy', '-c', config, '--env', env, ...flags], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(env);
}
if (failed.length) {
  console.error(`\nFehlgeschlagen: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(flags.includes('--dry-run') ? '\nDry-Run ok, nichts hochgeladen.' : '\nAlle Collector-Worker deployt.');
