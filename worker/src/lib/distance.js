// Køreafstand for ét job.
//
// DEN ARKITEKTURÆNDRING DER BETYDER MEST HER: i Apps Script beregner og SKRIVER
// _ensureDistance (Code.gs:516) afstande midt på læsestien. Det betyder at
// getJobs og getMyHonorar tager skrivelåsen, blot fordi et medlem åbner sin
// jobliste — og med én global LockService-lås blokerede det alle andre bands
// samtidig.
//
// Her beregnes afstand KUN ved skrivning: når medlemmet retter sin
// hjemmeadresse, sætter en alternativ startadresse, slår tur/retur til eller
// fra, eller klikker "beregn km". Læsestien laver rene SELECT og returnerer den
// cachede værdi eller tom streng. Har en attendance ingen afstand, viser
// frontenden "beregner…" og tilbyder knappen — den findes allerede
// (07-calendar-pdf.js:463).

import { callSidecar, sidecarConfigured } from '../services/sidecar.js';

/** Normaliserer en adresse til cache-nøgle og sammenligning. */
export function normalizeAddr(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Kører medlemmet hjem igen efter jobbet? Tomt felt = JA.
 *
 * Tur/retur er standard, og rækker fra før feltet fandtes skal opføre sig som
 * manageren forventer. Port 1:1 af _wantsReturnHome (Code.gs:481).
 */
export function wantsReturnHome(att) {
  const v = att && att.returnHome;
  if (v === '' || v == null) return true;
  return !(v === false || v === 'false' || v === 0 || v === '0');
}

/** Spillestedets adresse ud af kontraktens venue-JSON. */
export function venueAddress(contract) {
  if (!contract) return '';
  let v = contract.venue;
  if (typeof v === 'string') {
    try { v = JSON.parse(v || '{}'); } catch (e) { v = {}; }
  }
  if (!v) return '';
  return [v.address, [v.postnr, v.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
}

/**
 * Ét opslag med cache. Cachen ligger i bandets eget objekt.
 *
 * Maps-kvoten er den knappe ressource, så et cache-hit skal helst ramme: to
 * medlemmer der bor samme sted og kører til samme spillested, skal kun koste
 * ét opslag.
 */
async function lookupKm(env, band, origin, destination) {
  if (!origin || !destination) return null;
  const key = normalizeAddr(origin) + '|' + normalizeAddr(destination);

  const cached = await band.getDistanceCache(key);
  if (cached !== null && cached !== undefined) return cached;

  if (!sidecarConfigured(env)) return null;
  let km = null;
  try {
    const r = await callSidecar(env, 'calcDistance', { origin, destination });
    km = (r && typeof r.km === 'number') ? r.km : null;
  } catch (e) {
    // Et fejlet opslag må ikke vælte handlingen. Vi cacher IKKE en fejl —
    // næste forsøg skal have en ny chance.
    console.warn('Afstandsopslag fejlede: ' + (e && e.message || e));
    return null;
  }
  if (km !== null) await band.putDistanceCache(key, origin, destination, km);
  return km;
}

/**
 * Samlet kørsel for ét job. Port af _calcTripKm (Code.gs:497).
 *
 * Tre tilfælde:
 *   1. Uden hjemtur          → origin → spillested (én vej)
 *   2. Hjemtur, start hjemme → 2 × (hjem → spillested)
 *   3. Hjemtur, start andet sted → (A → spillested) + (spillested → hjem)
 *
 * Tilfælde 2 fordobler frem for at slå returruten op: kørselsafstand er i
 * praksis symmetrisk for samme adressepar, og det sparer et Maps-opslag pr.
 * medlem pr. job. Tilfælde 3 KAN ikke fordobles — A→spillested og
 * spillested→hjem er to forskellige ruter.
 */
export async function calcTripKm(env, band, origin, venueAddr, homeAddr, returnHome) {
  const outKm = await lookupKm(env, band, origin, venueAddr);
  if (outKm === null) return null;

  if (!returnHome) {
    return { km: outKm, outKm, backKm: '', roundTrip: false };
  }

  const startErHjemme = !homeAddr || normalizeAddr(homeAddr) === normalizeAddr(origin);
  if (startErHjemme) {
    return { km: Math.round(outKm * 2 * 10) / 10, outKm, backKm: outKm, roundTrip: true };
  }

  const backKm = await lookupKm(env, band, venueAddr, homeAddr);
  // Returruten kunne ikke slås op — fald tilbage på udturen frem for at tabe
  // hjemturen helt, og markér den stadig som tur/retur.
  if (backKm === null) {
    return { km: Math.round(outKm * 2 * 10) / 10, outKm, backKm: outKm, roundTrip: true };
  }
  return { km: Math.round((outKm + backKm) * 10) / 10, outKm, backKm, roundTrip: true };
}

/**
 * Beregner og GEMMER afstanden for én attendance. Kaldes udelukkende fra
 * skrivestier — se filkommentaren.
 *
 * Returnerer det gemte resultat, eller {km:''} hvis der ikke kunne beregnes.
 * Fejler bevidst ikke: en manglende afstand er en tom kolonne i UI'et med en
 * knap ved siden af, ikke en fejlbesked.
 */
export async function computeAndStoreDistance(env, band, att, contract, homeAddr) {
  const origin = att.startAddress || homeAddr || '';
  const wantRT = wantsReturnHome(att);
  const venueAddr = venueAddress(contract);

  if (!origin || !venueAddr) {
    await band.setAttendanceDistance(att.id, '', origin, wantRT);
    return { km: '', origin, roundTrip: wantRT };
  }

  const r = await calcTripKm(env, band, origin, venueAddr, homeAddr || '', wantRT);
  if (!r) {
    await band.setAttendanceDistance(att.id, '', origin, wantRT);
    return { km: '', origin, roundTrip: wantRT };
  }
  await band.setAttendanceDistance(att.id, r.km, origin, r.roundTrip);
  return { km: r.km, origin, roundTrip: r.roundTrip, outKm: r.outKm, backKm: r.backKm };
}

/**
 * Læser den cachede afstand UDEN at beregne. Bruges på læsestien.
 *
 * Cache-hit kræver både samme origin OG samme tur/retur-valg som tallet blev
 * beregnet med — ellers ville vi vise et km-tal der ikke matcher hakket, hvilket
 * er værre end at vise ingenting.
 */
export function readCachedDistance(att, homeAddr) {
  const oensketOrigin = att.startAddress || homeAddr || '';
  const wantRT = wantsReturnHome(att);
  const gemtKm = (att.distanceKm !== '' && att.distanceKm != null) ? Number(att.distanceKm) : '';
  const gemtOrigin = att.distanceOrigin || '';
  const gemtRT = (att.distanceRoundTrip === true || att.distanceRoundTrip === 'true' ||
                  att.distanceRoundTrip === 1);

  if (gemtKm !== '' && gemtOrigin && gemtOrigin === oensketOrigin && gemtRT === wantRT) {
    return { km: gemtKm, origin: gemtOrigin, roundTrip: gemtRT };
  }
  return { km: '', origin: oensketOrigin, roundTrip: wantRT };
}
