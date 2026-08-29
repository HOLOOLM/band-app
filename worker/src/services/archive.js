// Fakturaarkiv i Cloudflare R2.
//
// ── Hvorfor arkivet flyttede væk fra Google Drive ───────────────────────────
// Sidecarens _archivePdf skrev til DriveApp.getRootFolder() og kørte "som mig",
// så hvert bands fakturaer landede i OPERATØRENS personlige Drive og blev sat
// til Access.PRIVATE. Det gav to fejl der først er synlige i drift:
//
//   1. "↗ Drive"-linket i admin-panelet var dødt for alle andre end den ene
//      Google-konto der havde deployet sidecaren. Enhver anden admin fik
//      "Du har ikke adgang" på sin egen bands faktura.
//   2. Alle bands delte operatørens 15 GB Google-kvote — den samme kvote som
//      vedkommendes Gmail. Arkivet voksede altså ind i en privat postkasse.
//
// R2 retter begge: filen hentes gennem appen med den session brugeren allerede
// har, og pladsen er bandenes egen (10 GB gratis pr. måned).
//
// ── CPR-REGLEN GÆLDER HER ───────────────────────────────────────────────────
// En honorarafregning INDEHOLDER CPR-nummeret. Derfor:
//   • bucket'en må ALDRIG få public access eller et r2.dev-domæne
//   • nøglen må aldrig være gætbar som eneste adgangskontrol — /api/faktura-arkiv
//     kræver en session med admin-rolle, præcis som /api/faktura-pdf
//   • svaret sendes med Cache-Control: no-store
//
// ── JURISDIKTION ────────────────────────────────────────────────────────────
// Bucket'en SKAL oprettes med location hint EU. Ligesom jurisdiction('eu') på
// Durable Objects er det en del af bucket'ens identitet og kan ikke ændres
// bagefter — kun ved at oprette en ny bucket og kopiere alt over.

/** Er R2-bindingen sat op? Uden den arkiveres der ikke. */
export function archiveConfigured(env) {
  return !!(env && env.ARCHIVE);
}

/** Fjerner alt der kan bryde ud af én nøglekomponent. */
function rensDel(s) {
  return String(s || '')
    .replace(/[\/]/g, '-')        // ingen falske mappeskel
    .replace(/[^\w.@ \-æøåÆØÅ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Nøglen for én faktura.
 *
 * Formen `<bandId>/fakturaer/<år>/...` spejler den gamle Drive-mappestruktur,
 * så et band kan hentes eller slettes som ét præfiks.
 *
 * Nøglen indeholder invoiceId og er derfor STABIL: genarkiverer man den samme
 * faktura, overskrives objektet i stedet for at der lægges en kopi ved siden af.
 * Det er dét `replaceFileId` løste manuelt i Drive-versionen.
 */
export function invoiceKey(bandId, year, invoiceNr, invoiceId) {
  const aar = String(year || '').replace(/\D/g, '') || 'ukendt';
  return rensDel(bandId) + '/fakturaer/' + aar + '/' +
         'Faktura-' + rensDel(invoiceNr) + '-' + rensDel(invoiceId) + '.pdf';
}

/**
 * Lægger PDF'en i arkivet.
 *
 * `fileName` gemmes som httpMetadata, så downloadruten kan give browseren det
 * læsbare navn uden at skulle slå op i databasen igen.
 */
export async function putInvoicePdf(env, key, bytes, fileName) {
  if (!archiveConfigured(env)) throw new Error('R2-arkivet er ikke konfigureret');
  await env.ARCHIVE.put(key, bytes, {
    httpMetadata: {
      contentType: 'application/pdf',
      contentDisposition: 'inline; filename="' +
        String(fileName || 'faktura.pdf').replace(/[^\w. \-æøåÆØÅ]/g, '') + '"',
      // Filen indeholder CPR. Ingen mellemled må gemme den.
      cacheControl: 'no-store'
    }
  });
  return { ok: true, key };
}

/** Henter ét objekt. Returnerer null hvis nøglen ikke findes. */
export async function getInvoicePdf(env, key) {
  if (!archiveConfigured(env)) return null;
  return env.ARCHIVE.get(String(key));
}

/** Sletter ét objekt. Stille no-op hvis arkivet ikke er sat op. */
export async function deleteInvoicePdf(env, key) {
  if (!archiveConfigured(env) || !key) return { ok: true, skipped: true };
  await env.ARCHIVE.delete(String(key));
  return { ok: true };
}

/**
 * Sletter ALT under et præfiks. Bruges når et band slettes permanent.
 *
 * R2 har ingen "slet mappe", så der listes og slettes i portioner. list() giver
 * højst 1000 nøgler ad gangen, og delete() tager højst 1000 pr. kald — derfor
 * løkken. Uden den ville et slettet bands fakturaer, med CPR i, blive liggende.
 */
export async function deleteBandArchive(env, bandId) {
  if (!archiveConfigured(env)) return { ok: true, deleted: 0, skipped: true };
  const prefix = rensDel(bandId) + '/';
  let cursor, slettet = 0;
  do {
    const liste = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
    const noegler = liste.objects.map(o => o.key);
    if (noegler.length) {
      await env.ARCHIVE.delete(noegler);
      slettet += noegler.length;
    }
    cursor = liste.truncated ? liste.cursor : undefined;
  } while (cursor);
  return { ok: true, deleted: slettet };
}
