// Fase 3c — kontrakter og dashboard.
//
// Svarformerne er bit-for-bit som i dag. serializeContract er den vigtigste:
// den udpakker arrangoer/venue fra JSON-strenge og tvinger tal til tal, og
// frontenden læser felterne direkte (04-contracts.js, 05-honorar.js).

import { userError } from '../lib/errors.js';

const GYLDIGE_STATUS = ['udkast', 'afventer', 'godkendt'];

/**
 * Port af _serializeContract (Code.gs:1798). Bemærk at `date` returneres som
 * ISO-streng: klienten forventer det format, og en tom dato skal give tom
 * streng — ikke "Invalid Date".
 */
function serializeContract(c) {
  const parse = v => {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch (e) { return {}; }
  };
  return {
    id: c.id, type: c.type, status: c.status,
    arrangoer: parse(c.arrangoer),
    venue: parse(c.venue),
    date: c.date ? new Date(c.date).toISOString() : '',
    getIn: c.getIn || '', soundcheck: c.soundcheck || '',
    showtimeFrom: c.showtimeFrom || '', showtimeTo: c.showtimeTo || '',
    sets: Number(c.sets) || 0, setMinutes: Number(c.setMinutes) || 0,
    musicianCount: Number(c.musicianCount) || 0,
    crewCount: Number(c.crewCount) || 0,
    guestCount: Number(c.guestCount) || 0,
    honorar: Number(c.honorar) || 0,
    paymentTerms: c.paymentTerms || '', paymentTermsOther: c.paymentTermsOther || '',
    notes: c.notes || '', memberNote: c.memberNote || '',
    createdAt: c.createdAt, updatedAt: c.updatedAt
  };
}

export async function getContracts(ctx) {
  const rows = await ctx.band.listContracts();
  return { ok: true, contracts: rows.map(serializeContract) };
}

export async function getContract(ctx) {
  const id = String(ctx.p.id || '');
  if (!id) return { ok: false, error: 'Mangler id' };
  const r = await ctx.band.getContract(id);
  if (!r) return { ok: false, error: 'Kontrakt ikke fundet' };
  return { ok: true, contract: serializeContract(r.contract), attendees: r.attendees };
}

/**
 * saveContract. Hele arbejdet ligger i band-objektet som én transaktion —
 * se kommentaren på BandDO.saveContract for de fire faldgruber.
 *
 * Her ligger kun validering og opsummering-opdateringen bagefter.
 */
export async function saveContract(ctx) {
  const { band, p } = ctx;
  const data = p.contract || {};
  const attendees = Array.isArray(p.attendees) ? p.attendees : [];

  if (data.status && !GYLDIGE_STATUS.includes(data.status)) {
    return { ok: false, error: 'Ugyldig status' };
  }

  const r = await band.saveContract(data, attendees, p.originalId, p.expectedUpdatedAt);
  if (!r || !r.ok) return r || { ok: false, error: 'Kunne ikke gemme kontrakten' };

  // Operatørlistens tal holdes ajour uden at den skal fanne ud til N objekter.
  // Fejler det, er kontrakten stadig gemt — statistikken er kosmetisk.
  ctx.reportStats && await ctx.reportStats();

  return { ok: true, id: r.id };
}

export async function changeContractStatus(ctx) {
  const { band, p } = ctx;
  const id = String(p.id || '').trim();
  const status = p.status || 'udkast';
  if (!id) return { ok: false, error: 'Mangler id' };
  if (!GYLDIGE_STATUS.includes(status)) return { ok: false, error: 'Ugyldig status' };
  const r = await band.changeContractStatus(id, status);
  if (!r.ok) return { ok: false, error: 'Kontrakt ikke fundet' };
  ctx.reportStats && await ctx.reportStats();
  return { ok: true };
}

export async function deleteContract(ctx) {
  const { band, p } = ctx;
  const id = String(p.id || '');
  if (!id) return { ok: false, error: 'Mangler id' };
  const r = await band.deleteContract(id);
  if (!r.ok) return { ok: false, error: 'Kontrakt ikke fundet' };
  ctx.reportStats && await ctx.reportStats();
  return { ok: true };
}

/**
 * getDashboard. Aggregeringen sker her frem for i SQL, fordi svarformen skal
 * være identisk med i dag og indeholder tre forskellige udsnit af samme data:
 * statistik, de næste fire jobs med deltagere, og arrangørlisten.
 *
 * Datamængden er ét bands kontrakter — små hundreder i værste fald — så det er
 * billigere at hente én gang og aggregere i hukommelsen end at lave fem
 * separate forespørgsler.
 */
export async function getDashboard(ctx) {
  const { band, member } = ctx;
  const raw = await band.dashboardData(member.id);
  const contracts = raw.contracts.map(serializeContract);
  const nu = Date.now();

  const upcoming = contracts
    .filter(c => c.date && new Date(c.date).getTime() >= nu)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const upcomingIds = new Set(upcoming.map(c => String(c.id)));

  const mitHonorar = raw.attendances
    .filter(a => String(a.memberId) === String(member.id) && upcomingIds.has(String(a.contractId)))
    .reduce((s, a) => s + (Number(a.share) || 0), 0);

  const stats = {
    aktiveKontrakter: contracts.filter(c => c.status !== 'udkast').length,
    bookedHonorar: upcoming.reduce((s, c) => s + (c.honorar || 0), 0),
    mitHonorar,
    aktiveMedlemmer: raw.memberCount,
    afventer: contracts.filter(c => c.status === 'afventer').length
  };

  // Arrangørliste, grupperet på navn.
  const arrMap = new Map();
  for (const c of contracts) {
    const navn = (c.arrangoer && c.arrangoer.name) ? String(c.arrangoer.name).trim() : '';
    if (!navn) continue;
    if (!arrMap.has(navn)) arrMap.set(navn, { name: navn, count: 0, honorar: 0, lastDate: '' });
    const a = arrMap.get(navn);
    a.count++;
    a.honorar += Number(c.honorar) || 0;
    if (c.date && (!a.lastDate || c.date > a.lastDate)) a.lastDate = c.date;
  }
  const arrangoere = [...arrMap.values()].sort((a, b) => b.count - a.count);

  // De næste fire jobs beriges med deltagere til dashboardets popup.
  const memMap = new Map(raw.members.map(m => [String(m.id), m]));
  const top4 = upcoming.slice(0, 4).map(c => {
    const set = new Set();
    const attendees = [];
    for (const a of raw.attendances) {
      if (String(a.contractId) !== String(c.id)) continue;
      const k = String(a.memberId);
      if (set.has(k)) continue;          // dedup, som i originalen
      set.add(k);
      const m = memMap.get(k);
      if (m) attendees.push({
        id: m.id, name: m.name,
        instrument: m.instrument || '', category: m.category || '',
        status: a.status || 'invited'
      });
    }
    return Object.assign({}, c, { attendees });
  });

  return { ok: true, stats, upcoming: top4, arrangoere };
}
