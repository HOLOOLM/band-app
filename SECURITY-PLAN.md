# Sikkerhedsplan — Band-app

> Status pr. 2026-06-19. Lever ved siden af koden, så den følger med og kan deles med en
> sikkerhedsreviewer inden offentliggørelse. Opdater "Status"-kolonnerne efterhånden som faser lukkes.

## 0. Den vigtige præmis (læs før alt andet)

Der er én jernlov, ingen arkitektur kan bryde: **alt en bruger har lov at se, ligger i deres egen
browser** — og dermed i deres DevTools (Network-svar + DOM + hukommelse). Skal en admin se en CPR på
en faktura, kan den admins DevTools se den CPR. Det er ikke en sårbarhed; det er definitionen på at
vise data.

Det reelle, opnåelige mål er derfor:

> Via DevTools kan en bruger kun finde **det data, netop den bruger er autoriseret til** — **aldrig**
> credentials, hemmeligheder, session-tokens der kan stjæles/replayes, eller andre brugeres/bands data.

Det mål kan nås 100%. Den anbefalede arkitektur løser samtidig kravet om at forblive logget ind ved
reload/ny fane, **uden** at credentialet kan læses af JavaScript/udvidelser.

---

## 1. Hurtig verdikt: er appen OK nu?

| Scenarie | Vurdering |
|----------|-----------|
| Intern brug / lukket sæt kendte bands (trusted) | Rimeligt OK efter de 3 udførte fixes. |
| Kontrolleret lancering | OK **efter Fase 0** (CSP + password-styrke + ikke-default app-token). |
| Fri offentlig adgang, utrusted brugere | Kræver Fase 1 (proxy + cookie-sessions) og Fase 2 (server-side render af følsomt). |

**Cloudflare Worker / proxy er IKKE nødvendig for at appen virker.** Den er en sikkerhedsopgradering,
ikke et krav. Appen kører fint direkte mod Apps Script som i dag.

---

## 2. Allerede udført (denne omgang)

- **Rate-limiting på operatør-login** — `actOperatorLogin` har nu samme lockout som medlems-login
  (5 forsøg → 15 min), keyet på operatør-email via CacheService. (`apps-script/Code.gs`)
- **CPR-kryptering med integritet** — encrypt-then-MAC + nøgleadskillelse (`encKey`/`macKey`).
  Manipuleret data afvises (INT-CTXT). Nyt `v2:`-format; gamle værdier dekrypteres stadig og
  opgraderes ved næste gem. Tests tilføjet i `Tests.gs`.
- **Ingen interne fejldetaljer til klienten** — 7 steder (Drive-fejl, CPR-dekryptering, rider/sceneplan,
  tenant-oprettelse) logges nu server-side og returnerer en generisk besked.

> ⚠️ Backend-ændringer kræver en **ny Apps Script-deployment** før de er aktive. Kør `runUnitTests` først.

---

## 3. Allerede godt (bevar det)

- IDOR-tjek konsekvent (`att.memberId === me.id` i alle medlems-actions).
- Konstant-tids-sammenligninger på token, signatur og password-hash.
- Server-side rolletjek (`_requireAdmin`).
- Output-escaping (`escapeHtml`) ~226 steder.
- Ingen `eval` / `new Function`.
- Ingen ambient cookie i dag ⇒ ingen klassisk CSRF.

---

## 4. Dybdegående tjek — åbne fund

### Kritiske / arkitektoniske (løses af proxy-laget)

| # | Fund | Hvor | Konsekvens |
|---|------|------|-----------|
| A | Bærer-credential = `sha256(password)` sendes i hver request-body og ligger i `sessionStorage` | `js/02-auth.js:23`, `js/01-core.js:169` | Læsbart i Network + Application-fanen; kan stjæles af XSS/udvidelse og replayes; ikke revokerbart. |
| B | Åbent endpoint (Access: Anyone) + statisk `APP_TOKEN` i klienten | `js/01-core.js:99` | Ingen ægte adgangskontrol før login; Apps Script ser ikke IP → ingen per-IP-throttling. |
| C | Ingen Content-Security-Policy | `index.html` `<head>` | Intet XSS-værn i dybden; XSS er den primære vej til at stjæle session/token. |
| D | ~~CPR/bankoplysninger sendes til browseren og injiceres i print-vindue klient-side~~ **LUKKET 2026-07-03 (Fase 2):** honorarafregning + Drive-arkiv renderes nu server-side (`renderInvoicePdf`/`archiveInvoiceToDrive` i Code.gs, `/api/faktura-pdf` i Worker'en); `getBandCpr`-endpointet er fjernet. CPR når kun browseren som en færdig PDF-fil, admin bevidst åbner. | `apps-script/Code.gs`, `worker/src/worker.js` | — |
| E | Svag password-stretching (10k HMAC) + 6-tegns minimum | `apps-script/Code.gs` (`PW_ITERATIONS`), `js/02-auth.js:46` | Knækbart offline hvis Sheet/Identity-store lækker. |
| F | Hemmeligheder i Script Properties + hardcodet default-token | `apps-script/Code.gs` (`APP_TOKEN_DEFAULT`) | Ingen rotation/secret-manager; default-token offentligt kendt. |

---

## 5. Målarkitektur: edge-proxy foran Apps Script

Browseren taler aldrig længere direkte med Apps Script. Den taler med en proxy, der holder alle
hemmeligheder server-side og kun udsteder en **httpOnly session-cookie**. Apps Script/Sheets kan blive
som datalag bag proxyen (billig migration).

```
  Browser ──HTTPS── [ Edge-proxy (Cloudflare Worker / Cloud Run) ] ──server-to-server── Apps Script ── Sheets
   │ httpOnly cookie     │ holder: app-token, session-store,
   │ (ingen JS-adgang)   │ password-hashing, rate-limit, CSP,
   │                     │ server-side PDF-render
```

**Anbefalet stack:** Cloudflare Workers + KV (sessions) — gratis/billigt, globalt, ingen servere at
passe; serverer også frontend. Alternativ: Node/Express på Cloud Run for ét sprog og fuld kontrol.

### Hvordan proxyen lukker hvert fund
- **A:** Login mod proxyen → `Set-Cookie: session=<opaque-random>; HttpOnly; Secure; SameSite=Strict`.
  JS kan ikke læse den; følger automatisk med ved reload/ny fane (forbliver logget ind). Sessions er
  server-side, revokerbare, kortlivede med rullende fornyelse. Password-hashen forlader aldrig browseren igen.
- **B:** `APP_TOKEN` og hemmeligheder bor i proxyens secret-store; browseren ser dem aldrig. Proxyen
  håndhæver origin/CORS og **per-IP rate-limiting** (også på login + operatør-login).
- **C:** Proxyen sætter stram `Content-Security-Policy` + `HSTS`, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`. (Whitelist eller self-host Google Fonts.)
- **D:** Følsomme dokumenter (honorarafregning/faktura med CPR) **renderes til PDF server-side** og
  streames som færdig fil. CPR/bank forlader aldrig serveren → findes ikke i nogen browsers DevTools.
- **E:** Password-hashing flyttes til proxyen med **Argon2id/bcrypt** + minimum 12 tegn + brudt-password-blacklist.
- **F:** Hemmeligheder i secret-manager (Cloudflare secrets / Google Secret Manager) med rotation.

---

## 6. Faseplan (lav risiko, trinvis — appen kører hele vejen)

### Fase 0 — Hærdning nu (dage, ingen ny infrastruktur) — anbefales straks
- [ ] Sæt ikke-default `APP_SHARED_TOKEN` Script Property (fjerner den offentligt kendte default).
- [ ] Tilføj midlertidigt `Content-Security-Policy`-meta-tag i `index.html`.
- [ ] Hæv password-minimum til 12 tegn (`js/02-auth.js`).
- **Resultat:** fornuftig form til kontrolleret lancering.

### Fase 1 — Proxy + cookie-sessions (kerne-sikkerhedsgevinsten)
- [ ] Stil Cloudflare Worker foran; serverer frontend + proxyer API.
- [ ] Flyt login til proxyen: verificér mod Apps Script, opret server-side session, sæt httpOnly-cookie.
- [ ] Frontend dropper `passwordHash`/`appToken` i body og `sessionStorage`.
- [ ] Sæt alle security-headers + per-IP rate-limiting.
- **Resultat:** fund A, B, C, F lukket.

### Fase 2 — Server-side rendering af følsomme dokumenter — ✅ UDFØRT 2026-07-03
- [x] CPR/faktura-PDF-generering flyttet server-side (Apps Script renderer, Worker streamer).
- **Resultat:** fund D lukket; CPR findes ikke i nogen browsers Network-JSON/DOM.

### Fase 3 — Stærk hashing + (valgfrit) datalag-migration
- [ ] Argon2id i proxyen (fund E).
- [ ] Valgfrit: migrér fra Sheets til Firestore/Postgres bag samme proxy (skalering/robusthed, ikke et sikkerhedskrav).

---

## 7. Ærlig restrisiko efter fuld udrulning

- Brugerens **egen** session-cookie er synlig for brugeren selv i DevTools → Application → Cookies.
  Ufarligt: kortlivet, revokerbart, ubrugeligt cross-site (SameSite), ikke læsbart af scripts.
- Data brugeren er autoriseret til er fortsat i deres browser → send mindst muligt (server-side render
  af det følsomme, lazy-load resten).
- **CSP er den vigtigste enkeltinvestering** — uden den kan XSS stadig agere på vegne af en indlogget
  bruger, selv når credentialet ikke længere kan stjæles.

---

## 8. Tjekliste før offentliggørelse

- [ ] Fase 0 udført og deployet.
- [ ] Ny Apps Script-deployment kørt; `runUnitTests` grøn.
- [ ] Beslut målgruppe (trusted vs. åben) → afgør om Fase 1–2 skal være på plads først.
- [ ] GDPR: dokumentér CPR-behandling, opbevaringsperiode (`retentionLoginLogMonths`), og databehandleraftale.
- [ ] Backup af Script Properties (master-secret, CPR-nøgle) gemt sikkert.
