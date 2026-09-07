// Band-app edge-proxy. Browseren taler kun med denne Worker (samme origin).
// Hemmeligheder (APP_TOKEN) + login-credential lever server-side; browseren får kun en httpOnly-cookie.
//
// Datalaget er under migrering fra Apps Script/Sheets til Durable Objects — se
// planen i ~/.claude/plans. Klasserne skal eksporteres fra Workerens
// indgangspunkt for at Cloudflare kan instantiere dem.

import { BandDO } from './do/band.js';
import { MasterDO } from './do/master.js';
import { bandStub } from './lib/addressing.js';
import { buildIcal } from './actions/crossband.js';
import { scheduled as runScheduled } from './scheduled.js';
import { usesDurableObjects, callDurableObjects, backendDescription } from './backend.js';

export { BandDO, MasterDO };

const SESSION_TTL_SEC = 8 * 60 * 60; // 8 timer, fornyes ved aktivitet
// Forny først når der er under en time tilbage. Se saveSession for hvorfor.
const SESSION_RENEW_UNDER_SEC = 60 * 60;
// Absolut loft uanset aktivitet. Efter syv dage kræves nyt login.
const SESSION_ABSOLUT_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Største request-body vi overhovedet parser. Assets må fylde 5 MB
// (MAX_ASSET_BYTES i actions/settings.js), og base64 er ~4/3 af de rå bytes.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // ── To globale værn, før nogen rute rører data ──────────────────────
      //
      // 1) Størrelse. Hver login-rute kaldte request.json() FØR rate-limiten,
      //    så en 100 MB body blev parset ind i isolatets hukommelse og først
      //    derefter afvist med 429. Angriberen betalte intet.
      if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) {
        return withSecHeaders(json({ ok: false, error: 'For stor forespørgsel' }, 413));
      }
      // 2) Origin. CSRF-forsvaret hvilede alene på SameSite=Strict. Det er
      //    tilstrækkeligt i dagens browsere, men det er ét cookie-attribut fra
      //    at være et reelt hul på samtlige tilstandsændrende ruter. Et
      //    Origin-tjek er uafhængigt af det.
      //
      //    Kun når headeren FINDES: kalendarklienter, curl og server-til-
      //    server-kald sender den ikke, og de skal fortsat virke.
      const origin = request.headers.get('Origin');
      if (origin && url.pathname.startsWith('/api/') && origin !== url.origin) {
        return withSecHeaders(json({ ok: false, error: 'Forkert oprindelse' }, 403));
      }
      // Selvtest af datalaget. Kun tilgængelig når SELFTEST-varen er sat, og
      // den sættes kun via `wrangler dev --var SELFTEST:on`, aldrig i wrangler.toml.
      if (url.pathname === '/api/_selftest') {
        if (env.SELFTEST !== 'on') return ukendtRute(request, env);
        const { selftest } = await import('./do/selftest.js');
        return withSecHeaders(json(await selftest(env)));
      }
      if (url.pathname === '/api/_bench') {
        if (env.SELFTEST !== 'on') return ukendtRute(request, env);
        const { benchmark } = await import('./do/bench.js');
        return withSecHeaders(json(await benchmark(env, bandStub(env, 'bench'))));
      }
      // Produktionsdiagnostik. Kræver DIAG_TOKEN-hemmeligheden i en header, og
      // findes ikke hvis hemmeligheden ikke er sat.
      //
      // Den uautoriserede gren udførte før RIGTIGT ARBEJDE inden den svarede
      // 404: en R2 put+get+delete, en skrivning i et Durable Object, og med
      // ?iter=N op til 20.000 PBKDF2-iterationer — dobbelt så dyrt som et
      // login. Det var bevidst, så EU-jurisdiktionen kunne verificeres via
      // `wrangler tail` uden at håndtere et token i en PowerShell-prompt. Men
      // det gav enhver anonym gratis arbejde uden rate-limit, usynligt i
      // adgangsloggen fordi svaret var 404.
      //
      // Tjekket ligger nu FØR alt andet. Kør diagnostikken med tokenet i en
      // header fra Git Bash:
      //   curl -H "X-Diag-Token: $TOKEN" https://.../api/_diag
      if (url.pathname === '/api/_diag') {
        const dg = await import('./do/diag.js');
        if (!dg.diagAuthorized(request, env)) return ukendtRute(request, env);
        return withSecHeaders(json(await dg.diag(env)));
      }
      // iCal-feed. Egen GET-rute frem for /api/call, fordi et kalenderprogram
      // ikke kan sende POST med cookie. Token i query-parameter er her det
      // eneste mulige — kalenderklienter kan ikke sætte headers — og det er
      // derfor tokenet kan roteres uden at røre andet.
      if (url.pathname === '/ical') {
        const feedBand = String(url.searchParams.get('band') || '').trim();
        const feedToken = String(url.searchParams.get('token') || '');
        // Respektér omskiftningsflaget. Læste ruten altid fra Durable Objects,
        // ville et abonnement på et Apps Script-band få et TOMT kalendersvar.
        let ics;
        if (usesDurableObjects(env, feedBand)) {
          ics = await buildIcal(env, feedBand, feedToken);
        } else {
          // Apps Scripts doGet håndterer ?action=ical og svarer med rå
          // text/calendar — ikke JSON. Derfor hentes den som tekst her.
          const u = new URL(env.SCRIPT_URL);
          u.searchParams.set('action', 'ical');
          u.searchParams.set('band', feedBand);
          u.searchParams.set('token', feedToken);
          try {
            const r = await fetch(u.toString(), { redirect: 'follow' });
            ics = await r.text();
          } catch (e) {
            console.error('iCal-proxy til Apps Script fejlede: ' + (e && e.message || e));
            ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'].join('\r\n');
          }
        }
        return withSecHeaders(new Response(ics, {
          status: 200,
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            // Kalenderprogrammer poller ofte; en kort cache sparer arbejde uden
            // at nye gigs bliver længe usynlige.
            //
            // `private`, ikke `public`: feedet indeholder hele bandets
            // spilleplan med adresser og get-in-tider, og `public` tillod
            // enhver mellemliggende cache — en virksomhedsproxy, et CDN — at
            // gemme det i et kvarter.
            'Cache-Control': 'private, max-age=900'
          }
        }));
      }
      // Førstegangsopsætning af operatøren. Uden den er det nye datalag
      // uigennemtrængeligt: alle operatør-handlinger kræver et operatør-token,
      // og et token kræver en operatør.
      //
      // To lag beskytter den: BOOTSTRAP_TOKEN skal være sat (ellers findes
      // ruten ikke), OG den virker kun mens operators-tabellen er tom. Efter
      // første brug er den inert, så et glemt token ikke er en bagdør.
      if (url.pathname === '/api/_bootstrap') {
        const forventet = String(env.BOOTSTRAP_TOKEN || '').trim();
        const givet = String(request.headers.get('X-Bootstrap-Token') || '').trim();
        if (!forventet || !givet || givet.length !== forventet.length ||
            !constTimeEqW(givet, forventet)) {
          return ukendtRute(request, env);
        }
        let b = {};
        try { b = await request.json(); } catch (e) {}
        const { bootstrapOperator } = await import('./actions/operator.js');
        return withSecHeaders(json(
          await bootstrapOperator(env, b.email, b.password, b.passwordHash)));
      }
      if (url.pathname === '/api/login')           return withSecHeaders(await apiLogin(request, env));
      if (url.pathname === '/api/operator-login')  return withSecHeaders(await apiOperatorLogin(request, env));
      if (url.pathname === '/api/booker-login')    return withSecHeaders(await apiBookerLogin(request, env));
      if (url.pathname === '/api/session')         return withSecHeaders(await apiSession(request, env));
      if (url.pathname === '/api/logout')          return withSecHeaders(await apiLogout(request, env));
      if (url.pathname === '/api/change-password') return withSecHeaders(await apiChangePassword(request, env));
      if (url.pathname === '/api/call')            return withSecHeaders(await apiCall(request, env));
      if (url.pathname === '/api/faktura-pdf')     return withSecHeaders(await apiFakturaPdf(request, env, url));
      if (url.pathname === '/api/faktura-arkiv')   return withSecHeaders(await apiFakturaArkiv(request, env, url));
      if (url.pathname === '/api/sign')            return withSecHeaders(await apiSign(request, env));
      // Offentlig signeringsside (Booking Fase A) — ingen login. Eksplicit rute i
      // stedet for at stole på extension-less asset-serving, så /sign altid rammer
      // sign.html uanset Wrangler-assets' html_handling-konfiguration.
      if (url.pathname === '/sign') {
        const assetReq = new Request(new URL('/sign.html', request.url), request);
        // strict: signeringssiden kører uden 'unsafe-inline'. Se SIGN_CSP.
        return withSecHeaders(await env.ASSETS.fetch(assetReq), { strict: true });
      }
    } catch (e) {
      return withSecHeaders(json({ ok: false, error: 'Serverfejl i proxy' }, 500));
    }
    // Alt andet = statisk frontend
    return withSecHeaders(await env.ASSETS.fetch(request));
  },

  // Natlig oprydning (Fase 6). Se scheduled.js for hvad der ryddes og hvorfor.
  async scheduled(event, env, ctx) {
    return runScheduled(event, env, ctx);
  }
};

// ─── Hjælpere ────────────────────────────────────────────────────────────────

// Konstant-tids sammenligning til bootstrap-tokenet. Lokal kopi, så Workerens
// ydre lag ikke skal importere crypto-modulet for én funktion.
function constTimeEqW(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Svar som om ruten ikke fandtes.
 *
 * De skjulte ruter svarede før 404 med `{"ok":false,"error":"Ikke fundet"}` og
 * Content-Type JSON, mens en ukendt sti faldt igennem til asset-handlerens eget
 * 404. Forskellen bekræftede for en scanner at netop /api/_diag, /api/_bootstrap,
 * /api/_selftest og /api/_bench er implementeret — og dermed at der findes
 * tokens at lede efter. Ved at hente asset-404'en bliver de umulige at skelne.
 */
async function ukendtRute(request, env) {
  return withSecHeaders(await env.ASSETS.fetch(
    new Request(new URL('/findes-ikke', request.url), { method: 'GET' })));
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

/**
 * Sender en action til det datalag bandet hører til.
 *
 * Det ene sted omskiftningen afgøres for de dedikerede auth-ruter. Se
 * backend.js for hvorfor det er et flag pr. band og ikke et big bang.
 */
async function callBackend(env, request, body, bandId) {
  if (usesDurableObjects(env, bandId) ||
      (!bandId && String(env.BACKEND || '').startsWith('do'))) {
    return callDurableObjects(env, request, body, null);
  }
  return callAppsScript(env, body);
}

// Kald Apps Script server-til-server med det hemmelige token tilføjet.
// NB: appToken sættes EFTER spread af body — ellers kunne en klient sende sit eget
// appToken-felt og overskrive vores injicerede værdi (Object.assign: sidste vinder).
async function callAppsScript(env, body) {
  const payload = Object.assign({}, body, { appToken: env.APP_TOKEN });
  const res = await fetch(env.SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: 'Ugyldigt svar fra backend' }; }
}

function parseCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// __Host--præfikset er ikke pynt. `workers.dev` står på Public Suffix List, så
// `jonasholm.workers.dev` er et registrerbart domæne: enhver anden Worker på
// samme konto kunne sætte en cookie med `Domain=jonasholm.workers.dev`, som
// browseren så også sender hertil — og parseCookies lader den sidste
// forekomst vinde. Det er session fixation fra en søster-Worker.
//
// Browseren håndhæver at en __Host--cookie har Secure, Path=/ og INTET
// Domain-attribut. Alle tre var allerede opfyldt; det manglede kun i navnet.
//
// Navneskiftet logger alle ud én gang ved udrulning.
const COOKIE_NAVN = '__Host-sid';

function sessionCookie(sid) {
  return `${COOKIE_NAVN}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}
function clearCookie() {
  return `${COOKIE_NAVN}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function loadSession(request, env) {
  const sid = parseCookies(request)[COOKIE_NAVN];
  if (!sid) return null;
  let raw;
  // Fejler LUKKET. Er lageret nede eller kvoten brugt, er svaret "ingen
  // session" (401) — ikke en kastet fejl der bliver til 500 på hele appen.
  try { raw = await env.SESSIONS.get('sess:' + sid); }
  catch (e) { console.error('Sessionslæsning fejlede: ' + (e && e.message || e)); return null; }
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch (e) { return null; }

  // ABSOLUT LEVETID. Uden den kunne et stjålet sid holdes i live for evigt med
  // ét kald i døgnet, fordi hver forespørgsel skubbede TTL'en fremad. De 8
  // timer i public/js/02-auth.js er ren UI-kosmetik og stopper ingen.
  if (data.loginAt && (Date.now() - Number(data.loginAt)) > SESSION_ABSOLUT_MAX_MS) return null;

  return { sid, data };
}

/**
 * Læg/forny session.
 *
 * `kunHvisNaerUdloeb` findes for gratisplanens skyld: KV giver 1.000
 * skrivninger i døgnet, og en skrivning ved HVERT /api/call betød at helt
 * almindelig brug — én person der arbejder en formiddag — kunne bruge kvoten.
 * Løb den tør, kastede put() og hele appen svarede 500 indtil midnat UTC.
 *
 * Nu fornys kun når der er mindre end SESSION_RENEW_UNDER_SEC tilbage, hvilket
 * tager skrivningerne fra ~1 pr. kald til ~1 pr. syv timer pr. session.
 *
 * Dette er en afbødning, ikke destinationen: sessionerne hører hjemme i
 * BandDO's sessions-tabel, som allerede findes og er testet, men aldrig blev
 * koblet til. Se SECURITY-AUDIT-2026-09-07.md, K3.
 */
async function saveSession(env, sid, data, kunHvisNaerUdloeb) {
  const nu = Date.now();
  if (kunHvisNaerUdloeb && data.renewedAt &&
      (nu - Number(data.renewedAt)) < (SESSION_TTL_SEC - SESSION_RENEW_UNDER_SEC) * 1000) {
    return;
  }
  data.renewedAt = nu;
  if (!data.loginAt) data.loginAt = nu;
  try {
    await env.SESSIONS.put('sess:' + sid, JSON.stringify(data), { expirationTtl: SESSION_TTL_SEC });
  } catch (e) {
    // Handlingen er allerede udført på dette tidspunkt; en mislykket fornyelse
    // må ikke rulle den tilbage. Brugeren udløber så til tiden i stedet.
    console.error('Sessionsskrivning fejlede: ' + (e && e.message || e));
  }
}

// Per-IP rate-limit. `spand` adskiller ruterne, så signeringssiden og login
// ikke deler tæller.
//
// BEMÆRK at denne tæller er en støddæmper, ikke en adgangskontrol: KV er
// eventually consistent, cachet i colo'en, og get+put er ikke atomar, så
// samtidige kald kan alle læse den samme værdi. De holdbare grænser er
// per-e-mail-låsen og spray-tælleren, som begge ligger atomart i et Durable
// Object. Se SECURITY-AUDIT-2026-09-07.md, H5.
async function ipRateLimited(request, env, spand = 'rl') {
  const ip = request.headers.get('CF-Connecting-IP') || 'ukendt';
  try {
    const n = Number(await env.SESSIONS.get(spand + ':' + ip) || 0);
    return n >= 20; // 20 mislykkede forsøg / 15 min pr. IP
  } catch (e) {
    return false;   // lageret nede: bloker ikke rigtige brugere
  }
}
// Kaldes KUN når kaldet fejlede — succesfulde logins (fx et helt bands medlemmer,
// der logger ind fra samme spillested-WiFi/NAT) skal ikke kunne låse IP'en ude.
async function ipRateLimitPenalize(request, env, spand = 'rl') {
  const ip = request.headers.get('CF-Connecting-IP') || 'ukendt';
  const rlKey = spand + ':' + ip;
  try {
    const n = Number(await env.SESSIONS.get(rlKey) || 0);
    await env.SESSIONS.put(rlKey, String(n + 1), { expirationTtl: 900 });
  } catch (e) {
    console.error('Rate-limit-skrivning fejlede: ' + (e && e.message || e));
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function apiLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  const bandId = String(body.bandId || '');
  if (!email || !passwordHash || !bandId) return json({ ok: false, error: 'Mangler felter' }, 400);

  if (await ipRateLimited(request, env)) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);

  const d = await callBackend(env, request, { action: 'login', email, passwordHash, bandId }, bandId);
  if (!d || !d.ok) { await ipRateLimitPenalize(request, env); return json(d || { ok: false, error: 'Login mislykkedes' }); }

  // Gem det signerede medlems-token i stedet for password-hashet: hver senere
  // action-kald verificeres med én HMAC-tjek fremfor 10.000 hash-iterationer,
  // og et KV-lækage afslører ikke længere et password-ækvivalent credential.
  const memberToken = d.memberToken;
  delete d.memberToken; // må aldrig nå browseren
  const sid = crypto.randomUUID();
  await saveSession(env, sid, { email, passwordHash: memberToken || passwordHash, bandId, role: d.role || 'member', kind: 'member' });
  return json(d, 200, { 'Set-Cookie': sessionCookie(sid) });
}

async function apiOperatorLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  if (await ipRateLimited(request, env)) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);
  const d = await callBackend(env, request, { action: 'operatorLogin', email, passwordHash }, '');
  if (!d || !d.ok) { await ipRateLimitPenalize(request, env); return json(d || { ok: false, error: 'Login mislykkedes' }); }

  const sid = crypto.randomUUID();
  // Operatør-tokenet bliver server-side i KV — aldrig i browseren.
  await saveSession(env, sid, { kind: 'operator', operatorToken: d.token });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid) });
}

// Booker-login (Booking Fase B) — klon af apiOperatorLogin. bt:-tokenet bliver
// server-side i KV ligesom operatør-/medlems-credentials; browseren får kun
// den httpOnly sid-cookie.
async function apiBookerLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  if (await ipRateLimited(request, env)) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);
  const d = await callBackend(env, request, { action: 'bookerLogin', email, passwordHash }, '');
  if (!d || !d.ok) { await ipRateLimitPenalize(request, env); return json(d || { ok: false, error: 'Login mislykkedes' }); }

  const sid = crypto.randomUUID();
  const bookerToken = d.token;
  delete d.token; // må aldrig nå browseren
  await saveSession(env, sid, { kind: 'booker', bookerToken });
  return json(d, 200, { 'Set-Cookie': sessionCookie(sid) });
}

// ─── Session-tjek (boot/restore) ───────────────────────────────────────────────

async function apiSession(request, env) {
  const sess = await loadSession(request, env);
  if (!sess) return json({ ok: false });
  if (sess.data.kind === 'operator') return json({ ok: true, role: 'operator' });
  // Booker-tokenet er selv 8t-holdbart (BOOKER_TOKEN_TTL_SEC) og har intet
  // "refresh"-endpoint i v1 — findes tokenet stadig i KV, er sessionen gyldig;
  // Apps Script-siden verificerer selv udløb/password-fingeraftryk ved hver kaldt action.
  if (sess.data.kind === 'booker') return json({ ok: true, role: 'booker' });
  // 'refreshSession' i stedet for 'login': et udløbet medlems-token (normalt efter
  // 8t, fx en fane der genindlæses) må ikke tælle som et forkert login-forsøg —
  // ellers kan flere samtidige fane-genindlæsninger udløse konto-lockout.
  const d = await callBackend(env, request, {
    action: 'refreshSession', email: sess.data.email,
    passwordHash: sess.data.passwordHash, bandId: sess.data.bandId
  }, sess.data.bandId);
  if (!d || !d.ok) { await env.SESSIONS.delete('sess:' + sess.sid); return json({ ok: false }, 200, { 'Set-Cookie': clearCookie() }); }
  if (d.memberToken) { sess.data.passwordHash = d.memberToken; delete d.memberToken; } // rul tokenet videre
  await saveSession(env, sess.sid, sess.data); // forny TTL
  return json(d, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
}

async function apiLogout(request, env) {
  const sess = await loadSession(request, env);
  if (sess) await env.SESSIONS.delete('sess:' + sess.sid);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

// Skift password: Worker'en kender det gamle credential (fra KV) og opdaterer
// både Apps Script OG den gemte session, så cookien fortsat virker bagefter.
async function apiChangePassword(request, env) {
  const sess = await loadSession(request, env);
  if (!sess) return json({ ok: false, error: 'Ikke logget ind' }, 401);
  const kind = sess.data.kind;
  if (kind !== 'member' && kind !== 'booker') {
    return json({ ok: false, error: 'Ikke logget ind' }, 401);
  }
  const body = await request.json();
  const newHash = String(body.newHash || '');
  // oldHash kommer fra KLIENTEN, ikke fra sessionen.
  //
  // Workeren indsatte før sessionens eget token som oldHash, så handlingen
  // krævede kun cookien. Et stjålet sid var dermed nok til permanent
  // kontoovertagelse — og fordi et medlems kodeskift synkroniseres til alle
  // deres bands, ramte det dem alle på én gang. Re-autentificering er hele
  // pointen med at have et gammelt-kodeord-felt.
  const oldHash = String(body.oldHash || '');
  if (!/^[0-9a-f]{64}$/.test(oldHash)) {
    return json({ ok: false, error: 'Indtast din nuværende adgangskode' }, 400);
  }
  if (newHash.length !== 64) return json({ ok: false, error: 'Ugyldig ny adgangskode' }, 400);

  if (kind === 'booker') {
    const d = await callBackend(env, request, {
      action: 'bookerChangePassword', bookerToken: sess.data.bookerToken,
      oldHash, newHash, minLength: Number(body.minLength) || 0
    }, null);
    if (!d || !d.ok) return json(d || { ok: false, error: 'Kunne ikke skifte adgangskode' });
    if (d.token) { sess.data.bookerToken = d.token; delete d.token; }
    await saveSession(env, sess.sid, sess.data);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
  }

  const d = await callBackend(env, request, {
    action: 'changePassword', email: sess.data.email, bandId: sess.data.bandId,
    oldHash, newHash, minLength: Number(body.minLength) || 0
  }, sess.data.bandId);
  if (!d || !d.ok) return json(d || { ok: false, error: 'Kunne ikke skifte adgangskode' });
  // Opdatér det gemte credential med det nyudstedte token (falder tilbage til det
  // rå hash hvis backend af en eller anden grund ikke leverede et — login virker stadig).
  sess.data.passwordHash = d.memberToken || newHash;
  await saveSession(env, sess.sid, sess.data);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
}

// ─── Generelt proxy-kald for ALLE actions ──────────────────────────────────────

async function apiCall(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Ugyldig request' }, 400); }
  const action = String(body.action || '');
  // Disse har dedikerede routes (sætter/opdaterer cookie/session) — ikke tilladt her.
  if (action === 'login' || action === 'refreshSession' || action === 'operatorLogin' || action === 'bookerLogin' || action === 'changePassword') {
    return json({ ok: false, error: 'Forbudt' }, 403);
  }

  // ── Omskiftning pr. band ────────────────────────────────────────────────
  // Se backend.js for hvorfor dette er et flag og ikke et big bang: DMDT har
  // rigtige data i Apps Scripts Google Sheet, og et ubetinget skift ville vise
  // dem en tom app.
  const bandId = String(body.bandId || '');
  const brugDO = usesDurableObjects(env, bandId) ||
    // Operatør- og booker-actions har intet bandId, men hører til det nye lag
    // så snart nogen er skiftet over.
    (!bandId && String(env.BACKEND || '').startsWith('do'));

  const sess = await loadSession(request, env);

  if (brugDO) {
    // getConfig er offentlig: login-skærmens branding skal kunne hentes FØR
    // nogen er logget ind. Samme undtagelse som på den gamle sti.
    if (!sess && action !== 'getConfig') {
      return json({ ok: false, error: 'Ikke logget ind' }, 401);
    }
    const d = await callDurableObjects(env, request, body, sess && sess.data);
    if (!sess) return json(d);
    await saveSession(env, sess.sid, sess.data);
    return json(d, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
  }

  if (!sess) {
    // getConfig er bevidst offentlig i Apps Script (verificerer ikke auth) — den
    // driver login-skærmens branding og skal kunne hentes FØR nogen er logget ind.
    // Uden denne undtagelse fejler ethvert boot uden en eksisterende session-cookie
    // med 401, og login-skærmen falder tilbage til de indbyggede defaults (intet
    // logo/bandnavn/tema) for alle førstegangsbesøgende — netop den målgruppe
    // endpointet findes for.
    if (action === 'getConfig') return json(await callAppsScript(env, body));
    return json({ ok: false, error: 'Ikke logget ind' }, 401);
  }

  // Injicér credential/token + request-metadata server-side. clientIp/userAgent/
  // appOrigin bruges af booking-actions (fx approveAndSignBooking) til signatur-
  // registrering og til at bygge signeringslinket, uden at Apps Script behøver
  // kende Worker'ens domæne. Sat EFTER spread af body, så en klient ikke kan forfalske dem.
  const inject = sess.data.kind === 'operator' ? { operatorToken: sess.data.operatorToken }
    : sess.data.kind === 'booker' ? { bookerToken: sess.data.bookerToken }
    : { email: sess.data.email, passwordHash: sess.data.passwordHash };
  inject.clientIp = request.headers.get('CF-Connecting-IP') || '';
  inject.userAgent = (request.headers.get('User-Agent') || '').slice(0, 200);
  inject.appOrigin = new URL(request.url).origin;

  const d = await callAppsScript(env, Object.assign({}, body, inject));
  await saveSession(env, sess.sid, sess.data); // rullende fornyelse
  return json(d, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
}

// ─── Server-side honorarafregning (Fase 2) ──────────────────────────────────────
// Apps Script renderer PDF'en med CPR indsat server-side og returnerer den base64-
// kodet; her afkodes den og streames som færdig fil. CPR findes aldrig i browserens
// Network-JSON eller DOM. Åbnes i en fane via GET, så browserens PDF-viewer bruges.

function htmlError(title, msg, status = 200) {
  const body = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
    <style>body{font-family:Inter,Arial,sans-serif;padding:40px;color:#0F213C;max-width:520px;margin:0 auto;text-align:center}h2{color:#A04040}</style>
    </head><body><h2>${title}</h2><p>${msg}</p><p style="color:#666">Luk vinduet og prøv igen.</p></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function apiFakturaPdf(request, env, url) {
  const sess = await loadSession(request, env);
  if (!sess || sess.data.kind !== 'member') {
    return htmlError('Ikke logget ind', 'Din session er udløbet — log ind igen i app-fanen.', 401);
  }
  const contractId = url.searchParams.get('contractId') || '';
  if (!contractId) return htmlError('Fejl', 'contractId mangler i adressen.', 400);

  // PDF'en indeholder CPR og streames som bytes — den passerer aldrig et
  // JSON-svar. Derfor kaldes renderInvoicePdf direkte og ikke gennem
  // action-tabellen; se actions/pdf.js.
  let d;
  if (usesDurableObjects(env, sess.data.bandId)) {
    const { verifyMember, requireAdmin } = await import('./auth/verify.js');
    const { renderInvoicePdf } = await import('./actions/pdf.js');
    const { bandStub } = await import('./lib/addressing.js');
    try {
      const band = bandStub(env, sess.data.bandId);
      const m = await verifyMember(env, band, sess.data.email, sess.data.passwordHash);
      requireAdmin(m);
      d = Object.assign({ ok: true },
        await renderInvoicePdf(env, band, sess.data.bandId, contractId));
    } catch (e) {
      d = { ok: false, error: (e && e.userFacing) ? e.message : 'Kunne ikke danne PDF' };
      if (!(e && e.userFacing)) console.error('faktura-pdf: ' + (e && e.stack || e));
    }
  } else {
    d = await callAppsScript(env, {
      action: 'renderInvoicePdf', contractId,
      bandId: sess.data.bandId, email: sess.data.email, passwordHash: sess.data.passwordHash
    });
  }
  if (!d || !d.ok || !d.pdfBase64) {
    return htmlError('Kunne ikke klargøre honorarafregning', escapeHtmlW((d && d.error) || 'Ukendt fejl'));
  }
  await saveSession(env, sess.sid, sess.data); // rullende fornyelse

  // base64 → bytes
  const bin = atob(d.pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${(d.fileName || 'honorarafregning.pdf').replace(/[^\w. \-æøåÆØÅ]/g, '')}"`,
      'Cache-Control': 'no-store', // CPR-holdig fil må ikke caches
      'Set-Cookie': sessionCookie(sess.sid)
    }
  });
}

/**
 * Henter en arkiveret faktura fra R2.
 *
 * Samme adgangsmodel som /api/faktura-pdf, og af samme grund: den arkiverede
 * PDF INDEHOLDER CPR. Derfor gælder tre ting her:
 *
 *   • Der kræves en gyldig session med admin-rolle. Nøglen i R2 er ikke
 *     hemmelig nok til at være adgangskontrol i sig selv.
 *   • Fakturaen slås op i BANDETS eget Durable Object, hentet ud fra sessionens
 *     bandId — ikke ud fra noget kalderen sender. Et invoiceId fra et andet band
 *     findes derfor simpelthen ikke, og der er intet at gætte sig til.
 *   • Svaret sendes med Cache-Control: no-store.
 *
 * Ruten findes kun for bands på Durable Objects. Kører bandet stadig på Apps
 * Script, ligger arkivet i Drive, og frontenden linker direkte dertil.
 */
async function apiFakturaArkiv(request, env, url) {
  const sess = await loadSession(request, env);
  if (!sess || sess.data.kind !== 'member') {
    return htmlError('Ikke logget ind', 'Din session er udløbet — log ind igen i app-fanen.', 401);
  }
  const invoiceId = url.searchParams.get('invoiceId') || '';
  if (!invoiceId) return htmlError('Fejl', 'invoiceId mangler i adressen.', 400);

  if (!usesDurableObjects(env, sess.data.bandId)) {
    return htmlError('Ikke tilgængelig',
      'Dette band arkiverer stadig i Google Drive. Brug Drive-linket i fakturalisten.', 404);
  }

  const { archiveConfigured, getInvoicePdf } = await import('./services/archive.js');
  if (!archiveConfigured(env)) {
    return htmlError('Arkivet er ikke sat op',
      'R2-bindingen ARCHIVE mangler. Kontakt din administrator.', 503);
  }

  let inv;
  try {
    const { verifyMember, requireAdmin } = await import('./auth/verify.js');
    const band = bandStub(env, sess.data.bandId);
    const m = await verifyMember(env, band, sess.data.email, sess.data.passwordHash);
    requireAdmin(m);
    inv = await band.getInvoice(invoiceId);
  } catch (e) {
    if (e && e.userFacing) return htmlError('Ingen adgang', escapeHtmlW(e.message), 403);
    console.error('faktura-arkiv: ' + (e && e.stack || e));
    return htmlError('Serverfejl', 'Fakturaen kunne ikke hentes. Fejlen er logget.', 500);
  }

  // Samme svar uanset om fakturaen ikke findes, er slettet, eller aldrig blev
  // arkiveret. Ellers kunne man aflæse hvilke id'er der eksisterer.
  if (!inv || !inv.archiveKey || inv.status === 'slettet') {
    return htmlError('Ikke fundet', 'Der er ingen arkiveret PDF for denne faktura.', 404);
  }

  const obj = await getInvoicePdf(env, inv.archiveKey);
  if (!obj) {
    console.error('faktura-arkiv: nøgle mangler i R2: ' + inv.archiveKey);
    return htmlError('Ikke fundet', 'Den arkiverede fil kunne ikke findes. Dan fakturaen igen.', 404);
  }

  await saveSession(env, sess.sid, sess.data); // rullende fornyelse

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': (obj.httpMetadata && obj.httpMetadata.contentDisposition) ||
        'inline; filename="faktura.pdf"',
      'Cache-Control': 'no-store', // CPR-holdig fil må ikke caches
      'Set-Cookie': sessionCookie(sess.sid)
    }
  });
}

function escapeHtmlW(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Booking & e-signatur (Fase A): offentligt signerings-endpoint ─────────────
// INGEN session — en arrangør uden login kender kun sit signeringstoken. Al auth
// sker i Apps Script (_decodeSigningToken, HMAC-signeret, docHash-bundet).
// Modsat login tælles her hvert kald (ikke kun fejl) mod rate-limiten: selv et
// "view" koster en fuld Apps Script-eksekvering, og der er ingen legitim grund
// til at mange forskellige tokens skulle blive tilgået fra samme IP i stor stil.
async function apiSign(request, env) {
  // EGEN rate-limit-spand. Delte den nøgle med login, kunne en arrangør der
  // genindlæste signeringssiden 20 gange samtidig spærre for alle login fra
  // samme IP i et kvarter — og et spillesteds delte WiFi rammer hele bandet.
  if (await ipRateLimited(request, env, 'rls'))
    return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Ugyldig request' }, 400); }
  const t = String(body.t || '');
  if (!t) return json({ ok: false, error: 'Linket er ugyldigt eller udløbet.' }, 400);

  // FORFILTER: verificér tokenets HMAC her, før der kaldes videre.
  //
  // Uden det kunne enhver anonym POSTe vrøvl-tokens og få hver eneste af dem
  // omsat til en fuld Durable Object-eksekvering (eller en Apps
  // Script-eksekvering). Kombineret med at ruten før straffede HVERT kald i
  // rate-limit-tælleren var det den billigste vej til at bruge gratisplanens
  // KV-skrivekvote op og dermed lægge hele appen ned indtil midnat UTC.
  //
  // Tokenet er signeret med MASTER_SECRET, som Workeren har. Én HMAC er ren
  // CPU og rører intet lager. Dette er en dørmand, ikke autorisation —
  // datalaget validerer stadig selv token, udløb, docHash og status.
  const { verifyToken } = await import('./lib/tokens.js');
  if (!await verifyToken(env, 'arr-sign', t)) {
    await ipRateLimitPenalize(request, env, 'rls');
    return json({ ok: false, error: 'Linket er ugyldigt eller udløbet.' }, 400);
  }

  const payload = {
    t,
    clientIp: request.headers.get('CF-Connecting-IP') || '',
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 200)
  };
  const op = String(body.op || '');
  if (op === 'view') {
    payload.action = 'getSignableBooking';
  } else if (op === 'sign') {
    payload.action = 'submitArrangoerSignature';
    payload.typedName = String(body.typedName || '').slice(0, 200);
  } else if (op === 'decline') {
    payload.action = 'declineByArrangoer';
    payload.reason = String(body.reason || '').slice(0, 500);
  } else {
    return json({ ok: false, error: 'Ugyldig handling' }, 400);
  }

  // Signeringsflowet har intet bandId i request'en — bandet står i tokenet. Vi
  // kan derfor ikke afgøre pr. band her, og bruger det globale flag. Er nogen
  // bands skiftet, hører hele signeringsflowet til det nye lag: tokenet er
  // udstedt af det lag der også skal validere det.
  const d = String(env.BACKEND || '').startsWith('do')
    ? await callDurableObjects(env, request, payload, null)
    : await callAppsScript(env, payload);
  // Straf KUN når kaldet fejlede. Før blev hvert kald straffet, også de
  // vellykkede, så en arrangør kunne rate-limite sig selv midt i en signering.
  if (!d || d.ok !== true) await ipRateLimitPenalize(request, env, 'rls');
  return json(d || { ok: false, error: 'Linket er ugyldigt eller udløbet.' });
}

// ─── Sikkerheds-headers + CSP på ALLE svar ──────────────────────────────────────

// Den STRAMME politik til signeringssiden. Den er appens eneste flade uden
// login, og samtidig den eneste der klarer sig uden 'unsafe-inline': sign.js
// binder sine to knapper med .onclick = fn i JavaScript, ikke som et
// HTML-attribut. Den bruger heller ikke cdnjs, dataforsyningen eller Google
// Maps. Derfor får den sin egen politik frem for appens brede.
const SIGN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

/**
 * Sætter sikkerhedsheaders på et svar.
 *
 * VIGTIGT: denne funktion dækker kun de ruter Workeren selv besvarer. De
 * statiske filer (/, /app.css, /js/*.js) serveres af Cloudflares asset-lag UDEN
 * at Workeren køres, fordi `[assets]` i wrangler.toml ikke har
 * `run_worker_first`. Deres headers står i `public/_headers`, og de to steder
 * skal holdes i sync — ændrer du politikken her, ændr den også dér.
 *
 * Det var netop den opdeling der gjorde CSP'en virkningsløs indtil 2026-09-07:
 * den sad kun på JSON-svarene, hvor der ikke eksekveres scripts.
 */
function withSecHeaders(res, opts) {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', (opts && opts.strict) ? SIGN_CSP : [
    "default-src 'self'",
    // pdf.js hentes fra cdnjs af _loadPdfJs (04-contracts.js) til rider-preview.
    //
    // 'unsafe-inline' er gæld, ikke et valg: appen har ~102 inline
    // onclick-attributter fordelt på ni filer. Nonces hjælper ikke mod dem —
    // kun 'unsafe-hashes' eller en konvertering til addEventListener gør. Indtil
    // den konvertering er lavet, er escaping ved hver sink det egentlige
    // forsvar, og CSP'en er kun et net for resten (frame-ancestors, base-uri,
    // form-action, img-src, connect-src virker uafhængigt af dette).
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    // pdf.js' GlobalWorkerOptions.workerSrc peger på samme cdnjs-URL; nogle
    // versioner falder tilbage på en blob:-worker, så begge skal tillades.
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",                         // logo serveres som data: URL
    // Adresse-autocomplete (07-calendar-pdf.js) kalder dataforsyningen.dk direkte;
    // pdf.js henter sin worker-fil over fetch inden den starter workeren.
    "connect-src 'self' https://api.dataforsyningen.dk https://cdnjs.cloudflare.com",
    // Kort/rute på jobkortet indlejres som Google Maps-iframe (_venueMapIframe i
    // 07-calendar-pdf.js). Uden denne falder den tilbage på default-src 'self'.
    "frame-src https://www.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, headers: h });
}
