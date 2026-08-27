// Fase 3f — PDF via sidecar.
//
// Arbejdsdelingen: Workeren bygger HTML'en (den kender datamodellen), sidecaren
// konverterer til PDF (den har Drive-Docs). Sidecaren får kun færdig HTML og
// skal derfor ikke opdateres når et felt ændrer navn.
//
// CPR-REGLEN gælder hele denne fil: renderInvoicePdf returnerer PDF-bytes, ALDRIG
// HTML'en og aldrig CPR-nummeret som felt. Der findes bevidst ingen action der
// returnerer afregningens HTML — kunne man hente den, kunne man også hente CPR.

import { decryptCpr } from '../lib/crypto.js';
import { buildInvoiceHtml } from '../lib/invoice-html.js';
import { callSidecar, sidecarConfigured } from '../services/sidecar.js';
import { masterStub } from '../lib/addressing.js';
import { userError } from '../lib/errors.js';

/**
 * Henter bandets CPR i klartekst. ENESTE kalder er PDF-renderingen.
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
 * Bygger honorarafregningen som PDF.
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

  const r = await band.getContract(contractId);
  if (!r) throw userError('Kontrakt ikke fundet');

  const c = r.contract;
  let arrangoer = {}, venue = {};
  try { arrangoer = JSON.parse(c.arrangoer || '{}') || {}; } catch (e) {}
  try { venue = JSON.parse(c.venue || '{}') || {}; } catch (e) {}

  const cpr = await hentCpr(env, bandId);
  const settings = await band.getSettings();
  const logo = await band.getAsset('logo');

  const html = buildInvoiceHtml(
    Object.assign({}, c, {
      arrangoer, venue,
      date: c.date ? new Date(c.date).toISOString() : '',
      honorar: Number(c.honorar) || 0
    }),
    inv.invoice.invoiceNr, settings, cpr, logo ? logo.dataUrl : ''
  );

  if (!sidecarConfigured(env)) {
    throw userError('PDF-tjenesten er ikke konfigureret endnu — kontakt din administrator');
  }
  const fileName = 'Honorarafregning ' + inv.invoice.invoiceNr;
  const res = await callSidecar(env, 'renderPdf', { html, fileName });
  if (!res.pdfBase64) throw userError('PDF-konvertering fejlede — fejlen er logget.');

  return {
    pdfBase64: res.pdfBase64,
    fileName: fileName + '.pdf',
    invoiceNr: inv.invoice.invoiceNr,
    invoiceId: inv.invoice.id,
    reused: !!inv.reused
  };
}

/**
 * archiveInvoiceToDrive — gemmer en færdig PDF i bandets Drive-arkiv.
 *
 * Klienten sender PDF'en som base64 (den har den fra print-til-PDF), eller vi
 * renderer den her. Drive-mappen oprettes lazy af sidecaren ved første
 * arkivering, så der er ingen opsætning at glemme.
 */
export async function archiveInvoiceToDrive(ctx) {
  const { env, band, bandId, p } = ctx;
  const contractId = String(p.contractId || '').trim();
  if (!contractId) return { ok: false, error: 'contractId mangler' };

  const inv = await band.createInvoice(contractId);
  if (!inv || !inv.ok) return inv || { ok: false, error: 'Kunne ikke reservere fakturanr' };

  let pdfBase64 = String(p.pdfBase64 || '');
  if (!pdfBase64) {
    try {
      const r = await renderInvoicePdf(env, band, bandId, contractId);
      pdfBase64 = r.pdfBase64;
    } catch (e) {
      return { ok: false, error: e && e.userFacing ? e.message : 'Kunne ikke danne PDF' };
    }
  }

  const settings = await band.getSettings();
  const r = await band.getContract(contractId);
  let venue = {};
  try { venue = JSON.parse((r && r.contract.venue) || '{}') || {}; } catch (e) {}
  const aar = String(inv.invoice.date || '').slice(0, 4) || String(new Date().getFullYear());

  let res;
  try {
    res = await callSidecar(env, 'archivePdf', {
      pdfBase64,
      fileName: 'Faktura ' + inv.invoice.invoiceNr + ' — ' + (venue.name || contractId),
      folderName: settings.invoiceFolderName || 'Fakturaer',
      bandId, year: aar,
      // Den gamle fil skal i papirkurven, ellers ophober vi kopier ved hver
      // genudsendelse.
      replaceFileId: inv.invoice.driveFileId || ''
    });
  } catch (e) {
    return { ok: false, error: e && e.userFacing ? e.message : 'Kunne ikke arkivere på Drive' };
  }

  await band.setInvoiceDriveFile(inv.invoice.id, res.fileId || '', res.url || '');
  return { ok: true, driveFileId: res.fileId || '', driveUrl: res.url || '', warning: res.warning || '' };
}
