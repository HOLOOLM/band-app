// Måling af password-KDF'ens omkostning. Dette er planens go/no-go for at
// blive på Workers Free.
//
// Gratisplanen giver 10 ms CPU pr. Worker-request. Ventetid på storage tæller
// IKKE med — kun CPU. Det eneste i appen der bruger CPU af betydning er
// PBKDF2 ved login, så spørgsmålet er præcis: hvor mange iterationer kan vi
// betale for inden for budgettet.
//
// FORBEHOLD, som skal med hver gang tallene citeres:
//   1. Lokalt måler vi vægur-tid på DENNE maskine, ikke Cloudflares CPU-tid på
//      deres hardware. PBKDF2 er rent CPU-arbejde uden I/O, så vægur-tid er et
//      rimeligt proxy for CPU-tid — men det absolutte niveau kan afvige.
//   2. CPU-loftet håndhæves ikke lokalt. En overskridelse viser sig kun i
//      produktion som "Worker exceeded CPU limit" i `wrangler tail`.
// Tallene herfra bruges derfor til at vælge et startpunkt og se forholdet
// mellem iterationstal — den endelige bekræftelse kræver et deploy.

import { pbkdf2 } from '../lib/crypto.js';

// 5000 er det valgte tal på Free; 200.000 er målet på Paid. De øvrige trin er
// med for at vise forholdet, så et fremtidigt valg kan tages på tal.
const ITERATION_STEPS = [5000, 10000, 50000, 100000, 200000];
const REPEATS = 5;

/**
 * Kører PBKDF2 ved flere iterationstal og returnerer medianen pr. trin.
 * Median frem for gennemsnit, så en enkelt schedulering-hikke ikke skævvrider.
 */
export async function benchKdf(label) {
  const clientHash = 'a'.repeat(64);          // samme form som sha256(password) hex
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';    // 16 bytes base64, som genSalt() giver
  const rows = [];

  for (const iterations of ITERATION_STEPS) {
    const times = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = Date.now();
      await pbkdf2(clientHash, salt, iterations);
      times.push(Date.now() - t0);
    }
    times.sort((x, y) => x - y);
    rows.push({
      iterationer: iterations,
      medianMs: times[Math.floor(times.length / 2)],
      minMs: times[0],
      maxMs: times[times.length - 1]
    });
  }

  return { hvor: label, gentagelser: REPEATS, maalinger: rows };
}

/**
 * Kører målingen både i den ydre Worker og inde i et band-objekt.
 *
 * Grunden til at måle begge: planen placerer KDF'en i band-objektet, fordi
 * dokumentationen angiver et mere generøst CPU-budget for Durable Objects end
 * de 10 ms en Worker har på gratisplanen. Om det også gælder Free har jeg ikke
 * fået bekræftet, så vi måler frem for at antage.
 */
export async function benchmark(env, bandStub) {
  const iWorker = await benchKdf('Worker (ydre)');
  const iDo = await bandStub.bench();

  const anbefaling = vurder(iWorker, iDo);
  return { ok: true, forbehold: FORBEHOLD, worker: iWorker, durableObject: iDo, anbefaling };
}

const FORBEHOLD = [
  'Lokal vægur-tid på denne maskine, ikke Cloudflares CPU-tid på deres hardware.',
  'CPU-loftet håndhæves ikke lokalt — overskridelse ses kun i produktion via wrangler tail.',
  'Tallene vælger et startpunkt for PW_ITERATIONS; endelig bekræftelse kræver deploy.',
  'MÅLT VARIANS: samme arbejde svingede 4-8 ms ved 10.000 iterationer afhængigt af ' +
  'hvad maskinen ellers lavede. Kør flere gange og brug det HØJESTE tal, ikke det laveste — ' +
  'ellers vælges et iterationstal der kun holder på en tom maskine.'
];

function vurder(worker, doRes) {
  const ved = (r, n) => {
    const m = r.maalinger.find(x => x.iterationer === n);
    return m ? m.medianMs : null;
  };
  const w10 = ved(worker, 10000);
  const d10 = ved(doRes, 10000);
  const d200 = ved(doRes, 200000);
  const linjer = [];

  if (w10 !== null) {
    linjer.push(w10 <= 5
      ? `10.000 iterationer koster ~${w10} ms i Workeren — komfortabelt under 10 ms-loftet.`
      : w10 <= 10
        ? `10.000 iterationer koster ~${w10} ms i Workeren — under loftet, men uden margen.`
        : `10.000 iterationer koster ~${w10} ms i Workeren — OVER 10 ms-loftet. Paid er påkrævet.`);
  }
  if (d10 !== null && w10 !== null) {
    linjer.push(Math.abs(d10 - w10) <= 2
      ? 'Ingen målbar forskel mellem Worker og Durable Object lokalt — forskellen ligger i loftet, ikke i hastigheden.'
      : `Durable Object: ~${d10} ms mod Workerens ~${w10} ms ved 10.000.`);
  }
  if (d200 !== null) {
    linjer.push(`200.000 iterationer (målet på Paid) koster ~${d200} ms — kun realistisk med Paids 30 s CPU-budget.`);
  }
  return linjer;
}
