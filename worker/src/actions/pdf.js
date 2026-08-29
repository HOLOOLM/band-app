// Fase 3f — PDF via sidecar.
//
// Arbejdsdelingen: Workeren bygger HTML'en (den kender datamodellen), sidecaren
// konverterer til PDF (den har Drive-Docs). Sidecaren får kun færdig HTML og
// skal derfor ikke opdateres når et felt ændrer navn.
//
// CPR-REGLEN gælder hele denne fil: renderInvoicePdf returnerer PDF-bytes, ALDRIG
// HTML'en og aldrig CPR-nummeret som felt. Der findes bevidst ingen action der
// returnerer afregningens HTML — kunne man hente den, kunne man også hente CPR.
//
// ── DE TO PDF-UDGAVER ER IKKE SAMME FIL ─────────────────────────────────────
// Der findes to renderinger af samme faktura, og forskellen er CPR-nummeret:
//
//   MED CPR    kun /api/faktura-pdf, som streamer bytes til den admin der bad
//              om dem. Filen gemmes ingen steder.
//   UDEN CPR   arkivkopien. Den ligger i R2 og kan hentes igen senere, og
//              netop derfor må CPR ikke være i den.
//
// Det er også dét knappen i admin-panelet lover brugeren ("Arkivér til Drive
// uden CPR", 08-admin.js:425). Sammenblandes de to, bliver den tekst usand, og
// CPR-numre begynder at ophobe sig i et arkiv nogen tror er harmløst.
// Adskillelsen håndhæves ved at KUN renderInvoicePdf henter CPR overhovedet.

import { decryptCpr, b64ToBytes } from '../lib/crypto.js';
import { buildInvoiceHtml } from '../lib/invoice-html.js';
import { callSidecar, sidecarConfigured } from '../services/sidecar.js';
import { archiveConfigured, invoiceKey, putInvoicePdf, deleteInvoicePdf } from '../services/archive.js';
import { masterStub } from '../lib/addressing.js';
import { userError } from '../lib/errors.js';

/**
 * Henter bandets CPR i klartekst. ENESTE kalder er renderInvoicePdf.
 *
 * Nøglen (CPR_KEY) er en Worker-hemmelighed og ligger ikke i data, så et brud på
 * databasen alene giver ikke CPR.
 */
async function hentCpr(env, bandId) {
  const row = await masterStub(env).getBand(bandId);
  if (!row || !row.cprEnc) {
    throw userError('CPR ikke konfigureret for dette band — gå til Indstillinger og udfyld faktureringsoplysninger');
  }
  try {
    return await decryptCpr(env, row.cprEnc);
  } catch (e) {
    // Den underliggende fejl kan afsløre nøgleformat og lignende — log den,
    // men send en generisk besked.
    console.error('CPR-dekryptering fejlede for ' + bandId + ': ' + (e && e.message || e));
    throw userError('CPR kunne ikke dekrypteres — fejlen er logget.');
  }
}

/**
 * Fælles opbygning af fakturaens HTML.
 *
 * `cpr` er tom streng med mindre kalderen udtrykkeligt har hentet nummeret.
 * buildInvoiceHtml udelader CPR-linjerne når værdien er tom, så arkivkopien
 * bliver CPR-fri ved at undlade at HENTE nummeret — ikke ved at fjerne det
 * bagefter. Det er en vigtig forskel: den sidste form ville efterlade CPR i
 * hukommelsen og kun afhænge af at et regulært udtryk ramte rigtigt.
 */
async function byggFakturaHtml(band, contractId, invoiceNr, cpr) {
  const r = await band.getContract(contractId);
  if (!r) throw userError('Kontrakt ikke fundet');

  const c = r.contract;
  let arrangoer = {}, venue = {};
  try { arrangoer = JSON.parse(c.arrangoer || '{}') || {}; } catch (e) {}
  try { venue = JSON.parse(c.venue || '{}') || {}; } catch (e) {}

  const settings = await band.getSettings();
  const logo = await band.getAsset('logo');

  return {
    html: buildInvoiceHtml(
      Object.assign({}, c, {
        arrangoer, venue,
        date: c.date ? new Date(c.date).toISOString() : '',
        honorar: Number(c.honorar) || 0
      }),
      invoiceNr, settings, cpr || '', logo ? logo.dataUrl : ''
    ),
    venue
  };
}

/** HTML → PDF gennem sidecaren. Kaster en brugervendt fejl hvis den mangler. */
async function tilPdf(env, html, fileName) {
  if (!sidecarConfigured(env)) {
    throw userError('PDF-tjenesten er ikke konfigureret endnu — kontakt din administrator');
  }
  const res = await callSidecar(env, 'renderPdf', { html, fileName });
  if (!res.pdfBase64) throw userError('PDF-konvertering fejlede — fejlen er logget.');
  return res.pdfBase64;
}

/**
 * Bygger honorarafregningen MED CPR som PDF.
 *
 * Kaldes IKKE gennem /api/call, men af Workerens /api/faktura-pdf-rute, som
 * streamer bytes direkte til browseren med Cache-Control: no-store. Det er hele
 * grunden til at CPR ikke findes i nogen JSON.
 */
export async function renderInvoicePdf(env, band, bandId, contractId) {
  // Reservér/genbrug fakturanummeret først. Fejler PDF-konverteringen bagefter,
  // er nummeret stadig reserveret — det er med vilje: et hul i rækken er bedre
  // end to fakturaer med samme nummer.
  const inv = await band.createInvoice(contractId);
  if (!inv || !inv.ok) throw userError((inv && inv.error) || 'Kunne ikke reservere fakturanr');

  const cpr = await hentCpr(env, bandId);
  const { html } = await byggFakturaHtml(band, contractId, inv.invoice.invoiceNr, cpr);

  const fileName = 'Honorarafregning ' + inv.invoice.invoiceNr;
  return {
    pdfBase64: await tilPdf(env, html, fileName),
    fileName: fileName + '.pdf',
    invoiceNr: inv.invoice.invoiceNr,
    invoiceId: inv.invoice.id,
    reused: !!inv.reused
  };
}

/**
 * Gemmer en CPR-FRI kopi af fakturaen i bandets R2-arkiv.
 *
 * Action-navnet er stadig `archiveInvoiceToDrive` i tabellen, fordi frontenden
 * kalder den ved det navn. Navnet er historisk: arkivet ligger i R2, ikke i
 * Drive. Se services/archive.js for hvorfor det flyttede.
 *
 * Bemærk at der ikke tages imod en færdig PDF fra klienten. Den gamle action
 * accepterede p.pdfBase64; gør man det, kan en kalder lægge hvad som helst i
 * arkivet — CPR indbefattet — og CPR-garantien ovenfor ville kun gælde den ene
 * sti vi selv renderer. Frontenden sendte den aldrig, så intet mistes.
 */
export async function archiveInvoice(ctx) {
  const { env, band, bandId, p } = ctx;
  // Uden bindingen ville fakturaen se ud som arkiveret uden at ligge nogen
  // steder. En tydelig fejl er bedre end et falsk kvitteringssvar.
  if (!archiveConfigured(env)) {
    return { ok: false, error: 'Fakturaarkivet er ikke sat op endnu — R2-bindingen ARCHIVE mangler. Kontakt din administrator.' };
  }

  // Frontenden sender invoiceId (08-admin.js:457) — den har allerede oprettet
  // fakturaen og vil kun arkivere den. contractId accepteres også, så en kalder
  // der kun kender kontrakten kan oprette-og-arkivere i ét kald.
  let contractId = String(p.contractId || '').trim();
  const invoiceId = String(p.invoiceId || '').trim();
  if (!contractId && invoiceId) {
    const eksisterende = await band.getInvoice(invoiceId);
    if (!eksisterende) return { ok: false, error: 'Faktura ikke fundet' };
    contractId = String(eksisterende.contractId || '');
  }
  if (!contractId) return { ok: false, error: 'contractId eller invoiceId mangler' };

  const inv = await band.createInvoice(contractId);
  if (!inv || !inv.ok) return inv || { ok: false, error: 'Kunne ikke reservere fakturanr' };

  const aar = String(inv.invoice.date || '').slice(0, 4) || String(new Date().getFullYear());
  const key = invoiceKey(bandId, aar, inv.invoice.invoiceNr, inv.invoice.id);

  let pdfBase64, visningsnavn;
  try {
    // Ingen hentCpr her. Det er hele garantien.
    const { html, venue } = await byggFakturaHtml(band, contractId, inv.invoice.invoiceNr, '');
    visningsnavn = 'Faktura ' + inv.invoice.invoiceNr + (venue.name ? ' — ' + venue.name : '');
    pdfBase64 = await tilPdf(env, html, visningsnavn);
  } catch (e) {
    return { ok: false, error: e && e.userFacing ? e.message : 'Kunne ikke danne PDF' };
  }

  try {
    await putInvoicePdf(env, key, b64ToBytes(pdfBase64), visningsnavn + '.pdf');
  } catch (e) {
    console.error('archiveInvoice: R2-put fejlede for ' + key + ': ' + (e && e.stack || e));
    return { ok: false, error: 'Kunne ikke gemme fakturaen i arkivet — fejlen er logget.' };
  }

  // Flyttede fakturaen år (fx fordi datoen blev rettet), peger den gamle nøgle
  // stadig på en forældet kopi. Ryd den op — men først EFTER den nye ligger der,
  // så en fejl undervejs ikke efterlader fakturaen uden arkiveret kopi.
  const gammel = String(inv.invoice.archiveKey || '');
  if (gammel && gammel !== key) {
    try { await deleteInvoicePdf(env, gammel); }
    catch (e) { console.warn('archiveInvoice: gammel nøgle ' + gammel + ' kunne ikke slettes: ' + (e && e.message || e)); }
  }

  await band.setInvoiceArchive(inv.invoice.id, key);
  return {
    ok: true,
    archiveKey: key,
    archiveUrl: '/api/faktura-arkiv?invoiceId=' + encodeURIComponent(inv.invoice.id)
  };
}
