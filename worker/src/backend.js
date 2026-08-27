// Omskiftningen fra Apps Script til Durable Objects.
//
// ── HVORFOR EN FLAG OG IKKE ET BIG BANG ─────────────────────────────────────
//
// Planen sagde "big-bang på ren tavle, ingen datamigrering", fordi der ikke var
// live bands. Den forudsætning holder ikke længere: DMDT har rigtige data —
// medlemmer, kontrakter, honorarhistorik — i det Google Sheet som Apps Script
// ejer, og brugeren har sagt at de selv vil flytte dem over.
//
// Skiftede /api/call bare til det nye datalag, ville bandet logge ind og se en
// TOM app. Ikke ødelagt, men tom — og det er umuligt at skelne fra "alt er
// tabt" når man sidder som bandleder søndag aften.
//
// Derfor er skiftet et flag, og det er PR. BAND. Så kan DMDT flyttes når deres
// data er inde, mens andre bands bliver på den gamle sti — eller omvendt. Og
// ruller man tilbage, er det én værdi.
//
// ── SÅDAN SKIFTER MAN ───────────────────────────────────────────────────────
//
//   BACKEND = "sheets"          alle bands på Apps Script (standard)
//   BACKEND = "do"              alle bands på Durable Objects
//   BACKEND = "do:dmdt,test-a"  KUN de nævnte bands på DO, resten på Sheets
//
// Sat som var i wrangler.toml, så et skift er én commit og et deploy — og
// tilbagerulningen er den samme.

import { runAction } from './actions/router.js';

/**
 * Hvilket datalag skal bruges for dette band?
 *
 * Fejler mod SHEETS, ikke mod DO. Et band vi er usikre på, skal ramme den sti
 * hvor deres data ligger nu.
 */
export function usesDurableObjects(env, bandId) {
  const v = String(env.BACKEND || 'sheets').trim();
  if (v === 'do') return true;
  if (v.startsWith('do:')) {
    const liste = v.slice(3).split(',').map(s => s.trim()).filter(Boolean);
    return liste.includes(String(bandId || '').trim());
  }
  return false;
}

/** Kort forklaring til diagnostik og operatør-UI. */
export function backendDescription(env) {
  const v = String(env.BACKEND || 'sheets').trim();
  if (v === 'do') return 'Durable Objects (alle bands)';
  if (v.startsWith('do:')) {
    return 'Durable Objects for: ' + v.slice(3) + ' — øvrige på Apps Script';
  }
  return 'Apps Script / Google Sheets (alle bands)';
}

/**
 * Kører en action mod det nye datalag.
 *
 * `creds` bygges her ud fra sessionen, aldrig ud fra request-body — det er hele
 * grunden til at et medlems-token ikke kan forfalskes ved at lægge det i JSON.
 */
export async function callDurableObjects(env, request, body, sessionData) {
  const creds = sessionData
    ? (sessionData.kind === 'operator' ? { operatorToken: sessionData.operatorToken }
      : sessionData.kind === 'booker' ? { bookerToken: sessionData.bookerToken }
      : { email: sessionData.email, token: sessionData.passwordHash })
    : null;

  // Request-metadata som booking-actions bruger til signaturregistrering og til
  // at bygge signeringslinket. Sat EFTER spread, så en klient ikke kan forfalske
  // sin egen IP eller vores origin.
  const p = Object.assign({}, body, {
    clientIp: request.headers.get('CF-Connecting-IP') || '',
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 200),
    appOrigin: new URL(request.url).origin
  });

  return runAction(env, String(body.action || ''), p, creds);
}
