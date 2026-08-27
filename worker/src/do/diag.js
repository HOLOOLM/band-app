// Produktionsdiagnostik. Besvarer de to spørgsmål der IKKE kan afgøres lokalt:
//
//   1. Virker jurisdiction('eu')? Miniflare understøtter det ikke. Jurisdiktionen
//      er en del af objektets identitet og kan ikke ændres bagefter uden at alle
//      bands mister data — så den skal bekræftes FØR der lægges rigtige data ind.
//   2. Hvad koster PBKDF2 på Cloudflares CPU? Lokale tal er vægur-tid på en
//      udviklermaskine og svingede med en faktor 2. Svaret afgør om
//      PW_ITERATIONS kan hæves uden at skifte til Paid.
//
// MIDLERTIDIG. Når Fase 3j giver operatør-login, flyttes disse tjek til
// `bandHealth`, som er ordentligt auth-gated, og denne fil slettes.
//
// Adgang kræver en DIAG_TOKEN-hemmelighed i en header — ikke en query-parameter,
// så tokenet ikke havner i logs eller browserhistorik. Svaret indeholder
// udelukkende tidsmålinger og booleans; ingen banddata, ingen hemmeligheder.

import { pbkdf2, constTimeEq, pwIterations } from '../lib/crypto.js';
import { jurisdictionActive, bandStub } from '../lib/addressing.js';

const STEPS = [5000, 10000, 50000, 200000];
const REPEATS = 5;

export function diagAuthorized(request, env) {
  // trim() på begge sider. Et token der kopieres fra en terminal får nemt et
  // usynligt linjeskift eller mellemrum med, og dette projekt har historie med
  // netop den fejl (se cloudflare-worker-deploy-gotchas: en pipet hemmelighed i
  // PowerShell blev 65 tegn i stedet for 64 og blev afvist uden forklaring).
  // Whitespace omkring et token bærer ingen betydning, så det er robusthed —
  // ikke en svækkelse af sammenligningen, der stadig er konstant-tid.
  const forventet = String(env.DIAG_TOKEN || '').trim();
  if (!forventet) return false;                       // ikke sat = endpointet findes ikke
  const givet = String(request.headers.get('X-Diag-Token') || '').trim();
  if (!givet) return false;
  const ok = constTimeEq(givet, forventet);
  if (!ok) {
    // Svaret er altid 404, så et afslag afslører intet udefra. Men uden nogen
    // form for spor er et forkert token umuligt at fejlsøge: man kan ikke se om
    // det er en tastefejl, en pladsholder eller whitespace. Længderne logges
    // derfor til `wrangler tail`, som kun kontoejeren kan læse. Selve værdierne
    // logges ALDRIG.
    console.warn('_diag afvist: header ' + givet.length +
                 ' tegn, forventet ' + forventet.length + ' tegn');
  }
  return ok;
}

/**
 * De BILLIGE tjek: hemmeligheders tilstedeværelse, CPR_KEY-længde,
 * EU-jurisdiktion og at DO-lageret virker. Ingen CPU-tung hashing.
 *
 * Disse logges til `wrangler tail` ved ETHVERT kald til /api/_diag, også et
 * uautoriseret — tail-streamen kan kun læses af kontoejeren, og svaret udefra
 * er fortsat 404. Det gør det muligt at få det kritiske svar (virker
 * jurisdiktionen?) uden at skulle håndtere et token i en terminal, hvilket har
 * vist sig at være den største kilde til fejl i opsætningen.
 *
 * KDF-målingen er bevidst IKKE med her: den er dyr, og et offentligt endpoint
 * der kan trigge 200.000 PBKDF2-iterationer ville være en oplagt måde at brænde
 * CPU-budgettet. Den kræver derfor fortsat gyldigt token.
 */
export async function diagBillig(env) {
  let lagerOk = false;
  let skemaVersion = null;
  try {
    const stub = bandStub(env, '__diag__');
    const st = await stub.status();
    skemaVersion = st.schemaVersion;
    await stub.putSettings({ bandName: 'diag' }, ['bandName']);
    const s = await stub.getSettings();
    lagerOk = s.bandName === 'diag';
  } catch (e) {
    lagerOk = 'fejl: ' + String(e && e.message || e);
  }

  return {
    hemmeligheder: {
      MASTER_SECRET: !!env.MASTER_SECRET,
      CPR_KEY: !!env.CPR_KEY,
      DIAG_TOKEN: !!env.DIAG_TOKEN,
      SIDECAR_TOKEN: !!env.SIDECAR_TOKEN,
      RESEND_API_KEY: !!env.RESEND_API_KEY
    },
    cprKeyGyldig: cprKeyGyldig(env),
    euJurisdiktion: jurisdictionActive(env),
    doLagerVirker: lagerOk,
    doSkemaVersion: skemaVersion,
    pwIterations: pwIterations(env)
  };
}

export async function diag(env) {
  const maalinger = [];
  const clientHash = 'a'.repeat(64);
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';

  for (const iterations of STEPS) {
    const t = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = Date.now();
      await pbkdf2(clientHash, salt, iterations);
      t.push(Date.now() - t0);
    }
    t.sort((a, b) => a - b);
    maalinger.push({
      iterationer: iterations,
      medianMs: t[Math.floor(t.length / 2)],
      minMs: t[0],
      maxMs: t[t.length - 1]
    });
  }

  // Skriv og læs i et engangsobjekt, så vi ved at DO-lageret virker i
  // produktion — ikke kun at bindingen findes.
  let lagerOk = false;
  let skemaVersion = null;
  try {
    const stub = bandStub(env, '__diag__');
    const st = await stub.status();
    skemaVersion = st.schemaVersion;
    await stub.putSettings({ bandName: 'diag' }, ['bandName']);
    const s = await stub.getSettings();
    lagerOk = s.bandName === 'diag';
  } catch (e) {
    lagerOk = 'fejl: ' + String(e && e.message || e);
  }

  const valgt = maalinger.find(m => m.iterationer === pwIterations(env));

  return {
    ok: true,
    // Kun TILSTEDEVÆRELSE, aldrig værdien. Uden disse kan man ikke se om en
    // `wrangler secret put` faktisk nåede frem, og det er ellers umuligt at
    // verificere udefra: intet endpoint afslører en hemmelighed, og ingen
    // kalder den nye kode endnu.
    hemmeligheder: {
      MASTER_SECRET: !!env.MASTER_SECRET,
      CPR_KEY: !!env.CPR_KEY,
      DIAG_TOKEN: !!env.DIAG_TOKEN,
      SIDECAR_TOKEN: !!env.SIDECAR_TOKEN,   // først nødvendig i Fase 4
      RESEND_API_KEY: !!env.RESEND_API_KEY  // først nødvendig i Fase 5
    },
    // CPR_KEY skal være præcis 32 bytes base64 — en forkert længde ville først
    // vise sig når nogen gemte et CPR, altså på det værst mulige tidspunkt.
    cprKeyGyldig: cprKeyGyldig(env),
    euJurisdiktion: jurisdictionActive(env),
    doLagerVirker: lagerOk,
    doSkemaVersion: skemaVersion,
    pwIterations: pwIterations(env),
    kdf: maalinger,
    vurdering: vurder(valgt, maalinger),
    bemaerk: 'Loftet på Workers Free er 10 ms CPU pr. request. Tal her er ' +
             'vægur-tid målt i produktion; CPU-tid er lavere, da await ikke tæller med.'
  };
}

/**
 * Er CPR_KEY et gyldigt 32-byte base64? Returnerer en beskrivelse, ikke nøglen.
 * En for kort nøgle ville ellers først fejle den dag et CPR skulle gemmes.
 */
function cprKeyGyldig(env) {
  const raw = String(env.CPR_KEY || '');
  if (!raw) return 'mangler';
  try {
    const n = atob(raw).length;
    return n === 32 ? true : `forkert længde: ${n} bytes, skal være 32`;
  } catch (e) {
    return 'ikke gyldig base64';
  }
}

function vurder(valgt, alle) {
  const ud = [];
  if (valgt) {
    ud.push(valgt.maxMs <= 5
      ? `Nuværende ${valgt.iterationer} iterationer: max ${valgt.maxMs} ms — god margen under 10 ms.`
      : valgt.maxMs <= 9
        ? `Nuværende ${valgt.iterationer} iterationer: max ${valgt.maxMs} ms — under loftet, men lidt margen.`
        : `Nuværende ${valgt.iterationer} iterationer: max ${valgt.maxMs} ms — FOR TÆT på 10 ms-loftet.`);
  }
  // Hvilket er det højeste trin der stadig har margen?
  const plads = alle.filter(m => m.maxMs <= 7).map(m => m.iterationer);
  ud.push(plads.length
    ? `Højeste iterationstal med margen: ${Math.max(...plads)}. Hæv PW_ITERATIONS dertil gratis.`
    : 'Intet af de målte trin har margen — bliv på det nuværende tal, eller skift til Paid.');
  return ud;
}
