// Klient mod Apps Script-sidecaren.
//
// Sidecaren beholder de tre ting hvor Google faktisk er en fordel: HTML→PDF via
// Drive-Docs, Drive-arkivering og køreafstand via Maps. Ingen af dem ligger på en
// latenskritisk sti — det er hele forudsætningen for at de må koste et
// netværkshop.
//
// Sidecaren er STATELESS: den har ingen Sheets og ingen Script Properties ud over
// det delte token. Alle data kommer med i request-body.
//
// Fase 4 skriver selve sidecaren. Indtil da svarer callSidecar med en tydelig
// fejl frem for at fejle uforståeligt, og kaldere skal håndtere at den ikke er
// tilgængelig — se hvordan afstandsberegningen returnerer null i stedet for at
// vælte en jobliste.

import { userError } from '../lib/errors.js';

const TIMEOUT_MS = 20000;

export function sidecarConfigured(env) {
  return !!(env.SIDECAR_URL && env.SIDECAR_TOKEN);
}

/**
 * Kalder sidecaren. `op` er operationsnavnet (renderPdf, archivePdf,
 * calcDistance), `payload` alt den har brug for.
 *
 * Tokenet lægges i body og IKKE i en header, fordi Apps Script web apps ikke
 * videregiver egne headers til doPost — samme begrundelse som i det nuværende
 * APP_TOKEN-mønster.
 *
 * Sætter tokenet EFTER spread af payload, så en kalder ikke ved et uheld kan
 * overskrive det med sin egen værdi.
 */
export async function callSidecar(env, op, payload) {
  if (!sidecarConfigured(env)) {
    throw userError('PDF-/afstandstjenesten er ikke konfigureret endnu');
  }

  const body = Object.assign({}, payload, { op, sidecarToken: env.SIDECAR_TOKEN });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(env.SIDECAR_URL, {
      method: 'POST',
      // text/plain: Apps Script doPost læser e.postData.contents, og en
      // application/json-preflight ville kræve CORS vi ikke har brug for
      // server-til-server.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl.signal
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // Apps Script svarer med en HTML-fejlside ved uautoriseret adgang eller
      // et deploy-problem. Log det, men lad ikke HTML'en nå brugeren.
      console.error('Sidecar gav ikke JSON (op=' + op + '): ' + text.slice(0, 200));
      throw userError('PDF-/afstandstjenesten svarede uventet');
    }
    if (!data || data.ok !== true) {
      throw userError((data && data.error) || 'PDF-/afstandstjenesten fejlede');
    }
    return data;
  } catch (e) {
    if (e && e.userFacing) throw e;
    if (e && e.name === 'AbortError') {
      throw userError('PDF-/afstandstjenesten svarede ikke i tide');
    }
    console.error('Sidecar-kald fejlede (op=' + op + '): ' + (e && e.message || e));
    throw userError('PDF-/afstandstjenesten er utilgængelig');
  } finally {
    clearTimeout(timer);
  }
}
