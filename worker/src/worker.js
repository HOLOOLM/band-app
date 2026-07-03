// Band-app edge-proxy. Browseren taler kun med denne Worker (samme origin).
// Hemmeligheder (APP_TOKEN) + login-credential lever server-side; browseren får kun en httpOnly-cookie.

const SESSION_TTL_SEC = 8 * 60 * 60; // 8 timer, fornyes ved aktivitet

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/login')           return withSecHeaders(await apiLogin(request, env));
      if (url.pathname === '/api/operator-login')  return withSecHeaders(await apiOperatorLogin(request, env));
      if (url.pathname === '/api/session')         return withSecHeaders(await apiSession(request, env));
      if (url.pathname === '/api/logout')          return withSecHeaders(await apiLogout(request, env));
      if (url.pathname === '/api/change-password') return withSecHeaders(await apiChangePassword(request, env));
      if (url.pathname === '/api/call')            return withSecHeaders(await apiCall(request, env));
      if (url.pathname === '/api/faktura-pdf')     return withSecHeaders(await apiFakturaPdf(request, env, url));
    } catch (e) {
      return withSecHeaders(json({ ok: false, error: 'Serverfejl i proxy' }, 500));
    }
    // Alt andet = statisk frontend
    return withSecHeaders(await env.ASSETS.fetch(request));
  }
};

// ─── Hjælpere ────────────────────────────────────────────────────────────────

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

// Kald Apps Script server-til-server med det hemmelige token tilføjet.
async function callAppsScript(env, body) {
  const payload = Object.assign({ appToken: env.APP_TOKEN }, body);
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

function sessionCookie(sid) {
  return `sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}
function clearCookie() {
  return `sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function loadSession(request, env) {
  const sid = parseCookies(request)['sid'];
  if (!sid) return null;
  const raw = await env.SESSIONS.get('sess:' + sid);
  if (!raw) return null;
  return { sid, data: JSON.parse(raw) };
}

// Læg/forny session og returnér Set-Cookie-header.
async function saveSession(env, sid, data) {
  await env.SESSIONS.put('sess:' + sid, JSON.stringify(data), { expirationTtl: SESSION_TTL_SEC });
}

// Per-IP rate-limit på login (supplerer Apps Scripts per-email-lås).
async function ipRateLimited(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'ukendt';
  const rlKey = 'rl:' + ip;
  const n = Number(await env.SESSIONS.get(rlKey) || 0);
  if (n >= 20) return true;
  await env.SESSIONS.put(rlKey, String(n + 1), { expirationTtl: 900 }); // 20 forsøg / 15 min pr. IP
  return false;
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function apiLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  const bandId = String(body.bandId || '');
  if (!email || !passwordHash || !bandId) return json({ ok: false, error: 'Mangler felter' }, 400);

  if (await ipRateLimited(request, env)) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);

  const d = await callAppsScript(env, { action: 'login', email, passwordHash, bandId });
  if (!d || !d.ok) return json(d || { ok: false, error: 'Login mislykkedes' });

  const sid = crypto.randomUUID();
  await saveSession(env, sid, { email, passwordHash, bandId, role: d.role || 'member', kind: 'member' });
  // Send login-svaret videre, men intet credential — browseren får kun cookien.
  return json(d, 200, { 'Set-Cookie': sessionCookie(sid) });
}

async function apiOperatorLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  if (await ipRateLimited(request, env)) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);
  const d = await callAppsScript(env, { action: 'operatorLogin', email, passwordHash });
  if (!d || !d.ok) return json(d || { ok: false, error: 'Login mislykkedes' });

  const sid = crypto.randomUUID();
  // Operatør-tokenet bliver server-side i KV — aldrig i browseren.
  await saveSession(env, sid, { kind: 'operator', operatorToken: d.token });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid) });
}

// ─── Session-tjek (boot/restore) ───────────────────────────────────────────────

async function apiSession(request, env) {
  const sess = await loadSession(request, env);
  if (!sess) return json({ ok: false });
  if (sess.data.kind === 'operator') return json({ ok: true, role: 'operator' });
  // Hent friske medlemsdata via et almindeligt login-kald med de gemte credentials.
  const d = await callAppsScript(env, {
    action: 'login', email: sess.data.email, passwordHash: sess.data.passwordHash, bandId: sess.data.bandId
  });
  if (!d || !d.ok) { await env.SESSIONS.delete('sess:' + sess.sid); return json({ ok: false }, 200, { 'Set-Cookie': clearCookie() }); }
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
  if (!sess || sess.data.kind !== 'member') return json({ ok: false, error: 'Ikke logget ind' }, 401);
  const body = await request.json();
  const newHash = String(body.newHash || '');
  if (newHash.length !== 64) return json({ ok: false, error: 'Ugyldig ny adgangskode' }, 400);
  const d = await callAppsScript(env, {
    action: 'changePassword', email: sess.data.email, bandId: sess.data.bandId,
    oldHash: sess.data.passwordHash, newHash
  });
  if (!d || !d.ok) return json(d || { ok: false, error: 'Kunne ikke skifte adgangskode' });
  // Opdatér det gemte credential så efterfølgende kald stadig autentificerer.
  sess.data.passwordHash = newHash;
  await saveSession(env, sess.sid, sess.data);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sess.sid) });
}

// ─── Generelt proxy-kald for ALLE actions ──────────────────────────────────────

async function apiCall(request, env) {
  const sess = await loadSession(request, env);
  if (!sess) return json({ ok: false, error: 'Ikke logget ind' }, 401);

  const body = await request.json();
  const action = String(body.action || '');
  // Disse har dedikerede routes (sætter/opdaterer cookie/session) — ikke tilladt her.
  if (action === 'login' || action === 'operatorLogin' || action === 'changePassword') {
    return json({ ok: false, error: 'Forbudt' }, 403);
  }

  // Injicér credential/token server-side ud fra sessionen.
  const inject = sess.data.kind === 'operator'
    ? { operatorToken: sess.data.operatorToken }
    : { email: sess.data.email, passwordHash: sess.data.passwordHash };

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

  const d = await callAppsScript(env, {
    action: 'renderInvoicePdf', contractId,
    bandId: sess.data.bandId, email: sess.data.email, passwordHash: sess.data.passwordHash
  });
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

function escapeHtmlW(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Sikkerheds-headers + CSP på ALLE svar ──────────────────────────────────────

function withSecHeaders(res) {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",          // inline onclick-handlere bruges i appen (stram til senere)
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",                         // logo serveres som data: URL
    // Adresse-autocomplete (07-calendar-pdf.js) kalder dataforsyningen.dk direkte.
    "connect-src 'self' https://api.dataforsyningen.dk",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  return new Response(res.body, { status: res.status, headers: h });
}
