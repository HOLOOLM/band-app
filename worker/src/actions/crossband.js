// Fase 3k — kryds-band og iCal-feed.
//
// Kryds-band er en betalt feature pr. band: en musiker med samme e-mail i flere
// bands kan se alle sine jobs og honorar samlet, men KUN fra de bands hvor
// operatøren har slået `crossBand` til.
//
// Fan-out'en går til N band-objekter parallelt, hvor N er antallet af bands DEN
// ENE musiker er med i — 1-3 i praksis, ikke antallet af bands i systemet. Det
// er derfor den er acceptabel; se lib/addressing.js.

import { masterStub, bandStub, fanOut } from '../lib/addressing.js';
import { verifyMember } from '../auth/verify.js';
import { getJobs } from './jobs.js';
import { getMyHonorar } from './honorar.js';
import { randomId, constTimeEq } from '../lib/crypto.js';
import { ALL_SETTINGS_KEYS } from '../lib/settings-defaults.js';

/**
 * Let branding pr. band til de tværgående visninger: navn, kortnavn, accentfarve
 * og et lille logo.
 *
 * Logoet springes over hvis det er stort. I en tværgående visning står der tre
 * logoer side om side i en liste, og at trække tre fulde data-URL'er ville koste
 * mere end den visuelle gevinst — frontenden viser en farvet chip i stedet.
 */
const LOGO_LITE_MAX = 60000;

async function bandBrand(env, bandId, navn) {
  const band = bandStub(env, bandId);
  const s = await band.getSettings();
  let logo = '';
  try {
    const a = await band.getAsset('logo');
    if (a && a.dataUrl && a.dataUrl.length <= LOGO_LITE_MAX) logo = a.dataUrl;
  } catch (e) { /* logoet er pynt — en fejl her må ikke vælte listen */ }
  return {
    bandId,
    bandName: s.bandName || navn || bandId,
    bandShortName: s.bandShortName || '',
    bandColor: s.primaryColor || '#8A8A8A',
    bandLogo: logo
  };
}

/**
 * Kører en band-scoped action i hvert af musikerens crossBand-bands.
 *
 * Autentifikationen sker PR. BAND: musikeren skal være medlem der, og
 * credentials verificeres mod det bands egen række. Et band hvor personen ikke
 * (længere) er medlem, springes over frem for at fejle hele svaret.
 */
async function forHvertBand(env, creds, fn) {
  const master = masterStub(env);
  const bandIds = await master.bandsForIdentity(creds.email, true);
  if (!bandIds.length) return { bands: [], resultater: [] };

  const rows = await master.listBands();
  const navne = new Map(rows.map(r => [r.bandId, r.name]));

  const svar = await fanOut(env, bandIds, async (stub, bandId) => {
    const m = await verifyMember(env, stub, creds.email, creds.token);
    if (!m) return null;                       // ikke medlem her — spring over
    const brand = await bandBrand(env, bandId, navne.get(bandId));
    const r = await fn({ env, band: stub, bandId, member: m, p: {} });
    return { brand, r };
  });

  if (svar.failed.length) {
    console.warn('Kryds-band: ' + svar.failed.length + ' band(s) svarede ikke: ' +
                 svar.failed.map(f => f.bandId).join(', '));
  }
  return {
    bands: svar.results.map(x => x.value).filter(Boolean).map(v => v.brand),
    resultater: svar.results.map(x => x.value).filter(Boolean)
  };
}

/** getAllJobs — musikerens jobs på tværs af bands. */
export async function getAllJobs(ctx) {
  const { env, creds } = ctx;
  const { bands, resultater } = await forHvertBand(env, creds, getJobs);
  const jobs = [];
  for (const { brand, r } of resultater) {
    if (!r || !r.ok || !r.jobs) continue;
    for (const j of r.jobs) {
      jobs.push(Object.assign({}, j, {
        bandId: brand.bandId, bandName: brand.bandName,
        bandShortName: brand.bandShortName, bandColor: brand.bandColor,
        bandLogo: brand.bandLogo
      }));
    }
  }
  jobs.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { ok: true, jobs, bands, bandCount: bands.length };
}

/** getAllHonorar — musikerens honorar på tværs af bands. */
export async function getAllHonorar(ctx) {
  const { env, creds, p } = ctx;
  const { bands, resultater } = await forHvertBand(env, creds,
    c => getMyHonorar(Object.assign({}, c, { p: { fra: p.fra, til: p.til } })));
  const rows = [];
  let total = 0, totalKm = 0;
  for (const { brand, r } of resultater) {
    if (!r || !r.ok || !r.rows) continue;
    for (const row of r.rows) {
      rows.push(Object.assign({}, row, {
        bandId: brand.bandId, bandName: brand.bandName,
        bandShortName: brand.bandShortName, bandColor: brand.bandColor
      }));
    }
    total += r.total || 0;
    totalKm += r.totalKm || 0;
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return {
    ok: true, rows, bands, bandCount: bands.length,
    total, totalKm: Math.round(totalKm * 10) / 10
  };
}

// ── iCal-feed ───────────────────────────────────────────────────────────────

/**
 * Hvilket band handler feed-kaldet om?
 *
 * Routeren gater `admin` mod `p.bandId` og sætter `ctx.bandId` derfra. Disse to
 * actions læste `p.targetBandId` — et FELT DER ALDRIG BLEV GATET. En admin i
 * band X kunne dermed sende `{bandId:"band-x", targetBandId:"band-y"}` og få
 * band Y's feedToken udleveret (og med det hele deres gigkalender med
 * adresser, get-in og noter), eller rotere det og ødelægge alle deres
 * kalenderabonnementer.
 *
 * `targetBandId` findes udelukkende for operatørpanelet, som administrerer
 * andre bands på deres vegne (se opBandFeed i public/js/09-boot.js). Derfor
 * accepteres feltet nu kun når kalderen faktisk ER operatør; en band-admin får
 * altid sit eget band, uanset hvad de sender.
 */
function feedBandId(ctx) {
  const { p } = ctx;
  if (ctx.operator) {
    const maal = String(p.targetBandId || '').trim();
    if (maal) return maal;
  }
  return String(ctx.bandId || '').trim();
}

/** Feed-tokenet ligger i bandets egne settings, så feedet kan læses uden master. */
export async function getFeedUrl(ctx) {
  const { env } = ctx;
  const bandId = feedBandId(ctx);
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  const band = bandStub(env, bandId);
  const token = await hentEllerLavFeedToken(band);
  return { ok: true, token, bandId };
}

export async function rotateFeedToken(ctx) {
  const { env } = ctx;
  const bandId = feedBandId(ctx);
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  const band = bandStub(env, bandId);
  const token = randomId(24);
  await band.putSettings({ feedToken: token }, ALL_SETTINGS_KEYS.concat(['feedToken']));
  try {
    await masterStub(env).audit(
      ctx.operator ? ctx.operator.email : (ctx.member ? ctx.member.email : 'system'),
      'feed-token-fornyet', bandId, '');
  } catch (e) { /* audit må ikke vælte handlingen */ }
  return { ok: true, token, bandId };
}

async function hentEllerLavFeedToken(band) {
  const s = await band.getSettings();
  if (s.feedToken) return s.feedToken;
  const token = randomId(24);
  await band.putSettings({ feedToken: token }, ALL_SETTINGS_KEYS.concat(['feedToken']));
  return token;
}

function icalEsc(s) {
  return String(s == null ? '' : s)
    // \r fjernes helt: en enlig CR kunne folde en linje i DESCRIPTION og dermed
    // injicere en iCal-egenskab. \n escapes som RFC 5545 foreskriver.
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * Findes bandet i masters bandliste?
 *
 * Fejler LUKKET: kan master ikke svare, behandles bandet som ukendt. Et tomt
 * kalendersvar er langt at foretrække frem for at oprette et Durable Object på
 * et navn en fremmed har fundet på.
 */
async function bandFindes(env, bandId) {
  try {
    return !!await masterStub(env).getBand(bandId);
  } catch (e) {
    console.error('Bandopslag fejlede for ' + bandId + ': ' + (e && e.message || e));
    return false;
  }
}
function icalDate(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}
function icalDateTime(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  // Flydende lokaltid (uden Z) — vises i abonnentens lokale tid, hvilket passer
  // til faste klokkeslæt som "show kl. 21".
  return icalDate(d) + 'T' + p(d.getHours()) + p(d.getMinutes()) + '00';
}

/**
 * Bygger iCal-feedet. Kaldes fra Workerens GET /ical-rute, ikke gennem
 * /api/call — et kalenderprogram kan ikke sende POST med cookie.
 *
 * Tomt svar ved ugyldigt token, IKKE en fejl: et kalenderprogram der får 401
 * viser en larmende fejl til brugeren, og vi vil ikke afsløre om bandet findes.
 * Sammenligningen er konstant-tid.
 *
 * memberNote er BEVIDST udeladt af DESCRIPTION. Feedet kan abonneres af enhver
 * med linket, og noten er admins interne besked til bandet.
 */
export async function buildIcal(env, bandId, token) {
  const tom = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
  if (!bandId) return tom;

  let band, settings;
  try {
    // Slå bandet op i master FØR bandStub() kaldes.
    //
    // `idFromName()` opretter objektet ved første berøring, og #ready() lægger
    // 24 tabeller i det permanent. Uden dette opslag kunne en anonym med
    // `for i in $(seq 1 100000); do curl ".../ical?band=x$i"; done` efterlade
    // 100.000 tomme SQLite-databaser på kontoen — objekter der ikke står i
    // masters bandliste og derfor aldrig ryddes op af cron'en.
    if (!await bandFindes(env, bandId)) return tom;
    band = bandStub(env, bandId);
    settings = await band.getSettings();
  } catch (e) {
    return tom;
  }
  const forventet = String(settings.feedToken || '');
  if (!forventet || !constTimeEq(String(token || ''), forventet)) return tom;

  const calName = (settings.bandName || bandId) + ' – gigs';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Band-app//Gigs//DA',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icalEsc(calName), 'X-WR-TIMEZONE:Europe/Copenhagen'
  ];

  for (const c of await band.listContracts()) {
    if (!c.date) continue;
    const day = new Date(c.date);
    if (isNaN(day.getTime())) continue;
    let venue = {}, arr = {};
    try { venue = JSON.parse(c.venue || '{}') || {}; } catch (e) { venue = {}; }
    try { arr = JSON.parse(c.arrangoer || '{}') || {}; } catch (e) { arr = {}; }

    const title = venue.name || arr.name || c.type || 'Gig';
    const loc = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    const desc = [];
    if (c.getIn) desc.push('Get-in: ' + c.getIn);
    if (c.soundcheck) desc.push('Soundcheck: ' + c.soundcheck);
    if (c.showtimeFrom) desc.push('Show: ' + c.showtimeFrom + (c.showtimeTo ? '–' + c.showtimeTo : ''));
    if (c.notes) desc.push(String(c.notes));

    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + bandId + '-' + c.id + '@band-app');
    lines.push('SUMMARY:' + icalEsc(title));

    const t = /^(\d{1,2}):(\d{2})$/.exec(String(c.showtimeFrom || '').trim());
    if (t) {
      const start = new Date(day);
      start.setHours(Number(t[1]), Number(t[2]), 0, 0);
      const te = /^(\d{1,2}):(\d{2})$/.exec(String(c.showtimeTo || '').trim());
      const end = new Date(start);
      if (te) {
        end.setHours(Number(te[1]), Number(te[2]), 0, 0);
        // Slutter showet efter midnat, er sluttidspunktet næste dag.
        if (end <= start) end.setDate(end.getDate() + 1);
      } else {
        end.setHours(end.getHours() + 2);
      }
      lines.push('DTSTART:' + icalDateTime(start));
      lines.push('DTEND:' + icalDateTime(end));
    } else {
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      lines.push('DTSTART;VALUE=DATE:' + icalDate(day));
      lines.push('DTEND;VALUE=DATE:' + icalDate(next));
    }
    if (loc) lines.push('LOCATION:' + icalEsc(loc));
    if (desc.length) lines.push('DESCRIPTION:' + icalEsc(desc.join('\n')));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
