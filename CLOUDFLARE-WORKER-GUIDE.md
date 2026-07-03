# Cloudflare Worker — trin-for-trin guide (for dummies)

> Mål: Browseren taler kun med din Worker (samme domæne). Worker'en holder hemmeligheder,
> udsteder en **httpOnly session-cookie** (kan ikke læses i DevTools af scripts), og videresender
> kald til Apps Script server-til-server. Du forbliver logget ind ved reload/ny fane.
>
> Følg afsnittene i rækkefølge. Hvert afsnit har en ✅-tjekliste. Hele øvelsen tager ~1 dag.

---

## Sådan hænger det sammen (det store billede)

```
  Browser ──/api/...── [ Cloudflare Worker ] ──/exec + APP_TOKEN── Apps Script ── Google Sheets
   cookie: sid=...        - serverer frontend (index.html, js, css)
   (httpOnly)             - gemmer login-credential i KV (server-side)
                          - sætter/læser session-cookie
                          - kender APP_TOKEN (browseren gør IKKE)
```

**Nøgleidé:** Ved login gemmer Worker'en din `email + passwordHash` i Cloudflare KV (server-side) og
giver browseren en tilfældig `sid`-cookie. Ved hvert efterfølgende kald slår Worker'en `sid` op i KV,
henter credentialet og sender det videre til Apps Script. Browseren ser aldrig credentialet eller
APP_TOKEN igen.

---

## Afsnit 1 — Opret konto og værktøjer

1. Opret en gratis konto på <https://dash.cloudflare.com>.
2. Installér Node.js (LTS) fra <https://nodejs.org> hvis du ikke har det. Tjek i en terminal:
   ```bash
   node --version
   npm --version
   ```
3. Log Wrangler (Cloudflares CLI) ind på din konto:
   ```bash
   npx wrangler login
   ```
   En browser åbner → godkend. Færdig.

✅ `npx wrangler whoami` viser din konto.

---

## Afsnit 2 — Lav projektstrukturen

Vi lægger Worker-koden i en undermappe `worker/` og frontend-filerne i `public/`.

1. Fra repo-roden, opret mapper:
   ```bash
   mkdir -p worker/src public
   ```
2. **Flyt frontend-filerne ind i `public/`** (alt browseren skal kunne hente):
   ```bash
   mv index.html app.css default-logo.png js public/
   ```
   > `apps-script/` bliver IKKE flyttet — den deployes separat til Apps Script.
   > `SECURITY-PLAN.md` / denne guide bliver også i roden (ikke i `public/`).

Mappestruktur bagefter:
```
band-app/
├── apps-script/        (uændret — deployes i Apps Script)
├── public/             (frontend — serveres af Worker'en)
│   ├── index.html
│   ├── app.css
│   ├── default-logo.png
│   └── js/...
└── worker/
    ├── src/worker.js   (laver vi i afsnit 4)
    └── wrangler.toml   (laver vi i afsnit 3)
```

✅ `public/index.html` findes; `worker/` er tom og klar.

---

## Afsnit 3 — Konfigurér Worker'en (`wrangler.toml`) + KV + hemmeligheder

1. Opret KV-namespace til sessions:
   ```bash
   cd worker
   npx wrangler kv namespace create SESSIONS
   ```
   Kommandoen printer noget i stil med:
   ```
   id = "abc123def456..."
   ```
   **Kopiér det id.**

2. Opret `worker/wrangler.toml` (indsæt dit KV-id):
   ```toml
   name = "band-app"
   main = "src/worker.js"
   compatibility_date = "2024-11-01"

   # Serverer frontend-filerne fra public/
   [assets]
   directory = "../public"
   binding = "ASSETS"

   # Session-store
   [[kv_namespaces]]
   binding = "SESSIONS"
   id = "INDSÆT-DIT-KV-ID-HER"

   # Ikke-hemmelige variabler
   [vars]
   SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzc3u_E4EIZLZXiDoJfSAZyHS0wWJCib_evu98htcSX6qzsZhraxzTIeeQ-gWjpq1o/exec"
   ```

3. Sæt det hemmelige app-token (kendes KUN af Worker'en og Apps Script).
   Vælg en lang tilfældig streng (fx fra en password-manager):
   ```bash
   npx wrangler secret put APP_TOKEN
   # indsæt fx: 9c1f...langt-og-tilfaeldigt...e7a2
   ```

4. **Sæt samme værdi i Apps Script:** Editor → ⚙️ Project Settings → Script Properties →
   tilføj `APP_SHARED_TOKEN` = nøjagtig samme streng. (Det lukker fund B fra sikkerhedsplanen:
   det offentligt kendte default-token bruges ikke længere.)

✅ `wrangler.toml` har KV-id + SCRIPT_URL; `APP_TOKEN` er sat begge steder med samme værdi.

---

## Afsnit 4 — Worker-koden

Opret `worker/src/worker.js`:

```js
// Band-app edge-proxy. Browseren taler kun med denne Worker (samme origin).
// Hemmeligheder (APP_TOKEN) + login-credential lever server-side; browseren får kun en httpOnly-cookie.

const SESSION_TTL_SEC = 8 * 60 * 60; // 8 timer, fornyes ved aktivitet

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/login')          return withSecHeaders(await apiLogin(request, env));
      if (url.pathname === '/api/operator-login') return withSecHeaders(await apiOperatorLogin(request, env));
      if (url.pathname === '/api/session')        return withSecHeaders(await apiSession(request, env));
      if (url.pathname === '/api/logout')         return withSecHeaders(await apiLogout(request, env));
      if (url.pathname === '/api/change-password') return withSecHeaders(await apiChangePassword(request, env));
      if (url.pathname === '/api/call')           return withSecHeaders(await apiCall(request, env));
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

// ─── Login ───────────────────────────────────────────────────────────────────

async function apiLogin(request, env) {
  const body = await request.json();
  const email = String(body.email || '').toLowerCase().trim();
  const passwordHash = String(body.passwordHash || '');
  const bandId = String(body.bandId || '');
  if (!email || !passwordHash || !bandId) return json({ ok: false, error: 'Mangler felter' }, 400);

  // (valgfri) simpel per-IP rate-limit på login — se afsnit 7.

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

// ─── Sikkerheds-headers + CSP på ALLE svar ──────────────────────────────────────

function withSecHeaders(res) {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",          // inline onclick-handlere bruges i appen (stram til senere)
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",                         // logo serveres som data: URL
    "connect-src 'self'",                           // frontend taler kun med /api (samme origin)
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  return new Response(res.body, { status: res.status, headers: h });
}
```

✅ `worker/src/worker.js` er oprettet.

---

## Afsnit 5 — Tilret frontend (3 små ændringer)

Filerne ligger nu i `public/js/`.

### 5a. `public/js/01-core.js` — peg API mod proxyen i stedet for Apps Script
Find `_apiCall(...)` og erstat funktionens krop, så den kalder `/api/call` (samme origin) og IKKE
sender `appToken`, `email`, `passwordHash` eller `operatorToken` (Worker'en injicerer dem):

```js
async function _apiCall(action, params){
  const body = Object.assign({ action: action, bandId: BAND_ID }, params || {});
  const ctrl = new AbortController();
  const timeoutId = setTimeout(()=> ctrl.abort(), 30000);
  try {
    const res = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',          // send session-cookien med
      signal: ctrl.signal
    });
    if (res.status === 401) { logout(); throw new Error('Session udløbet — log ind igen'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(await res.text());
  } catch(e){
    if (e.name === 'AbortError') throw new Error('Timeout — serveren svarede ikke inden 30 sek');
    throw e;
  } finally { clearTimeout(timeoutId); }
}
```
Du kan nu slette `APP_TOKEN`-konstanten (linje ~99) og `SCRIPT_URL` (linje ~92) — de bruges ikke mere
i frontend. (Lad gerne `OPERATOR_TOKEN`-variablen stå; den er bare ikke længere nødvendig.)

### 5b. `public/js/02-auth.js` — login/restore/logout går nu via proxyen
- **`doLogin`:** erstat `const d = await _apiCall('login', {...})` med et kald til `/api/login`:
  ```js
  const res = await fetch('/api/login', {
    method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
    body: JSON.stringify({ email, passwordHash: hash, bandId: BAND_ID })
  });
  const d = await res.json();
  ```
  Og **fjern** de to linjer der gemmer i sessionStorage (`band_email` / `band_hash`) — de er ikke
  længere nødvendige (cookien holder sessionen). `SESSION`-objektet må gerne beholdes til UI'et,
  men sæt `hash: undefined`.
- **`tryRestore`:** erstat hele kroppen med et kald til `/api/session`:
  ```js
  async function tryRestore(){
    try {
      const d = await (await fetch('/api/session', { credentials:'same-origin' })).json();
      if (d && d.ok){
        SESSION = { email: d.member && d.member.email, role: d.role, member: d.member };
        _stampSessionActivity(true);
        if (d.forcePasswordChange){ showChangePwView(); return; }
        enterApp();
      }
    } catch(e){}
  }
  ```
- **`logout`:** tilføj `fetch('/api/logout', { method:'POST', credentials:'same-origin' });` øverst.

### 5c. Operatør-login (hvis I bruger `?band=__operator`)
Find stedet der kalder `operatorLogin` og send det til `/api/operator-login` i stedet (samme mønster
som 5b). Worker'en gemmer operatør-tokenet server-side.

✅ Frontend sender ikke længere credentials/token i request-body, og intet gemmes i sessionStorage.

---

## Afsnit 6 — Kør lokalt og deploy

1. Test lokalt fra `worker/`:
   ```bash
   npx wrangler dev
   ```
   Åbn den viste localhost-URL med `?band=dit-band-id`, log ind, klik rundt.
2. Når det virker, deploy:
   ```bash
   npx wrangler deploy
   ```
   Du får en URL som `https://band-app.<dit-subdomæne>.workers.dev`.
3. **Eget domæne** (anbefalet): Cloudflare dashboard → Workers & Pages → din Worker → *Settings* →
   *Domains & Routes* → *Add Custom Domain* → fx `app.ditdomæne.dk`. (Domænet skal være på din
   Cloudflare-konto.)

✅ Appen svarer på din Worker-URL, og login virker.

---

## Afsnit 7 — (Valgfrit men anbefalet) per-IP rate-limit på login

Tilføj i toppen af `apiLogin`/`apiOperatorLogin`, før kaldet til Apps Script:
```js
const ip = request.headers.get('CF-Connecting-IP') || 'ukendt';
const rlKey = 'rl:' + ip;
const n = Number(await env.SESSIONS.get(rlKey) || 0);
if (n >= 20) return json({ ok: false, error: 'For mange forsøg — prøv igen senere' }, 429);
await env.SESSIONS.put(rlKey, String(n + 1), { expirationTtl: 900 }); // 20 forsøg / 15 min pr. IP
```
Dette supplerer Apps Scripts per-email-lås med en per-IP-grænse, som Apps Script ikke selv kan lave.

---

## Afsnit 8 — Slutkontrol før offentliggørelse (test i DevTools)

- [ ] **Application → Session Storage:** tom (intet `band_hash`/`band_email`).
- [ ] **Application → Cookies:** kun `sid`, markeret `HttpOnly` + `Secure`.
- [ ] **Console:** `document.cookie` viser IKKE `sid` (fordi den er httpOnly). ✅
- [ ] **Network → et `/api/call`:** request-body indeholder hverken `appToken`, `passwordHash` eller `email`.
- [ ] **Network → svar-headers:** `Content-Security-Policy` + `Strict-Transport-Security` er sat.
- [ ] Reload siden og åbn ny fane → du er stadig logget ind.
- [ ] Apps Script `runUnitTests` grøn, og `APP_SHARED_TOKEN` er sat i Script Properties (= Worker-secret).
- [ ] Det gamle direkte `/exec`-kald fra browseren findes ikke længere i Network-fanen.

Når alle felter er afkrydset, er fund A, B, C og F fra `SECURITY-PLAN.md` lukket. Næste skridt
(Fase 2 i sikkerhedsplanen) er at flytte CPR/faktura-PDF-rendering ind i Worker'en, så CPR aldrig
når browseren.
