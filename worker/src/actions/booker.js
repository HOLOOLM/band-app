// Fase 3h — booker-portalen.
//
// En booker er en ekstern bookingagent med egen konto, der kan lave tilbud til
// de bands de har adgang til. Adgangslisten er en ALLOW-LIST der fejler lukket:
// har bookeren ikke bandet på sin liste, findes bandet ikke for dem.
//
// Bemærk at et tilbud fra en booker (source:'booker') IKKE har et
// kontraktnummer fra start. Kontrakten oprettes først når arrangøren
// underskriver — se completeBookingSignature i BandDO. Det er derfor
// bookerens tilbud kan afvises uden at efterlade en tom kontraktrække.

import { verifyHash, needsRehash, newPasswordFields, pwIterations, sha256hex }
  from '../lib/crypto.js';
import { issueToken } from '../lib/tokens.js';
import { masterStub, bandStub, fanOut } from '../lib/addressing.js';
import { sendMail, mailConfigured } from '../services/mail.js';
import { genTempPassword } from './members.js';

const BOOKER_TOKEN_TTL_SEC = 8 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SEC = 15 * 60;

/**
 * bookerLogin.
 *
 * Alle afvisningsårsager giver den SAMME besked — ukendt e-mail, forkert kode og
 * en deaktiveret konto må ikke kunne skelnes, ellers kan man afgøre om en
 * bookingagent har en konto hos jer.
 */
export async function bookerLogin(ctx) {
  const { env, p } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  const generisk = 'Forkert email eller adgangskode';
  const master = masterStub(env);

  const st = await master.bookerLoginState(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
  if (st.locked) {
    return { ok: false, error: 'For mange mislykkede forsøg. Prøv igen om 15 minutter.' };
  }

  const fejl = async () => {
    const nu = await master.penalizeBookerLogin(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
    return {
      ok: false,
      error: nu.locked
        ? 'For mange mislykkede forsøg. Prøv igen om 15 minutter.'
        : generisk
    };
  };

  const b = await master.getBooker(email);
  if (!b || (b.status || 'active') !== 'active') return fejl();
  if (!await verifyHash(String(p.passwordHash || ''), b.pwSalt, b.passwordHash)) return fejl();

  const maal = pwIterations(env);
  if (needsRehash(b.passwordHash, maal)) {
    const pf = await newPasswordFields(String(p.passwordHash), maal);
    await master.putBookerPassword(email, pf.passwordHash, pf.pwSalt, b.forcePasswordChange);
  }

  await master.clearBookerLoginAttempts(email);
  const token = await issueToken(env, 'booker', { email }, BOOKER_TOKEN_TTL_SEC);
  return {
    ok: true,
    token,
    booker: { email: b.email, name: b.name || '', agency: b.agency || '' },
    forcePasswordChange: !!Number(b.forcePasswordChange)
  };
}

/** Hvilke bands bookeren må se. Kun aktive bands med booking slået til. */
export async function bookerGetBands(ctx) {
  const { env, booker } = ctx;
  const master = masterStub(env);
  const tilladte = await master.bookerBands(booker.email);
  if (!tilladte.length) return { ok: true, bands: [] };

  const rows = await master.listBands();
  const bands = rows
    .filter(r => tilladte.includes(r.bandId))
    .filter(r => r.status === 'active' && Number(r.booking) === 1)
    .map(r => ({ bandId: r.bandId, name: r.name || r.bandId }));
  return { ok: true, bands };
}

/** Bookerens egne tilbud på tværs af de bands de har adgang til. */
export async function bookerListOffers(ctx) {
  const { env, booker } = ctx;
  const tilgaengelige = (await bookerGetBands(ctx)).bands;
  if (!tilgaengelige.length) return { ok: true, offers: [] };

  const svar = await fanOut(env, tilgaengelige.map(b => b.bandId), async (stub, bandId) => {
    const rows = await stub.listBookingsForBooker(booker.email);
    const navn = (tilgaengelige.find(b => b.bandId === bandId) || {}).name || bandId;
    return rows.map(r => Object.assign({}, parseOffer(r), { bandId, bandName: navn }));
  });
  const offers = svar.results.flatMap(x => x.value || []);
  offers.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return { ok: true, offers };
}

function parseOffer(row) {
  const p = (v, f) => { try { return v ? (JSON.parse(v) || f) : f; } catch (e) { return f; } };
  return Object.assign({}, row, {
    contractDraft: p(row.contractDraft, {}),
    bandSignature: p(row.bandSignature, null),
    arrangoerSignature: p(row.arrangoerSignature, null),
    history: p(row.history, [])
  });
}

/** Bygger et kontraktudkast ud fra bookerens formular. Whitelist af felter. */
function draftFraTilbud(offer) {
  const o = offer || {};
  return {
    type: o.type || 'Spillested',
    arrangoer: o.arrangoer || {},
    venue: o.venue || {},
    date: o.date ? String(o.date).slice(0, 10) : '',
    getIn: String(o.getIn || ''), soundcheck: String(o.soundcheck || ''),
    showtimeFrom: String(o.showtimeFrom || ''), showtimeTo: String(o.showtimeTo || ''),
    sets: Number(o.sets) || 0, setMinutes: Number(o.setMinutes) || 0,
    musicianCount: Number(o.musicianCount) || 0,
    crewCount: Number(o.crewCount) || 0,
    guestCount: Number(o.guestCount) || 0,
    honorar: Number(o.honorar) || 0,
    paymentTerms: String(o.paymentTerms || ''),
    paymentTermsOther: String(o.paymentTermsOther || ''),
    notes: String(o.notes || '')
    // memberNote er bevidst ikke med: den er bandintern, og en booker skal
    // hverken kunne læse eller skrive den.
  };
}

/** Har bookeren adgang til bandet? Fejler lukket. */
async function harAdgang(env, booker, bandId) {
  if (!bandId) return false;
  const tilladte = await masterStub(env).bookerBands(booker.email);
  if (!tilladte.includes(bandId)) return false;
  const row = await masterStub(env).getBand(bandId);
  return !!(row && row.status === 'active' && Number(row.booking) === 1);
}

/** Finder bookerens eget tilbud. Andres tilbud findes ikke for dem. */
async function findEgetTilbud(env, booker, offerId) {
  const bands = (await bookerGetBands({ env, booker })).bands;
  for (const b of bands) {
    const stub = bandStub(env, b.bandId);
    const row = await stub.getBooking(offerId);
    // Ejerskabstjekket er det afgørende: uden det kunne en booker gætte et
    // id og redigere et andet bureaus tilbud i samme band.
    if (row && String(row.bookerId) === String(booker.email)) {
      return { band: stub, bandId: b.bandId, row };
    }
  }
  return null;
}

export async function bookerSaveOffer(ctx) {
  const { env, booker, p } = ctx;
  const offerId = String(p.offerId || '').trim();
  const draft = draftFraTilbud(p.offer);
  const arr = draft.arrangoer || {};

  if (offerId) {
    const f = await findEgetTilbud(env, booker, offerId);
    if (!f) return { ok: false, error: 'Tilbud ikke fundet' };
    if (f.row.status !== 'draft') return { ok: false, error: 'Kun kladder kan redigeres' };
    await f.band.updateBooking(offerId, {
      contractDraft: JSON.stringify(draft),
      arrangoerName: arr.contactName || arr.name || '',
      arrangoerEmail: String(arr.email || '').trim(),
      updatedAt: new Date().toISOString()
    });
    return { ok: true, offerId };
  }

  const bandId = String(p.bandId || '').trim();
  if (!await harAdgang(env, booker, bandId)) {
    return { ok: false, error: 'Ingen adgang til dette band' };
  }
  const nu = new Date().toISOString();
  const r = await bandStub(env, bandId).createBooking({
    bookerId: booker.email, source: 'booker', status: 'draft',
    contractDraft: JSON.stringify(draft),
    arrangoerName: arr.contactName || arr.name || '',
    arrangoerEmail: String(arr.email || '').trim(),
    docHash: '', tokenExp: '', bandSignature: '', arrangoerSignature: '',
    declineReason: '', contractId: '', pdfFileId: '',
    history: JSON.stringify([{
      ts: nu, actor: booker.email, from: '', to: 'draft', note: 'Kladde oprettet af booker'
    }]),
    createdAt: nu, updatedAt: nu
  });
  return { ok: true, offerId: r.id, bandId };
}

/** Sender tilbuddet til bandet. Herefter kan bookeren ikke redigere det. */
export async function bookerSendOffer(ctx) {
  const { env, booker, p } = ctx;
  const offerId = String(p.offerId || '').trim();
  if (!offerId) return { ok: false, error: 'offerId mangler' };
  const f = await findEgetTilbud(env, booker, offerId);
  if (!f) return { ok: false, error: 'Tilbud ikke fundet' };

  let draft = {};
  try { draft = JSON.parse(f.row.contractDraft || '{}') || {}; } catch (e) {}
  const email = String((draft.arrangoer && draft.arrangoer.email) || f.row.arrangoerEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Arrangørens e-mail mangler eller er ugyldig' };
  }

  const aktor = booker.email + ' (' + (booker.agency || 'booker') + ')';
  const t = await f.band.transitionBooking(offerId, ['draft'], 'sent', aktor, 'Sendt til band', {});
  if (!t.ok) return t;

  try {
    const s = await f.band.getSettings();
    const til = await f.band.adminEmails();
    if (til.length && mailConfigured(env)) {
      const afsender = booker.agency || booker.name || booker.email;
      const venue = (draft.venue && draft.venue.name) || '';
      await sendMail(env, {
        to: til.join(','),
        subject: 'Nyt bookingtilbud fra ' + afsender,
        html: '<p>Der er modtaget et nyt bookingtilbud' +
              (venue ? ' vedr. <strong>' + esc(venue) + '</strong>' : '') +
              ' fra <strong>' + esc(afsender) + '</strong>. Log ind i appen for at se og godkende det.</p>',
        text: 'Nyt bookingtilbud fra ' + afsender + '. Log ind i appen for at se det.'
      });
    }
  } catch (e) {
    console.warn('Kunne ikke sende tilbuds-notifikation: ' + (e && e.message || e));
  }
  return { ok: true, offer: parseOffer(t.booking) };
}

export async function bookerCancelOffer(ctx) {
  const { env, booker, p } = ctx;
  const offerId = String(p.offerId || '').trim();
  if (!offerId) return { ok: false, error: 'offerId mangler' };
  const f = await findEgetTilbud(env, booker, offerId);
  if (!f) return { ok: false, error: 'Tilbud ikke fundet' };
  const t = await f.band.transitionBooking(offerId, ['draft', 'sent'], 'cancelled',
    booker.email, String(p.reason || '').slice(0, 500));
  if (!t.ok) return t;
  return { ok: true, offer: parseOffer(t.booking) };
}

// ── Operatørens administration af bookere ───────────────────────────────────

export async function operatorListBookers(ctx) {
  const rows = await ctx.master.listBookers();
  return { ok: true, bookers: rows };
}

export async function operatorSaveBooker(ctx) {
  const { env, p, operator } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Ugyldig e-mail' };
  const master = masterStub(env);
  const eksisterende = await master.getBooker(email);

  let tempPassword = null;
  if (!eksisterende) {
    tempPassword = genTempPassword();
    const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
    await master.createBooker(email, {
      name: String(p.name || ''), agency: String(p.agency || ''),
      status: 'active',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 1
    });
  } else {
    await master.updateBooker(email, {
      name: p.name !== undefined ? String(p.name) : undefined,
      agency: p.agency !== undefined ? String(p.agency) : undefined,
      status: p.status !== undefined ? String(p.status) : undefined
    });
  }

  if (Array.isArray(p.bandIds)) {
    await master.setBookerBands(email, p.bandIds.map(String));
  }

  await master.audit(operator.email, eksisterende ? 'booker-opdateret' : 'booker-oprettet',
    '', email + (Array.isArray(p.bandIds) ? ' → ' + p.bandIds.join(',') : ''));

  const svar = { ok: true, isNew: !eksisterende };
  // Vises ÉN gang i UI'et; gemmes aldrig i klartekst.
  if (tempPassword) svar.tempPassword = tempPassword;
  return svar;
}

export async function operatorDeleteBooker(ctx) {
  const { env, p, operator } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  if (!email) return { ok: false, error: 'e-mail mangler' };
  await masterStub(env).deleteBooker(email);
  await masterStub(env).audit(operator.email, 'booker-slettet', '', email);
  return { ok: true };
}

export async function operatorResetBookerPassword(ctx) {
  const { env, p, operator } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  const master = masterStub(env);
  if (!await master.getBooker(email)) return { ok: false, error: 'Booker ikke fundet' };
  const tempPassword = genTempPassword();
  const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
  await master.putBookerPassword(email, pf.passwordHash, pf.pwSalt, 1);
  await master.audit(operator.email, 'booker-password-nulstillet', '', email);
  return { ok: true, tempPassword };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
