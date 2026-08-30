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
import { backupConfigured, putBackup, pruneBackups, OPBEVARING_UGER }
  from './services/backup.js';

const CACHE_MAX_DAGE = 180;

// Søndag. Kopien tages KUN én dag om ugen: exportAll() læser hele bandets
// database, og at gøre det hver nat ville koste læsninger uden at give mere
// sikkerhed end PITR allerede giver på de mellemliggende dage.
const BACKUP_UGEDAG = 0;

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

  // ── Ugentlig sikkerhedskopi ────────────────────────────────────────────
  // Lægges EFTER oprydningen, så kopien afspejler den tilstand der faktisk
  // står tilbage — ellers ville hver kopi indeholde udløbne sessioner og
  // login-poster der blev slettet et sekund senere.
  //
  // Fejler den, må den ikke vælte oprydningen: de tre ryddede ting er allerede
  // skrevet, og en manglende kopi er et mindre problem end en cron der stopper.
  let backup = null;
  if (erBackupDag(event) && backupConfigured(env)) {
    try {
      backup = await tagBackups(env, bands);
    } catch (e) {
      console.error('Cron: backup fejlede helt: ' + (e && e.message || e));
      backup = { fejl: String(e && e.message || e) };
    }
  }

  // Returneres så runRetentionNow kan vise tallene til operatøren. Cron-kalderen
  // ignorerer returværdien.
  return { bands: bands.length, sum, fejlede: fejl, backup };
}

/**
 * Er det backup-dag?
 *
 * Tidspunktet tages fra cron-eventet frem for Date.now(), så en manuel kørsel
 * kan pege på en anden dag. Mangler det, falder vi tilbage på uret.
 */
function erBackupDag(event) {
  const t = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  return t.getUTCDay() === BACKUP_UGEDAG;
}

async function tagBackups(env, bands) {
  const dato = new Date().toISOString().slice(0, 10);
  const ok = [];
  const fejl = [];

  // Ét band ad gangen. exportAll() læser hele databasen, og at køre alle bands
  // parallelt ville lægge hele lørdagens læsekvote i ét sekund.
  for (const b of bands) {
    try {
      const dump = await bandStub(env, b.bandId).exportAll();
      const r = await putBackup(env, b.bandId, dato, dump);
      ok.push({ bandId: b.bandId, bytes: r.bytes });
    } catch (e) {
      fejl.push({ bandId: b.bandId, error: String(e && e.message || e) });
      console.error('Backup fejlede for ' + b.bandId + ': ' + (e && e.message || e));
    }
  }

  // Oprydningen ligger her og ikke i band-løkken: et SLETTET band får aldrig
  // kørt sin egen gren, og dets kopier ville blive liggende for evigt.
  let ryddet = null;
  try {
    ryddet = await pruneBackups(env);
  } catch (e) {
    console.error('Backup-oprydning fejlede: ' + (e && e.message || e));
  }

  console.log('Backup: ' + ok.length + ' bands kopieret, ' + fejl.length + ' fejlede' +
    (ryddet ? ', ' + ryddet.slettet + ' gamle slettet (ældre end ' +
      ryddet.graense + ', ' + OPBEVARING_UGER + ' uger)' : ''));

  return { dato, kopieret: ok.length, fejlede: fejl, ryddet };
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
