// Fase 3d — jobs og køreafstand.
//
// Læsestien (getJobs, getJob) beregner og skriver INTET. Det er den ændring
// planen navngiver: _ensureDistance (Code.gs:516) tog skrivelåsen midt i en
// jobliste, og med én global lås blokerede det alle bands samtidig.
//
// Afstand beregnes udelukkende når medlemmet ændrer noget der påvirker den:
// hjemmeadresse, alternativ startadresse, tur/retur-hakket, eller et eksplicit
// klik på "beregn km".

import { publicMember } from '../auth/verify.js';
import {
  readCachedDistance, computeAndStoreDistance, wantsReturnHome, venueAddress
} from '../lib/distance.js';

/**
 * getJobs. Ren læsning — afstand kommer fra cachen eller er tom.
 *
 * En tom afstand er ikke en fejl: frontenden viser "beregner…" og har en knap
 * (07-calendar-pdf.js:463). Det er bedre end at lade en jobliste vente på
 * Maps-opslag for hvert job.
 */
export async function getJobs(ctx) {
  const { band, member } = ctx;
  const rows = await band.listMyJobs(member.id);

  // Dedup pr. kontrakt: har samme medlem flere attendance-rækker for samme
  // kontrakt, skal jobbet kun vises én gang. Bevaret fra originalen.
  const set = new Set();
  const jobs = [];
  for (const r of rows) {
    const cid = String(r.contractId);
    if (set.has(cid)) continue;
    set.add(cid);
    const dist = readCachedDistance(r, member.address);
    let venue = {};
    try { venue = JSON.parse(r.venue || '{}') || {}; } catch (e) { venue = {}; }
    jobs.push({
      attendanceId: r.attendanceId,
      contractId: r.contractId,
      type: r.type,
      date: r.date ? new Date(r.date).toISOString() : '',
      venue,
      getIn: r.getIn || '',
      soundcheck: r.soundcheck || '',
      showtimeFrom: r.showtimeFrom || '',
      showtimeTo: r.showtimeTo || '',
      share: Number(r.share) || 0,
      status: r.status,
      confirmedAt: r.confirmedAt || '',
      checkedInAt: r.checkedInAt || '',
      startAddress: r.startAddress || '',
      distanceKm: dist.km,
      distanceOrigin: dist.origin,
      returnHome: wantsReturnHome(r),
      // Kun et flag i listen — selve teksten hentes med jobdetaljen.
      hasMemberNote: !!Number(r.hasMemberNote)
    });
  }
  return { ok: true, jobs, member: publicMember(member) };
}

/**
 * getJob. Jobdetaljen.
 *
 * Fire felter fjernes bevidst fra kontrakten, før den sendes til et medlem:
 * `honorar` (bandets samlede honorar er ikke medlemmets sag), `arrangoer`
 * (arrangørens kontaktoplysninger), samt `paymentTerms` og
 * `paymentTermsOther`. Medlemmet ser kun sin egen `share`.
 */
export async function getJob(ctx) {
  const { band, member, p } = ctx;
  const r = await band.getMyJob(p.attendanceId, member.id);
  if (!r) return { ok: false, error: 'Job ikke fundet' };
  if (!r.contract) return { ok: false, error: 'Kontrakt ikke fundet' };

  const att = r.attendance;
  const dist = readCachedDistance(att, member.address);

  const sc = serializeForMember(r.contract);

  return {
    ok: true,
    job: {
      attendanceId: att.id,
      contract: sc,
      share: Number(att.share) || 0,
      status: att.status,
      confirmedAt: att.confirmedAt || '',
      checkedInAt: att.checkedInAt || '',
      besaetning: r.besaetning,
      startAddress: att.startAddress || '',
      distanceKm: dist.km,
      distanceOrigin: dist.origin,
      returnHome: wantsReturnHome(att),
      distanceOutKm: dist.outKm == null ? '' : dist.outKm,
      distanceBackKm: dist.backKm == null ? '' : dist.backKm,
      homeAddress: member.address || ''
    }
  };
}

/** Kontrakt set fra et medlem. Whitelist, så en ny kolonne ikke lækker. */
function serializeForMember(c) {
  let venue = {};
  try { venue = JSON.parse(c.venue || '{}') || {}; } catch (e) { venue = {}; }
  return {
    id: c.id, type: c.type, status: c.status,
    venue,
    date: c.date ? new Date(c.date).toISOString() : '',
    getIn: c.getIn || '', soundcheck: c.soundcheck || '',
    showtimeFrom: c.showtimeFrom || '', showtimeTo: c.showtimeTo || '',
    sets: Number(c.sets) || 0, setMinutes: Number(c.setMinutes) || 0,
    musicianCount: Number(c.musicianCount) || 0,
    crewCount: Number(c.crewCount) || 0,
    guestCount: Number(c.guestCount) || 0,
    notes: c.notes || '',
    memberNote: c.memberNote || '',
    createdAt: c.createdAt, updatedAt: c.updatedAt
  };
}

/**
 * updateMyAddress. Rydder cachede afstande for de jobs der brugte
 * hjemmeadressen som udgangspunkt — jobs med egen startadresse er upåvirkede.
 *
 * Beregner IKKE forfra: det kunne betyde snesevis af Maps-opslag i én request,
 * og medlemmet skal kunne rette en tastefejl i sin adresse uden at vente.
 */
export async function updateMyAddress(ctx) {
  const { band, member, p } = ctx;
  const addr = String(p.address || '').trim();
  await band.updateMember(member.id, { address: addr });
  const r = await band.invalidateHomeDistances(member.id);
  return { ok: true, address: addr, ryddedeAfstande: r.ryddet };
}

/**
 * updateJobStartAddress. Gemmer og tømmer cachen, men beregner ikke —
 * medlemmet trykker selv "beregn km". Bevaret adfærd fra Code.gs:2155.
 */
export async function updateJobStartAddress(ctx) {
  const { band, member, p } = ctx;
  const start = String(p.startAddress || '').trim();
  const r = await band.setAttendanceStartAddress(p.attendanceId, member.id, start);
  if (!r.ok) return { ok: false, error: 'Job ikke fundet' };
  return { ok: true, startAddress: start, distanceKm: '', distanceOrigin: '' };
}

/**
 * updateJobReturnHome. Hakket er medlemmets eget valg, på samme niveau som
 * startadressen, og tømmer km-cachen så turen beregnes forfra med det nye valg.
 */
export async function updateJobReturnHome(ctx) {
  const { band, member, p } = ctx;
  const on = (p.returnHome === true || p.returnHome === 'true');
  const r = await band.setAttendanceReturnHome(p.attendanceId, member.id, on);
  if (!r.ok) return { ok: false, error: 'Job ikke fundet' };
  return { ok: true, returnHome: on };
}

/**
 * recalcJobDistance. Den ENESTE sti hvor et medlem udløser et Maps-opslag, og
 * den kræver et eksplicit klik.
 */
export async function recalcJobDistance(ctx) {
  const { env, band, member, p } = ctx;
  const r = await band.getAttendanceWithContract(p.attendanceId, member.id);
  if (!r) return { ok: false, error: 'Job ikke fundet' };
  if (!r.contract) return { ok: false, error: 'Kontrakt ikke fundet' };

  const venue = venueAddress(r.contract);
  if (!venue) {
    return { ok: false, error: 'Spillestedet har ingen adresse på kontrakten' };
  }
  const origin = r.attendance.startAddress || member.address || '';
  if (!origin) {
    return { ok: false, error: 'Udfyld din adresse først' };
  }

  const dist = await computeAndStoreDistance(env, band, r.attendance, r.contract, member.address);
  if (dist.km === '') {
    return { ok: false, error: 'Kunne ikke beregne afstanden. Tjek adresserne og prøv igen.' };
  }
  return { ok: true, distanceKm: dist.km, distanceOrigin: dist.origin };
}
