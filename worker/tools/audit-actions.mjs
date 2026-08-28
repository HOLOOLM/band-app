// Sammenligner hvilke actions frontenden KALDER med hvad action-tabellen HAR.
//
//   node worker/tools/audit-actions.mjs
//
// Hvorfor dette findes: seks fejl slap gennem 440 selvtest-tjek OG en manuel
// gennemklikning, fordi begge kaldte actions med de navne implementeringen selv
// bruger. Frontenden bruger andre navne. `registerTenant` læste `bandId`, men
// frontenden sender `newBandId` — så operatøren kunne ikke oprette et band, og
// intet i testene kunne opdage det.
//
// Denne revision læser sandheden fra begge sider: frontendens faktiske
// kaldsteder, og tabellen. Den fanger to fejlklasser:
//   1. En action frontenden kalder, som ikke findes i tabellen
//   2. Et parameternavn frontenden sender, som action'en ikke læser nogen steder
//
// Punkt 2 giver falske positiver (et parameter kan læses via ctx frem for p), så
// de rapporteres som ADVARSLER til manuel vurdering, ikke som fejl.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(workerDir, '..');

// Ruter der håndteres uden for action-tabellen, i worker.js.
const UDEN_FOR_TABELLEN = new Set([
  'login', 'refreshSession', 'operatorLogin', 'bookerLogin', 'changePassword',
  'renderInvoicePdf', 'ical'
]);

// ── Side 1: hvad kalder frontenden? ────────────────────────────────────────
const frontend = new Map();   // action → Set(parameternavne)
const jsDir = join(repo, 'public', 'js');
for (const f of readdirSync(jsDir)) {
  if (!f.endsWith('.js')) continue;
  const s = readFileSync(join(jsDir, f), 'utf8');
  const moenstre = [
    /api(?:Get|Post)\(\s*'([a-zA-Z]+)'\s*(?:,\s*(\{[^}]*\}))?/g,
    /_apiCall\(\s*'([a-zA-Z]+)'\s*(?:,\s*(\{[^}]*\}))?/g
  ];
  for (const re of moenstre) {
    for (const m of s.matchAll(re)) {
      if (!frontend.has(m[1])) frontend.set(m[1], new Set());
      if (m[2]) {
        for (const k of m[2].matchAll(/([a-zA-Z]+)\s*:/g)) frontend.get(m[1]).add(k[1]);
      }
    }
  }
}

// ── Side 2: hvad har tabellen? ─────────────────────────────────────────────
const idxSrc = readFileSync(join(workerDir, 'src', 'actions', 'index.js'), 'utf8');
const tabel = new Map();      // action → funktionsnavn
for (const m of idxSrc.matchAll(/^\s{2}([a-zA-Z]+):\s*\{\s*scope:[^}]*fn:\s*([a-zA-Z]+)/gm)) {
  tabel.set(m[1], m[2]);
}

// Hele action-kildekoden i én streng, til parametersøgning.
const actionsDir = join(workerDir, 'src', 'actions');
let altKode = '';
for (const f of readdirSync(actionsDir)) {
  if (f.endsWith('.js')) altKode += readFileSync(join(actionsDir, f), 'utf8');
}

// ── Fejl 1: manglende actions ──────────────────────────────────────────────
const manglende = [...frontend.keys()]
  .filter(a => !tabel.has(a) && !UDEN_FOR_TABELLEN.has(a))
  .sort();

// ── Advarsel: parametre der ikke læses ─────────────────────────────────────
// Fælles parametre som routeren håndterer, eller som injiceres server-side.
const HAANDTERET_AF_ROUTER = new Set([
  'bandId', 'email', 'passwordHash', 'clientIp', 'userAgent', 'appOrigin', 't'
]);
const uLaeste = [];
for (const [action, params] of frontend) {
  if (!tabel.has(action)) continue;
  for (const p of params) {
    if (HAANDTERET_AF_ROUTER.has(p)) continue;
    // Læses parameteren nogen steder i action-koden? To former tæller:
    //   p.navn        direkte opslag
    //   'navn'        som element i en whitelist-løkke der gør p[k]
    // Uden det andet mønster ville hver løkkebaseret action give falsk alarm.
    const direkte = new RegExp('p\\.' + p + '\\b').test(altKode);
    const iWhitelist = new RegExp("'" + p + "'").test(altKode);
    if (!direkte && !iWhitelist) {
      uLaeste.push({ action, param: p });
    }
  }
}

// ── Rapport ────────────────────────────────────────────────────────────────
console.log('Frontenden kalder ' + frontend.size + ' actions. Tabellen har ' + tabel.size + '.\n');

let exitKode = 0;
if (manglende.length) {
  exitKode = 1;
  console.log('FEJL — actions frontenden kalder, som IKKE findes i tabellen:');
  for (const a of manglende) {
    console.log('  x ' + a + '   (frontenden sender: ' +
      ([...frontend.get(a)].join(', ') || 'ingen params') + ')');
  }
} else {
  console.log('OK — hver action frontenden kalder findes i tabellen.');
}

if (uLaeste.length) {
  console.log('\nADVARSEL — parametre frontenden sender, som ingen action læser via p.<navn>:');
  console.log('(kan være falske positiver: nogle læses via ctx eller under et alias)');
  for (const u of uLaeste) console.log('  ? ' + u.action + ' → ' + u.param);
} else {
  console.log('\nOK — hvert parameter frontenden sender læses et sted.');
}

process.exit(exitKode);
