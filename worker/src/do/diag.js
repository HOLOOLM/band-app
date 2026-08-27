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
  const forventet = String(env.DIAG_TOKEN || '');
  if (!forventet) return false;                       // ikke sat = endpointet findes ikke
  const givet = String(request.headers.get('X-Diag-Token') || '');
  if (!givet) return false;
  return constTimeEq(givet, forventet);
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
