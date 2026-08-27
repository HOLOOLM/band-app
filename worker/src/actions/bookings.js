// Fase 3g — bookings og e-signatur.
//
// Sikkerhedsmodellen er bevaret 1:1 fra BOOKING-PLAN.md, og hvert punkt er der
// af en grund:
//
// - ALT gates af bandets `booking`-flag, både de autentificerede actions og de
//   offentlige. Slås featuren fra midt i et forløb, holder udestående links op
//   med at virke.
// - Signeringstokenet (`bk:`) har sin egen rolle 'arr-sign'. Et medlems- eller
//   operatør-token kan aldrig bruges her, og omvendt — det håndhæves af
//   verifyToken, som kræver at rollen matcher.
// - Tokenet er bundet til et docHash af kontraktens INDHOLD, ikke af renderet
//   HTML. HTML er skrøbeligt over for logo-caching og renderingsdrift; indholdet
//   er ikke. Matcher hashen ikke, afvises signeringen.
// - ALLE fejl på det offentlige flow er bevidst IDENTISKE: "Linket er ugyldigt
//   eller udløbet." Uanset om årsagen er forkert signatur, udløb, forkert
//   docHash, forkert status eller ukendt booking. Ellers ville fejlbeskeden være
//   et orakel man kunne udspørge.

import { sha256hex, constTimeEq } from '../lib/crypto.js';
import { issueToken, verifyToken } from '../lib/tokens.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { sendMail, mailConfigured } from '../services/mail.js';
import { userError, SIGNING_REJECT_MESSAGE } from '../lib/errors.js';

const BOOKING_TOKEN_TTL_SEC = 14 * 24 * 60 * 60;   // 14 dage

// Bump denne hvis kontraktens JURIDISKE indhold ændres. Det gør udestående
// docHashes bevidst ugyldige, så ingen kan underskrive en gammel formulering.
const DOC_TEMPLATE_VERSION = 1;

// Samme besked for alle afvisninger på det offentlige flow — delt med routerens
// 'signing'-gate, som afviser uafhængigt af denne. Se lib/errors.js.
const OFFENTLIG_FEJL = SIGNING_REJECT_MESSAGE;

/**
 * Deterministisk JSON med sorterede nøgler, så samme kontraktindhold ALTID
 * giver samme hash uanset i hvilken rækkefølge felterne blev bygget.
 */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj === undefined ? null : obj);
  }
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

async function computeDocHash(draft) {
  return sha256hex(canonicalJson(draft) + '|v' + DOC_TEMPLATE_VERSION);
}

function parseBooking(row) {
  const p = (v, fallback) => {
    if (!v) return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  };
  return Object.assign({}, row, {
    contractDraft: p(row.contractDraft, {}),
    bandSignature: p(row.bandSignature, null),
    arrangoerSignature: p(row.arrangoerSignature, null),
    history: p(row.history, [])
  });
}

/** Er booking slået til for bandet? Fejler LUKKET. */
async function bookingEnabled(band) {
  try {
    const st = await band.status();
    const v = st.meta && st.meta.booking;
    return v === '1' || v === 'true' || v === 1;
  } catch (e) {
    return false;
  }
}

function signingUrl(appOrigin, token) {
  const base = String(appOrigin || '').replace(/\/+$/, '');
  return base + '/sign?t=' + encodeURIComponent(token);
}

// ── Bandets side af forløbet (kræver admin) ─────────────────────────────────

export async function sendContractForSigning(ctx) {
  const { env, band, member, p } = ctx;
  if (!await bookingEnabled(band)) {
    return { ok: false, error: 'Booking & e-signatur er ikke aktiveret for dette band' };
  }
  const contractId = String(p.contractId || '').trim();
  if (!contractId) return { ok: false, error: 'contractId mangler' };

  const r = await band.getContract(contractId);
  if (!r) return { ok: false, error: 'Kontrakt ikke fundet' };
  if (String(r.contract.status) === 'godkendt') {
    return { ok: false, error: 'Kontrakten er allerede godkendt' };
  }
  if (await band.activeBookingFor(contractId)) {
    return { ok: false, error: 'Der er allerede et aktivt underskriftsforløb for denne kontrakt' };
  }

  const c = r.contract;
  let arrangoer = {}, venue = {};
  try { arrangoer = JSON.parse(c.arrangoer || '{}') || {}; } catch (e) {}
  try { venue = JSON.parse(c.venue || '{}') || {}; } catch (e) {}

  const email = String(arrangoer.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      ok: false,
      error: 'Arrangørens e-mail mangler eller er ugyldig — udfyld den på kontrakten først'
    };
  }

  // memberNote er bandintern info til musikerne (parkering, dresscode,
  // vurderinger af stedet). Den må ALDRIG ind i booking-snapshottet: draften
  // sendes videre til arrangøren og indgår i docHash.
  const draft = {
    id: c.id, type: c.type, status: c.status,
    arrangoer, venue,
    date: c.date ? new Date(c.date).toISOString() : '',
    getIn: c.getIn || '', soundcheck: c.soundcheck || '',
    showtimeFrom: c.showtimeFrom || '', showtimeTo: c.showtimeTo || '',
    sets: Number(c.sets) || 0, setMinutes: Number(c.setMinutes) || 0,
    musicianCount: Number(c.musicianCount) || 0,
    crewCount: Number(c.crewCount) || 0,
    guestCount: Number(c.guestCount) || 0,
    honorar: Number(c.honorar) || 0,
    paymentTerms: c.paymentTerms || '', paymentTermsOther: c.paymentTermsOther || '',
    notes: c.notes || ''
  };

  const nu = new Date().toISOString();
  const created = await band.createBooking({
    bookerId: '', source: 'band', status: 'sent',
    contractDraft: JSON.stringify(draft),
    arrangoerName: arrangoer.contactName || arrangoer.name || '',
    arrangoerEmail: email,
    docHash: '', tokenExp: '', bandSignature: '', arrangoerSignature: '',
    declineReason: '', contractId, pdfFileId: '',
    history: JSON.stringify([{
      ts: nu, actor: member.email, from: '', to: 'sent',
      note: 'Oprettet af band — klar til godkendelse'
    }]),
    createdAt: nu, updatedAt: nu
  });

  await audit(ctx, 'booking-sent', created.id);
  return { ok: true, bookingId: created.id };
}

export async function listIncomingBookings(ctx) {
  const { band } = ctx;
  // Tom liste frem for en fejl når featuren er slukket: UI'et skal blot ikke
  // vise noget, ikke vise en fejlbesked.
  if (!await bookingEnabled(band)) return { ok: true, bookings: [] };
  const rows = await band.listBookings();
  return { ok: true, bookings: rows.map(parseBooking) };
}

/**
 * Bandet godkender og underskriver. Herefter sendes signeringslinket til
 * arrangøren.
 *
 * docHash beregnes HER og fastlåses. Tokenet bindes til den — så det link
 * arrangøren får, gælder præcis dette indhold.
 */
export async function approveAndSignBooking(ctx) {
  const { env, band, bandId, member, p } = ctx;
  if (!await bookingEnabled(band)) {
    return { ok: false, error: 'Booking & e-signatur er ikke aktiveret for dette band' };
  }
  const bookingId = String(p.bookingId || '').trim();
  const typedName = String(p.typedName || '').trim();
  if (!bookingId) return { ok: false, error: 'bookingId mangler' };
  if (!typedName) return { ok: false, error: 'Indtast dit navn for at underskrive' };

  const row = await band.getBooking(bookingId);
  if (!row) return { ok: false, error: 'Booking ikke fundet' };
  if (p.expectedUpdatedAt && row.updatedAt &&
      Date.parse(row.updatedAt) > Date.parse(p.expectedUpdatedAt)) {
    return { ok: false, conflict: true,
             error: 'Denne booking er blevet ændret imens — genindlæs siden.' };
  }
  if (row.status !== 'sent') return { ok: false, error: 'Kan kun godkendes fra status "sendt"' };

  let draft = {};
  try { draft = JSON.parse(row.contractDraft || '{}') || {}; } catch (e) {}
  const docHash = await computeDocHash(draft);
  const exp = Date.now() + BOOKING_TOKEN_TTL_SEC * 1000;
  const token = await issueToken(env, 'arr-sign',
    { bookingId, bandId, docHash, v: 1 }, BOOKING_TOKEN_TTL_SEC);

  const bandSignature = {
    name: typedName, email: member.email, ts: new Date().toISOString(),
    ip: String(p.clientIp || '').trim(),
    ua: String(p.userAgent || '').slice(0, 200),
    docHash
  };

  const t = await band.transitionBooking(bookingId, ['sent'], 'band_signed',
    member.email, 'Godkendt og underskrevet af band', {
      docHash,
      tokenExp: new Date(exp).toISOString(),
      bandSignature: JSON.stringify(bandSignature)
    });
  if (!t.ok) return t;

  // Fire-and-forget. En mislykket mail må ALDRIG fortryde en gennemført
  // underskrift — derfor logges fejlen og handlingen lykkes alligevel, med et
  // felt der lader UI'et vise linket manuelt.
  let mailSendt = false;
  const url = signingUrl(p.appOrigin, token);
  try {
    const s = await band.getSettings();
    await sendMail(env, {
      to: row.arrangoerEmail,
      subject: 'Kontrakt til underskrift — ' + (s.bandName || bandId),
      html: signeringsMailHtml(s, draft, url),
      text: 'Kontrakt til underskrift: ' + url
    });
    mailSendt = true;
  } catch (e) {
    console.warn('Kunne ikke sende signeringsmail: ' + (e && e.message || e));
  }

  await audit(ctx, 'booking-band_signed', bookingId);
  return {
    ok: true, booking: parseBooking(t.booking), mailSendt,
    // Linket returneres, så admin kan sende det manuelt hvis mailen fejlede.
    signUrl: mailSendt ? undefined : url
  };
}

export async function declineBooking(ctx) {
  const { band, member, p } = ctx;
  if (!await bookingEnabled(band)) {
    return { ok: false, error: 'Booking & e-signatur er ikke aktiveret for dette band' };
  }
  const bookingId = String(p.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'bookingId mangler' };
  const reason = String(p.reason || '').trim().slice(0, 500);
  const t = await band.transitionBooking(bookingId, ['sent'], 'band_declined',
    member.email, reason, { declineReason: reason });
  if (!t.ok) return t;
  await audit(ctx, 'booking-band_declined', bookingId + (reason ? ' — ' + reason : ''));
  return { ok: true, booking: parseBooking(t.booking) };
}

export async function cancelBooking(ctx) {
  const { band, member, p } = ctx;
  if (!await bookingEnabled(band)) {
    return { ok: false, error: 'Booking & e-signatur er ikke aktiveret for dette band' };
  }
  const bookingId = String(p.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'bookingId mangler' };
  const t = await band.transitionBooking(bookingId, ['sent', 'band_signed'], 'cancelled',
    member.email, String(p.reason || '').slice(0, 500));
  if (!t.ok) return t;
  await audit(ctx, 'booking-cancelled', bookingId);
  return { ok: true, booking: parseBooking(t.booking) };
}

/**
 * Gensender signeringslinket. Udsteder et NYT token med ny udløbstid, men samme
 * docHash — indholdet er uændret, det er kun linkets levetid der fornyes.
 */
export async function resendSigningLink(ctx) {
  const { env, band, bandId, member, p } = ctx;
  if (!await bookingEnabled(band)) {
    return { ok: false, error: 'Booking & e-signatur er ikke aktiveret for dette band' };
  }
  const bookingId = String(p.bookingId || '').trim();
  const row = await band.getBooking(bookingId);
  if (!row) return { ok: false, error: 'Booking ikke fundet' };
  if (row.status !== 'band_signed') {
    return { ok: false, error: 'Kan kun gensendes når bandet har underskrevet og der afventes arrangøren' };
  }

  const exp = Date.now() + BOOKING_TOKEN_TTL_SEC * 1000;
  const token = await issueToken(env, 'arr-sign',
    { bookingId, bandId, docHash: row.docHash, v: 1 }, BOOKING_TOKEN_TTL_SEC);
  await band.setBookingTokenExp(bookingId, new Date(exp).toISOString());
  await audit(ctx, 'booking-link-gensendt', bookingId);

  const url = signingUrl(p.appOrigin, token);
  let mailSendt = false;
  try {
    const s = await band.getSettings();
    let draft = {};
    try { draft = JSON.parse(row.contractDraft || '{}') || {}; } catch (e) {}
    await sendMail(env, {
      to: row.arrangoerEmail,
      subject: 'Påmindelse: Kontrakt til underskrift — ' + (s.bandName || bandId),
      html: signeringsMailHtml(s, draft, url),
      text: 'Påmindelse — kontrakt til underskrift: ' + url
    });
    mailSendt = true;
  } catch (e) {
    console.warn('Kunne ikke gensende signeringsmail: ' + (e && e.message || e));
  }
  return { ok: true, mailSendt, signUrl: mailSendt ? undefined : url };
}

// ── Arrangørens side: OFFENTLIGT flow, kun et bk:-token ─────────────────────

/**
 * Fælles validering af et signeringstoken.
 *
 * Returnerer {band, row, draft} eller null. ALLE afvisningsårsager giver null,
 * og kalderen svarer med den samme besked — se filkommentaren om orakel.
 */
async function validerSigneringstoken(env, tokenRaw) {
  const decoded = await verifyToken(env, 'arr-sign', tokenRaw);
  if (!decoded || !decoded.bookingId || !decoded.bandId) return null;

  const band = bandStub(env, decoded.bandId);

  // Bandet skal være aktivt OG have booking slået til. Slukkes featuren midt i
  // et forløb, holder udestående links op med at virke — det er tilsigtet.
  let st;
  try { st = await band.status(); } catch (e) { return null; }
  const meta = st.meta || {};
  if ((meta.status || 'active') !== 'active') return null;
  if (!(meta.booking === '1' || meta.booking === 'true' || meta.booking === 1)) return null;

  const row = await band.getBooking(decoded.bookingId);
  if (!row) return null;
  // docHash binder tokenet til kontraktens indhold. Konstant-tid, så en
  // næsten-rigtig hash ikke kan findes ved at måle svartiden.
  if (!row.docHash || !constTimeEq(String(row.docHash), String(decoded.docHash || ''))) return null;

  let draft = {};
  try { draft = JSON.parse(row.contractDraft || '{}') || {}; } catch (e) {}
  return { band, bandId: decoded.bandId, row, draft, decoded };
}

export async function getSignableBooking(ctx) {
  const { env, p } = ctx;
  const v = await validerSigneringstoken(env, p.t);
  if (!v) return { ok: false, error: OFFENTLIG_FEJL };

  // Allerede færdig: vis en kvittering frem for en fejl. Arrangøren har måske
  // blot gemt linket og åbner det igen.
  if (v.row.status === 'completed') return { ok: true, status: 'completed' };
  if (v.row.status !== 'band_signed') {
    return { ok: false, error: 'Denne kontrakt kan ikke længere underskrives.' };
  }

  const s = await v.band.getSettings();
  const logo = await v.band.getAsset('logo');
  let bandSignature = null;
  try { bandSignature = JSON.parse(v.row.bandSignature || 'null'); } catch (e) {}

  return {
    ok: true,
    status: 'band_signed',
    // Selve kontrakt-HTML'en bygges af Fase 3f's renderer. Indtil da sendes
    // dataen, så signeringssiden kan vise aftalen.
    draft: v.draft,
    bandSignature,
    docHash: v.row.docHash,
    bandName: s.bandName || '',
    bandLogo: logo ? logo.dataUrl : '',
    venueName: (v.draft.venue && v.draft.venue.name) || ''
  };
}

/**
 * Arrangøren underskriver. Underskrift OG kontrakt-godkendelse sker atomart
 * inde i band-objektet — se completeBookingSignature for hvorfor.
 */
export async function submitArrangoerSignature(ctx) {
  const { env, p } = ctx;
  const typedName = String(p.typedName || '').trim();
  const v = await validerSigneringstoken(env, p.t);
  if (!v) return { ok: false, error: OFFENTLIG_FEJL };
  if (!typedName) return { ok: false, error: 'Indtast dit navn for at underskrive.' };
  if (v.row.status === 'completed') {
    return { ok: false, error: 'Denne kontrakt er allerede underskrevet.' };
  }
  if (v.row.status !== 'band_signed') {
    return { ok: false, error: 'Denne kontrakt kan ikke længere underskrives.' };
  }

  const arrangoerSignature = {
    name: typedName,
    ts: new Date().toISOString(),
    ip: String(p.clientIp || '').trim(),
    ua: String(p.userAgent || '').slice(0, 200),
    docHash: v.row.docHash
  };

  const r = await v.band.completeBookingSignature(v.decoded.bookingId, arrangoerSignature, v.draft);
  if (!r.ok) return r;

  // Notifikation til bandets admins. Fire-and-forget.
  try {
    const s = await v.band.getSettings();
    const til = await v.band.adminEmails();
    if (til.length && mailConfigured(env)) {
      await sendMail(env, {
        to: til.join(','),
        subject: 'Kontrakt underskrevet af arrangør — ' + (s.bandName || v.bandId),
        html: '<p>Arrangøren <strong>' + escHtml(typedName) +
              '</strong> har underskrevet kontrakten. Den er nu godkendt.</p>',
        text: 'Arrangøren ' + typedName + ' har underskrevet kontrakten. Den er nu godkendt.'
      });
    }
  } catch (e) {
    console.warn('Kunne ikke sende underskrifts-notifikation: ' + (e && e.message || e));
  }

  try {
    await masterStub(env).audit('arrangør (uden login)', 'booking-completed',
      v.bandId, v.decoded.bookingId);
  } catch (e) { /* audit må ikke vælte en gennemført underskrift */ }

  return { ok: true, status: 'completed', contractId: r.contractId };
}

export async function declineByArrangoer(ctx) {
  const { env, p } = ctx;
  const v = await validerSigneringstoken(env, p.t);
  if (!v) return { ok: false, error: OFFENTLIG_FEJL };
  if (v.row.status !== 'band_signed') {
    return { ok: false, error: 'Denne handling kan ikke udføres længere.' };
  }
  const reason = String(p.reason || '').trim().slice(0, 500);
  const t = await v.band.transitionBooking(v.decoded.bookingId, ['band_signed'],
    'arr_declined', 'arrangør (uden login)', reason, { declineReason: reason });
  if (!t.ok) return { ok: false, error: OFFENTLIG_FEJL };

  try {
    const s = await v.band.getSettings();
    const til = await v.band.adminEmails();
    if (til.length && mailConfigured(env)) {
      await sendMail(env, {
        to: til.join(','),
        subject: 'Kontrakt afvist af arrangør — ' + (s.bandName || v.bandId),
        html: '<p>Arrangøren har afvist kontrakten.' +
              (reason ? ' Begrundelse: ' + escHtml(reason) : '') + '</p>',
        text: 'Arrangøren har afvist kontrakten.' + (reason ? ' Begrundelse: ' + reason : '')
      });
    }
  } catch (e) {
    console.warn('Kunne ikke sende afvisnings-notifikation: ' + (e && e.message || e));
  }
  return { ok: true };
}

// ── Hjælpere ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function signeringsMailHtml(settings, draft, url) {
  const venue = (draft.venue && draft.venue.name) || '';
  const dato = draft.date ? String(draft.date).slice(0, 10) : '';
  return [
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222">',
    '<p>Hej ' + escHtml((draft.arrangoer && (draft.arrangoer.contactName || draft.arrangoer.name)) || '') + ',</p>',
    '<p>' + escHtml(settings.bandName || '') + ' har underskrevet kontrakten' +
      (venue ? ' vedrørende <strong>' + escHtml(venue) + '</strong>' : '') +
      (dato ? ' den <strong>' + escHtml(dato) + '</strong>' : '') + '.</p>',
    '<p>Du kan læse og underskrive den her:</p>',
    '<p><a href="' + escHtml(url) + '" style="background:#0F213C;color:#fff;padding:12px 20px;' +
      'border-radius:6px;text-decoration:none;display:inline-block">Læs og underskriv</a></p>',
    '<p style="font-size:13px;color:#666">Linket er gyldigt i 14 dage. ' +
      'Har du spørgsmål, så svar blot på denne mail.</p>',
    '</div>'
  ].join('');
}

async function audit(ctx, handling, detalje) {
  try {
    const aktor = ctx.member ? ctx.member.email : 'system';
    await masterStub(ctx.env).audit(aktor, handling, ctx.bandId, detalje || '');
  } catch (e) {
    console.warn('Audit-skrivning fejlede (' + handling + '): ' + (e && e.message || e));
  }
}
