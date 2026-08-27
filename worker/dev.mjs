// Starter `wrangler dev` med den lokale tilstand placeret UDEN FOR OneDrive.
//
// Hvorfor: repoet ligger i "OneDrive - WoodUpp/…". Wrangler lægger som standard
// sin lokale tilstand i <repo>/.wrangler/state, og når Durable Objects med
// SQLite-backend er i spil, betyder OneDrives filsynkronisering at workerd
// crasher nativt ved opstart:
//
//     *** std::terminate() called with no exception
//     The Workers runtime failed to start.
//
// Fejlen ser ud som en konfigurations- eller kodefejl, men er hverken — SQLite
// tåler ikke at få sine filer synkroniseret under sig. Løsningen er at flytte
// tilstanden til en lokal, usynkroniseret mappe.
//
// Scriptet udleder stien i stedet for at hardkode et brugernavn, så filen kan
// versionsstyres. Kør det via .claude/launch.json, ikke direkte.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// LOCALAPPDATA på Windows, ellers systemets temp-mappe. Begge ligger uden for
// enhver cloud-synkronisering.
const base = process.env.LOCALAPPDATA || tmpdir();
const stateDir = join(base, 'band-app-wrangler-state');
mkdirSync(stateDir, { recursive: true });

// ── Lokale udviklings-hemmeligheder ─────────────────────────────────────────
//
// ADVARSEL: disse værdier er OFFENTLIGE — de står i en versionsstyret fil og må
// ALDRIG bruges i produktion. De findes udelukkende for at `wrangler dev` kan
// køre rigtige login- og CPR-flows lokalt uden at nogen skal lægge produktions-
// hemmeligheder på disken.
//
// I produktion sættes de rigtige værdier med `wrangler secret put`, og dette
// script bruges ikke — det er kun til lokal udvikling.
//
// Værdierne er faste og ikke tilfældige, så sessioner og krypteret CPR overlever
// en genstart af dev-serveren. Var de tilfældige, ville hvert restart logge dig
// ud og gøre lokalt gemte CPR uafkrypterbare.
const LOKALE_DEV_HEMMELIGHEDER = {
  MASTER_SECRET: 'LOKAL-UDVIKLING-IKKE-EN-HEMMELIGHED-master-secret-0001',
  // 32 bytes base64 — CPR_KEY skal have præcis den længde.
  CPR_KEY: 'bG9rYWwtdWR2aWtsaW5nLWlra2UtZW4taGVtbWVsaWc=',
  BOOTSTRAP_TOKEN: 'LOKAL-UDVIKLING-bootstrap-0001'
};

const brugerArgs = process.argv.slice(2);

// Sæt kun de hemmeligheder kalderen ikke selv har angivet.
const auto = [];
for (const [navn, vaerdi] of Object.entries(LOKALE_DEV_HEMMELIGHEDER)) {
  if (!brugerArgs.some(a => a.startsWith(navn + ':'))) {
    auto.push('--var', navn + ':' + vaerdi);
  }
}

const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const args = ['dev', '--persist-to', stateDir, ...auto, ...brugerArgs];

console.log('[dev.mjs] lokal tilstand: ' + stateDir);
console.log('[dev.mjs] wrangler ' + args.join(' '));

const child = spawn(process.execPath, [wrangler, ...args], {
  cwd: here,
  stdio: 'inherit'
});
child.on('exit', code => process.exit(code ?? 0));
