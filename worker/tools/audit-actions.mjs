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
const tabel = new Map();      // action → { fn, auth, operatorOk }
for (const m of idxSrc.matchAll(/^\s{2}([a-zA-Z]+):\s*\{([^}]*)fn:\s*([a-zA-Z]+)/gm)) {
  const krop = m[2];
  const auth = (krop.match(/auth:\s*'([a-z|]+)'/) || [])[1] || '';
  const scope = (krop.match(/scope:\s*'([a-z]+)'/) || [])[1] || '';
  tabel.set(m[1], { fn: m[3], auth, scope, operatorOk: /operatorOk:\s*true/.test(krop) });
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


// ── Fejl 2: operatør-panelet kalder noget en operatør ikke må ──────────────
// Operatøren er ikke medlem af noget band og har derfor ingen medlems-session.
// Kalder panelet en action der er gated som band-admin, får brugeren
// "Ikke logget ind" på sin egen knap — og intet i selvtesten opdager det,
// fordi testene kalder actions med en medlems-session.
//
// Det skete for adminReadConfig, adminWriteConfig og adminUploadAsset: alle tre
// var gated 'admin', så Rediger-knappen i operatør-panelet var død fra dag ét.
const opSrc = readFileSync(join(jsDir, '09-boot.js'), 'utf8');
const opKald = new Set();
for (const re of [/_apiCall\(\s*'([a-zA-Z]+)'/g, /api(?:Get|Post)\(\s*'([a-zA-Z]+)'/g]) {
  for (const m of opSrc.matchAll(re)) opKald.add(m[1]);
}
const OPERATOER_OK = new Set(['public', 'operator']);
const ikkeOperatoerbare = [...opKald]
  .filter(a => tabel.has(a))
  .filter(a => {
    const d = tabel.get(a);
    return !OPERATOER_OK.has(d.auth) && !d.operatorOk;
  })
  .sort();

// ── Fejl 3: master-actions der ikke læser det bandnavn de får ─────────────
// `bandId` stod på HAANDTERET_AF_ROUTER-listen, fordi routeren bruger den til at
// adressere bandets Durable Object. Det er rigtigt for scope 'band' — men for
// scope 'master' er der intet band-objekt, og `bandId` er almindelig nyttelast
// som action'en SELV skal læse.
//
// Undtagelsen skjulte derfor præcis den fejl den skulle fange: bandHealth og
// backupBand læste kun `targetBandId`, mens operatør-panelet sender `bandId`.
// Bandlisten svarede "Kunne ikke hente status" for hvert band, og revisionen
// meldte alt rent.
//
// _apiCall injicerer altid bandId, så kun kaldsteder der SKRIVER navnet
// eksplicit tælles — det er dem hvor kalderen mener noget med det.
const manglerBandLaesning = [];
for (const [action, params] of frontend) {
  const d = tabel.get(action);
  if (!d || d.scope !== 'master') continue;
  if (!params.has('bandId')) continue;
  const fnKrop = (altKode.match(new RegExp('function ' + d.fn +
    '[^]{0,600}')) || [''])[0];
  if (!/p\.bandId/.test(fnKrop)) manglerBandLaesning.push({ action, fn: d.fn });
}

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

if (ikkeOperatoerbare.length) {
  exitKode = 1;
  console.log('\nFEJL — operatør-panelet (09-boot.js) kalder actions en operatør ikke kan udføre:');
  for (const a of ikkeOperatoerbare) {
    console.log('  x ' + a + '   (auth: ' + tabel.get(a).auth +
      ') — tilføj operatorOk: true, eller lad panelet være med at kalde den');
  }
} else {
  console.log('OK — hver action operatør-panelet kalder kan udføres af en operatør.');
}

if (manglerBandLaesning.length) {
  exitKode = 1;
  console.log('\nFEJL — master-actions der får bandId, men aldrig læser det:');
  for (const m of manglerBandLaesning) {
    console.log('  x ' + m.action + ' (' + m.fn +
      ') — læs p.bandId, ikke kun p.targetBandId');
  }
} else {
  console.log('OK — hver master-action læser det bandnavn frontenden sender.');
}

if (uLaeste.length) {
  console.log('\nADVARSEL — parametre frontenden sender, som ingen action læser via p.<navn>:');
  console.log('(kan være falske positiver: nogle læses via ctx eller under et alias)');
  for (const u of uLaeste) console.log('  ? ' + u.action + ' → ' + u.param);
} else {
  console.log('\nOK — hvert parameter frontenden sender læses et sted.');
}

process.exit(exitKode);
