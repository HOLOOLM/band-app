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

const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const args = ['dev', '--persist-to', stateDir, ...process.argv.slice(2)];

console.log('[dev.mjs] lokal tilstand: ' + stateDir);
console.log('[dev.mjs] wrangler ' + args.join(' '));

const child = spawn(process.execPath, [wrangler, ...args], {
  cwd: here,
  stdio: 'inherit'
});
child.on('exit', code => process.exit(code ?? 0));
