// Fase 6 — natlig oprydning.
//
// Kører 02:00 UTC (03:00/04:00 dansk tid) via cron-triggeren i wrangler.toml.
// Cron virker på Workers Free.
//
// Fanen rydder tre ting, og hver har sin begrundelse:
//
//   1. UDLØBNE SESSIONER. De er allerede ugyldige (getSession afviser dem), men
//      rækkerne bliver liggende og fylder. Uden oprydning vokser tabellen
//      monotont.
//   2. GAMMEL LOGIN-LOG efter bandets opbevaringspolitik. Det er
//      personhenførbare data (e-mail, tidspunkt, user agent) og indgår i
//      GDPR-eksporten — at gemme dem i årevis er unødvendig opbevaring.
//   3. GAMLE AFSTANDS-CACHE-RÆKKER. Rent teknisk cache; en adresse kan være
//      revet ned, og et gammelt tal er værre end at slå op igen.
//
// Fejler oprydningen for ét band, fortsætter de øvrige. En cron der stopper ved
// første fejl ville betyde at ét dårligt band blokerer oprydning for alle.

import { masterStub, bandStub } from './lib/addressing.js';

const CACHE_MAX_DAGE = 180;

export async function scheduled(event, env, ctx) {
  const start = Date.now();
  let bands = [];
  try {
    bands = await masterStub(env).listBands();
  } catch (e) {
    console.error('Cron: kunne ikke hente bandlisten: ' + (e && e.message || e));
    return;
  }

  const resultater = await Promise.allSettled(bands.map(b => ryd(env, b.bandId)));
  const ok = [];
  const fejl = [];
  resultater.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else fejl.push({ bandId: bands[i].bandId, error: String(r.reason && r.reason.message || r.reason) });
  });

  const sum = ok.reduce((a, r) => ({
    sessioner: a.sessioner + r.sessioner,
    loginLog: a.loginLog + r.loginLog,
    cache: a.cache + r.cache
  }), { sessioner: 0, loginLog: 0, cache: 0 });

  console.log('Cron færdig i ' + (Date.now() - start) + ' ms: ' +
    bands.length + ' bands, ' + sum.sessioner + ' sessioner, ' +
    sum.loginLog + ' login-poster, ' + sum.cache + ' cache-rækker ryddet' +
    (fejl.length ? ' — ' + fejl.length + ' FEJLEDE: ' + fejl.map(f => f.bandId).join(', ') : ''));

  if (fejl.length) {
    for (const f of fejl) console.error('Cron-fejl for ' + f.bandId + ': ' + f.error);
  }

  // Returneres så runRetentionNow kan vise tallene til operatøren. Cron-kalderen
  // ignorerer returværdien.
  return { bands: bands.length, sum, fejlede: fejl };
}

async function ryd(env, bandId) {
  const band = bandStub(env, bandId);
  const s = await band.getSettings();

  // Tom eller 0 = behold alt. Det er bandets eget valg, sat i operatør-UI'et.
  const maaneder = parseInt(s.retentionLoginLogMonths, 10);
  const loginCutoff = (Number.isFinite(maaneder) && maaneder > 0)
    ? new Date(Date.now() - maaneder * 30 * 86400000).toISOString()
    : null;

  const cacheCutoff = new Date(Date.now() - CACHE_MAX_DAGE * 86400000).toISOString();
  const r = await band.runRetention(loginCutoff, cacheCutoff);
  return { bandId, sessioner: r.sessioner, loginLog: r.loginLog, cache: r.cache };
}
