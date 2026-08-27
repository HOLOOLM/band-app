// Genererer src/lib/settings-defaults.js ud fra apps-script/Code.gs.
//
// Listerne SETTINGS_DEFAULTS, PUBLIC_CONFIG_KEYS og BILLING_CONFIG_KEYS er
// kontrakten mod frontenden. Så længe Apps Script stadig er den kørende backend,
// er Code.gs kilden, og en manuel afskrift ville uundgåeligt komme ud af sync —
// derfor genereres filen i stedet.
//
//   node worker/tools/gen-settings.mjs
//
// Når Apps Script er skrumpet til sidecar (Fase 4), forsvinder dette script, og
// settings-defaults.js bliver selv kilden.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(workerDir, '..');
const src = readFileSync(join(repo, 'apps-script', 'Code.gs'), 'utf8');

/** Klipper en balanceret {…}- eller […]-blok ud efter en erklæring. */
function grabBlock(declaration, open, close) {
  const i = src.indexOf(declaration);
  if (i < 0) throw new Error('ikke fundet i Code.gs: ' + declaration);
  const start = src.indexOf(open, i);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('ubalanceret blok: ' + declaration);
}

const defaults = eval('(' + grabBlock('const SETTINGS_DEFAULTS =', '{', '}') + ')');
const publicKeys = eval(grabBlock('const PUBLIC_CONFIG_KEYS =', '[', ']'));
const billingKeys = eval(grabBlock('const BILLING_CONFIG_KEYS =', '[', ']'));

// Konsistenstjek: en offentlig eller billing-nøgle uden default betyder at
// kontrakten er i stykker. Fang det her frem for i produktion.
const mangler = [...publicKeys, ...billingKeys].filter(k => !(k in defaults));
if (mangler.length) throw new Error('nøgler uden default: ' + mangler.join(', '));

// Nøgler der ALDRIG må slippe ud uden auth. Håndhæves også af selvtesten, men
// et brud skal stoppe genereringen med det samme.
const HEMMELIGE = ['seedPassword', 'invoiceFolderName', 'logoFileId', 'riderFileId',
                   'sceneplanFileId', 'sceneplanJson', 'riderText', 'bankName',
                   'bankReg', 'bankKto', 'payeeName', 'payeeAddress'];
const laekket = HEMMELIGE.filter(k => publicKeys.includes(k));
if (laekket.length) {
  throw new Error('HEMMELIGE nøgler står i PUBLIC_CONFIG_KEYS: ' + laekket.join(', '));
}

const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
const lit = v => typeof v === 'string' ? q(v) : JSON.stringify(v);

const out = `// Settings-kontrakten mod frontenden.
//
// GENERERET af worker/tools/gen-settings.mjs ud fra apps-script/Code.gs
// (SETTINGS_DEFAULTS, PUBLIC_CONFIG_KEYS, BILLING_CONFIG_KEYS).
// Ret ikke filen i hånden — kør scriptet igen:  node worker/tools/gen-settings.mjs

/** Alle Settings-nøgler med deres default. Ukendte nøgler afvises ved skrivning. */
export const SETTINGS_DEFAULTS = {
${Object.entries(defaults).map(([k, v]) => '  ' + k + ': ' + lit(v) + ',').join('\n')}
};

/**
 * Nøgler getConfig må returnere UDEN auth — login-skærmen kalder den, før nogen
 * er logget ind. seedPassword, invoiceFolderName, bankoplysninger og alle
 * *FileId er bevidst udeladt; selvtesten håndhæver det.
 */
export const PUBLIC_CONFIG_KEYS = [
${publicKeys.map(k => '  ' + q(k) + ',').join('\n')}
];

/** Nøgler der kræver admin-auth — bankoplysninger til fakturering. */
export const BILLING_CONFIG_KEYS = [
${billingKeys.map(k => '  ' + q(k) + ',').join('\n')}
];

/** Whitelist ved skrivning til settings. */
export const ALL_SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

/** Nøgler der aldrig må returneres uden auth. Selvtesten krydstjekker mod PUBLIC. */
export const NEVER_PUBLIC_KEYS = [
${HEMMELIGE.map(k => '  ' + q(k) + ',').join('\n')}
];
`;

writeFileSync(join(workerDir, 'src', 'lib', 'settings-defaults.js'), out);
console.log(`genereret: ${Object.keys(defaults).length} defaults, ` +
            `${publicKeys.length} offentlige, ${billingKeys.length} billing`);
