// Ugentlig sikkerhedskopi af hvert bands database til R2.
//
// ── HVORFOR, NÅR DER ALLEREDE ER POINT-IN-TIME RECOVERY ─────────────────────
// Durable Objects har PITR 30 dage tilbage, og den er finere end noget vi kan
// bygge: den rammer minuttet. Men den lever INDE i objektet. Slettes bandet
// (deleteTenant kalder wipe), forsvinder historikken med det.
//
// De to dækker derfor hver sin fejl:
//
//   PITR          en forkert handling i et band der stadig findes.
//                 Minutpræcis, men uden værdi hvis objektet er væk.
//   Denne kopi    at bandet selv er væk — eller at nogen skal have dataene
//                 UD af systemet. Koster op til en uges arbejde.
//
// ── HVORFOR UDEN FOR BANDETS EGEN MAPPE ─────────────────────────────────────
// Fakturaarkivet ligger under `<bandId>/`, og deleteBandArchive rydder præcis
// det præfiks når et band slettes. Lå kopierne dér, ville de forsvinde i
// samme øjeblik man fik brug for dem — en backup der kun findes så længe
// originalen gør, er ingen backup.
//
// De ligger derfor under `_backups/`. Et band-id matcher ^[a-z0-9-]{2,40}$ og
// kan ikke indeholde underscore, så præfikset kan aldrig kollidere med et
// bands egen mappe.
//
// ── PERSONDATA ──────────────────────────────────────────────────────────────
// En kopi indeholder medlemmernes navne, adresser, telefonnumre og e-mail.
// Den indeholder IKKE CPR: bandets CPR ligger krypteret i master, ikke i
// bandets eget objekt, og følger derfor ikke med exportAll().
//
// Kopierne slettes efter OPBEVARING_UGER — også for slettede bands. Det er
// bevidst valgt 30/8: en fejlagtig sletning skal kunne fortrydes, og prisen er
// at persondata lever et afgrænset stykke tid videre. Det tal skal kunne siges
// højt over for bandene: "backups slettes inden for otte uger".

const PRAEFIKS = '_backups/';

/** Otte uger ≈ to måneder. Ændres tallet, ændres løftet til bandene. */
export const OPBEVARING_UGER = 8;

export function backupConfigured(env) {
  return !!(env && env.ARCHIVE);
}

/**
 * Nøglen for én kopi: `_backups/<bandId>/<ÅÅÅÅ-MM-DD>.json`
 *
 * Datoen i nøglen gør to ting: den er sorterbar som tekst, og den gør kørslen
 * idempotent. Kører cron'en to gange samme søndag, overskrives kopien i stedet
 * for at der lægges en dublet ved siden af.
 */
export function backupKey(bandId, dato) {
  return PRAEFIKS + String(bandId).replace(/[^a-z0-9-]/g, '') + '/' +
         String(dato).slice(0, 10) + '.json';
}

/** Skriver kopien. Datoen gemmes også i metadata, så en liste kan læses uden at hente indholdet. */
export async function putBackup(env, bandId, dato, data) {
  const key = backupKey(bandId, dato);
  const krop = JSON.stringify({
    _band: bandId,
    _taget: new Date().toISOString(),
    _bemaerk: 'Ugentlig sikkerhedskopi. Indeholder persondata — ikke CPR.',
    data
  });
  await env.ARCHIVE.put(key, krop, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { bandId: String(bandId), dato: String(dato).slice(0, 10) }
  });
  return { ok: true, key, bytes: krop.length };
}

/** Kopierne for ét band, nyeste først. */
export async function listBackups(env, bandId) {
  const prefix = PRAEFIKS + String(bandId).replace(/[^a-z0-9-]/g, '') + '/';
  const ud = [];
  let cursor;
  do {
    const liste = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
    for (const o of liste.objects) {
      ud.push({
        key: o.key,
        dato: (o.key.split('/').pop() || '').replace('.json', ''),
        bytes: o.size,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : ''
      });
    }
    cursor = liste.truncated ? liste.cursor : undefined;
  } while (cursor);
  ud.sort((a, b) => (a.dato < b.dato ? 1 : a.dato > b.dato ? -1 : 0));
  return ud;
}

/** Henter én kopi som tekst. Returnerer null hvis nøglen ikke findes. */
export async function getBackup(env, key) {
  // Nøglen må kun pege ind i backup-området. Uden dette tjek kunne en
  // operatør-action med en manipuleret nøgle hente en faktura-PDF — altså et
  // dokument med CPR — gennem en rute der lover det modsatte.
  if (!String(key || '').startsWith(PRAEFIKS)) return null;
  const obj = await env.ARCHIVE.get(String(key));
  if (!obj) return null;
  return await obj.text();
}

/**
 * Sletter kopier ældre end OPBEVARING_UGER — på tværs af ALLE bands, også dem
 * der ikke findes længere. Det er netop derfor oprydningen ikke kan ligge i
 * bandets egen cron-gren: et slettet band får aldrig kørt sin egen oprydning,
 * og dets kopier ville blive liggende for evigt.
 */
export async function pruneBackups(env, nu) {
  const graense = new Date((nu || Date.now()) - OPBEVARING_UGER * 7 * 86400000)
    .toISOString().slice(0, 10);
  let cursor, slettet = 0, beholdt = 0;
  do {
    const liste = await env.ARCHIVE.list({ prefix: PRAEFIKS, cursor, limit: 1000 });
    const gamle = [];
    for (const o of liste.objects) {
      const dato = (o.key.split('/').pop() || '').replace('.json', '');
      // Strengsammenligning virker fordi ÅÅÅÅ-MM-DD sorterer kronologisk.
      if (dato && dato < graense) gamle.push(o.key); else beholdt++;
    }
    if (gamle.length) {
      await env.ARCHIVE.delete(gamle);
      slettet += gamle.length;
    }
    cursor = liste.truncated ? liste.cursor : undefined;
  } while (cursor);
  return { slettet, beholdt, graense };
}
