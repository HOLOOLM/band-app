// Fase 3e — honorar og fakturaer.
//
// To ting kræver omhu her.
//
// 1. FAKTURANUMRE. Et slettet fakturanummer må ALDRIG genbruges — to fakturaer
//    med samme nummer i bogføringen er en reel fejl. Derfor er sletning soft:
//    rækken bliver liggende med status 'slettet', så nummeret forbliver brugt.
//
// 2. CPR NÅR ALDRIG BROWSEREN. Honorarafregningen indeholder CPR, og hele
//    grunden til at den renderes server-side er, at nummeret ikke må findes i
//    nogen Network-JSON eller i DOM'en. Actionsene her returnerer derfor
//    beløb og km, men aldrig CPR — det håndteres af /api/faktura-pdf, som
//    streamer en færdig PDF (Fase 3f).

import { publicMember } from '../auth/verify.js';
import { readCachedDistance } from '../lib/distance.js';

/** Bygger honorarrækker ud fra rådata. Fælles for medlem og admin. */
function byggRaekker(raw, homeAddress) {
  return raw.rows.map(r => {
    let venue = {};
    try { venue = JSON.parse(r.venue || '{}') || {}; } catch (e) { venue = {}; }
    // Læser den CACHEDE afstand. Beregner ikke — samme regel som joblisten:
    // en afregning må ikke udløse Maps-opslag og skrivninger på en læsesti.
    const dist = readCachedDistance(r, homeAddress);
    return {
      date: r.date ? new Date(r.date).toISOString() : '',
      venue,
      type: r.type,
      share: Number(r.share) || 0,
      status: r.status,
      attendanceStatus: r.attendanceStatus,
      getIn: r.getIn || '',
      soundcheck: r.soundcheck || '',
      showtimeFrom: r.showtimeFrom || '',
      showtimeTo: r.showtimeTo || '',
      sets: Number(r.sets) || 0,
      setMinutes: Number(r.setMinutes) || 0,
      besaetning: raw.besaetning[String(r.contractId)] || [],
      startAddress: r.startAddress || '',
      distanceKm: dist.km
    };
  });
}

function summer(raekker) {
  const total = raekker.reduce((s, r) => s + r.share, 0);
  const km = raekker.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
  return { total, totalKm: Math.round(km * 10) / 10 };
}

/** getMyHonorar — medlemmets egen afregning. */
export async function getMyHonorar(ctx) {
  const { band, member, p } = ctx;
  const raw = await band.honorarRows(member.id, p.fra, p.til);
  const rows = byggRaekker(raw, member.address);
  return Object.assign({ ok: true, rows, member: publicMember(member) }, summer(rows));
}

/**
 * getHonorarAdmin — admin ser et vilkårligt medlems afregning.
 *
 * Bemærk at afstanden beregnes ud fra MÅLMEDLEMMETS hjemmeadresse, ikke
 * admins. Det er nemt at forveksle, og ville give forkerte km-tal på en
 * afregning der skal udbetales efter.
 */
export async function getHonorarAdmin(ctx) {
  const { band, p } = ctx;
  const target = await band.findMemberById(p.memberId);
  if (!target) return { ok: false, error: 'Medlem ikke fundet' };
  const raw = await band.honorarRows(target.id, p.fra, p.til);
  const rows = byggRaekker(raw, target.address);
  return Object.assign({ ok: true, rows, member: publicMember(target) }, summer(rows));
}

/**
 * createInvoice. Opretter fakturarækken og reserverer nummeret.
 *
 * Drive-arkiveringen er en SEPARAT action (Fase 3f), fordi den kræver
 * sidecaren og ikke må kunne blokere selve nummerreservationen.
 */
export async function createInvoice(ctx) {
  const { band, p } = ctx;
  if (!p.contractId) return { ok: false, error: 'contractId mangler' };
  const r = await band.createInvoice(p.contractId);
  if (!r || !r.ok) return r || { ok: false, error: 'Kunne ikke oprette faktura' };
  return { ok: true, invoice: r.invoice, reused: r.reused };
}

/** getInvoices — aktive fakturaer, beriget med arrangør og spillested. */
export async function getInvoices(ctx) {
  const rows = await ctx.band.listInvoices();
  const parse = v => {
    if (!v) return null;
    try { return JSON.parse(v); } catch (e) { return null; }
  };
  const invoices = rows.map(i => ({
    id: i.id,
    contractId: i.contractId,
    invoiceNr: i.invoiceNr,
    date: i.date,
    amount: Number(i.amount) || 0,
    status: i.status,
    driveFileId: i.driveFileId || '',
    driveUrl: i.driveUrl || '',
    createdAt: i.createdAt,
    paidAt: i.paidAt || '',
    arrangoer: parse(i.arrangoer),
    venue: parse(i.venue),
    contractDate: i.contractDate || null
  }));
  return { ok: true, invoices };
}

const GYLDIGE_FAKTURASTATUS = ['udestaaende', 'betalt', 'slettet'];

export async function updateInvoiceStatus(ctx) {
  const { band, p } = ctx;
  if (!p.id || !p.status) return { ok: false, error: 'id eller status mangler' };
  if (!GYLDIGE_FAKTURASTATUS.includes(p.status)) {
    return { ok: false, error: 'Ugyldig status' };
  }
  const r = await band.setInvoiceStatus(p.id, p.status);
  if (!r.ok) return { ok: false, error: 'Faktura ikke fundet' };
  return { ok: true };
}

/**
 * deleteInvoice. SOFT delete — rækken bliver liggende, så nummeret forbliver
 * reserveret.
 *
 * Selve PDF-filen slettes derimod HÅRDT. Den indeholder CPR, og en faktura
 * brugeren har slettet må ikke blive liggende læsbar i arkivet.
 *
 * Lykkes oprydningen ikke, er fakturaen stadig slettet, og brugeren får en
 * advarsel om at rydde op manuelt — samme afvejning som Code.gs:2489. At fejle
 * hele handlingen ville efterlade fakturaen aktiv, hvilket er værre.
 */
export async function deleteInvoice(ctx) {
  const { env, band, p } = ctx;
  if (!p.id) return { ok: false, error: 'id mangler' };
  const r = await band.softDeleteInvoice(p.id);
  if (!r.ok) return { ok: false, error: r.error || 'Faktura ikke fundet' };

  if (r.archiveKey) {
    try {
      const { deleteInvoicePdf } = await import('../services/archive.js');
      await deleteInvoicePdf(env, r.archiveKey);
    } catch (e) {
      console.error('deleteInvoice: kunne ikke slette arkivobjekt ' + r.archiveKey +
                    ': ' + (e && e.message || e));
      return {
        ok: true,
        warning: 'Fakturaen er slettet, men den arkiverede PDF kunne ikke fjernes. Fejlen er logget.'
      };
    }
  }

  // Bands arkiveret FØR flytningen til R2 har stadig en rigtig Drive-fil.
  if (r.driveFileId) {
    try {
      const { callSidecar } = await import('../services/sidecar.js');
      await callSidecar(env, 'trashFile', { fileId: r.driveFileId });
    } catch (e) {
      console.warn('deleteInvoice: kunne ikke flytte Drive-fil til papirkurv: ' +
                   (e && e.message || e));
      return {
        ok: true,
        warning: 'Fakturaen er slettet, men Drive-filen kunne ikke flyttes til papirkurven — slet den manuelt i Drive.'
      };
    }
  }
  return { ok: true };
}
