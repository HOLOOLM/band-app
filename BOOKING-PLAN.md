# Booking- og e-signatursystem til band-app — implementeringsplan

> Selvstændig implementeringsbrief. Kodebasen: statisk frontend (`public/js/01-core.js` … `10-sceneplan-editor.js`, klassiske script-tags med delt global scope), Cloudflare Worker edge-proxy (`worker/src/worker.js`), Google Apps Script-backend (`apps-script/Code.gs`, ~3.600 linjer) og ét Google Sheet pr. band. Multi-tenant via Script Properties (`TENANT_<bandId>`). Al brugervendt tekst er dansk; kode-identifikatorer engelske.

## Context

I dag er kontrakt-"godkendelse" manuel: kontrakt-PDF'en beder bogstaveligt talt arrangøren om at svare "Godkendt" på en mail (se `public/js/05-honorar.js` ~linje 421-424). Målet er et rigtigt bookingflow: en **ekstern booking-agent (booker)** med eget login sender tilbud til bands og arrangører; bandet godkender og underskriver i appen; arrangøren underskriver via et sikkert link uden login; den færdige kontrakt lander som en almindelig `godkendt` kontrakt i bandets eksisterende system.

**Produktbeslutninger (afklaret med ejeren):**
1. Booker = ekstern agency-rolle; operatøren opretter bookere og tildeler adgang pr. band.
2. Arrangør underskriver via tokeniseret e-mail-link, uden login (simpel elektronisk signatur — navn, tidsstempel, IP, dokument-hash).
3. Begge parter underskriver; endelig PDF bærer begge signaturer.
4. V1: tilbud + status pr. tilbud. Ingen provisions-/kommissionssporing.
5. Færdigunderskrevet tilbud konverteres til almindelig `godkendt` kontrakt (besætning/honorar/afregning virker som i dag).

## Eksisterende byggeklodser der SKAL genbruges (verificeret i kodebasen)

- **HMAC-tokens**: `_signOperatorPayload` (Code.gs ~2633) signerer med `MASTER_ADMIN_SECRET`. Der findes to token-varianter: operatør-tokens og medlems-tokens (`mt:`-præfiks, email+pwFp+exp, Code.gs ~858-902). Booker-tokens bliver en tredje variant af samme maskineri.
- **Worker-sessioner**: httpOnly `sid`-cookie → KV; credentials/tokens når aldrig browseren (`apiLogin`/`apiOperatorLogin`/`apiSession` i worker.js).
- **Login-lockout**: CacheService, 5 forsøg / 15 min (mønster i `actOperatorLogin`, Code.gs ~2630).
- **IP-rate-limit i Worker**: `ipRateLimited`/`ipRateLimitPenalize` (worker.js ~77-90) — tæller kun FEJLEDE forsøg.
- **Uautentificeret Worker-undtagelse**: `apiCall` kræver session for alt UNDTAGEN `action === 'getConfig'` (worker.js ~185-193).
- **Offentligt capability-link**: iCal-feedet (`FEED_TOKEN_<bandId>`, `actIcalFeed`, konstant-tids-sammenligning, Code.gs ~3251) — men det går UDEN OM Worker'en (direkte mod /exec). Signeringslinket skal i stedet gennem Worker'en (som `apiFakturaPdf` gør for PDF'er).
- **Server-side PDF**: `_htmlToPdfBlob` (HTML → midlertidigt Google Doc → PDF, Code.gs ~1916) + `_buildInvoiceHtmlServer`-mønstret; leveres via Worker `apiFakturaPdf` (base64→bytes, no-store).
- **Skrivninger**: `_writeRow`/`_updateRowById`/`_insertWithId` under global reentrant `_withLock`; request-scoped `_readAll`-cache keyed på `CURRENT_BAND_ID + ':' + fane`, invalideret af alle skrive-helpers. Nye faner auto-oprettes fra `SHEET_HEADERS` ved første `_getSheet`.
- **Audit**: `_audit(actor, action, bandId, details)` appender til dedikeret audit-Sheet (Code.gs ~2990).
- **E-mail**: der findes præcis ÉT `MailApp.sendEmail`-kald i dag (klartekst onboarding-mail, Code.gs ~2863, try/catch fire-and-forget). Ingen HTML-mails, ingen template-helper, ingen kvotetjek. Consumer-kvote ~100 modtagere/dag.
- **Kontrakt-livscyklus**: statusser hardcoded `['udkast','afventer','godkendt']` i `actChangeContractStatus` (Code.gs ~1543). `SHEET_HEADERS.Contracts` (Code.gs:30): `id,type,status,arrangoer(JSON),venue(JSON),date,getIn,soundcheck,showtimeFrom,showtimeTo,sets,setMinutes,musicianCount,crewCount,guestCount,honorar,paymentTerms,paymentTermsOther,notes,createdAt,updatedAt`. `saveContract` har `expectedUpdatedAt`-konfliktdetektion + `_withLock`-transaktion. `arrangoer`-JSON'en har allerede `email` + `contactName`.
- **Cross-band-iteration**: `_forEachCrossBand` (Code.gs ~2458) skifter `CURRENT_BAND_ID` pr. band og genbruger single-band-logik 1:1.
- **UI-shells**: band `?band=<id>`, operatør `?band=__operator` (shell i `09-boot.js`). Booker får `?band=__booker` efter samme mønster.

## Feature-flag: byg alt nu, tænd pr. band i operatør-panelet

Hele systemet gates af et **per-band feature-flag `booking`** i tenant-registreringen — præcis samme mønster som det eksisterende `crossBand`-flag:

- `TENANT_<bandId>`-JSON'en får feltet `booking: true|false` (default `false`). Operatøren toggler det i band-editoren i operatør-panelet (`09-boot.js` har allerede en feature-toggle-mekanisme til `crossBand` — genbrug den UI + `actUpdateTenant`/toggle-action 1:1, ny checkbox "Booking & e-signatur").
- **Server-side gating (det afgørende — UI-skjul er ikke nok):** ALLE booking-actions (`sendContractForSigning`, `approveAndSignBooking`, `listIncomingBookings`, alle `booker*`-actions mod det band, samt `getSignableBooking`/`submitArrangoerSignature`) starter med `if (!_loadTenant(bandId).booking) return { ok:false, error:'Booking er ikke aktiveret for dette band' }`. Slås flaget fra midt i et forløb, holder udestående signeringslinks op med at virke (generisk fejl, ingen detaljer).
- **Booker-siden:** `bookerGetBands` returnerer kun bands hvor BÅDE bookerens grant OG `booking`-flaget er sat.
- **Band-admin-UI:** sidebar-punktet "Indgående tilbud" og "Send til underskrift"-knappen renderes kun når `booking`-flaget er med i boot-config (tilføj `booking` til de whitelisted public-config-nøgler eller aflæs det via tenant-info i login-svaret — mindst invasive vej vælges under implementering).
- Flaget skibes i **fase A**, så alt kan bygges og deployes færdigt uden at noget band ser det, og du tænder det band for band når du er klar.

## Datamodel

**Ny `Bookings`-fane pr. band** (auto-oprettes via `SHEET_HEADERS` + `_getSheet`). Ikke et centralt register: konvertering til Contracts sker i samme regneark under én `_withLock`-transaktion, og bookerens tværgående visning løses med en ny `_forEachBookerBand(booker, fn)` der spejler `_forEachCrossBand`. Afvist alternativ: en `'tilbud'`-status på Contracts ville forurene dashboard-/honorar-visninger og mangler kolonner til signaturer.

```
SHEET_HEADERS.Bookings = [id, bookerId, source, status, contractDraft,
  arrangoerName, arrangoerEmail, docHash, tokenExp, bandSignature,
  arrangoerSignature, declineReason, contractId, pdfFileId, history,
  createdAt, updatedAt]
```
- `bookerId`: sha256(booker-email) — matcher `BOOKER_<sha256(email)>`-Script-Property'en; tom for band-oprettede tilbud.
- `contractDraft`: JSON med præcis Contracts-kolonnernes felter → konvertering er en mekanisk kopi.
- `bandSignature`/`arrangoerSignature`: JSON `{name, email?, ts, ip, ua, docHash}`.
- `history`: JSON-array `[{ts, actor, from, to, note}]`.
- `source`: `'booker'` | `'band'` (fase A: band-admin kan sende e-signering uden booker).

**Booker-konti** i master Script Properties (spejler operatør-/tenant-mønstret):
`BOOKER_<sha256(lowercase email)>` = `{email, name, agency, passwordHash, pwSalt, forcePasswordChange, bandIds:[...], status:'active'|'suspended', createdAt}`.

## Statusmaskine

Engelske koder i sheet, danske labels i UI. AL transition gennem én helper `_transitionBooking(bookingId, fromStatuses, to, actor, details)`: `_withLock` → genlæs række → assert status ∈ from → skriv → append `history` → `_audit` → e-mails (fire-and-forget EFTER låsen).

| Kode | Dansk label | Hvem må transitionere | E-mail ved transition |
|---|---|---|---|
| `draft` | Kladde | Booker opretter/redigerer | — |
| `sent` | Sendt til band | Booker sender | Band-admins: "Nyt bookingtilbud fra {agency}" |
| `band_declined` | Afvist af band | Band-admin (+ begrundelse) | Booker |
| `band_signed` | Godkendt af band – afventer arrangør | Band-admin **godkender & underskriver i ét trin** → docHash beregnes, signeringslink genereres | Arrangør (link), booker (status) |
| `completed` | Underskrevet | Arrangør via offentlig signeringsside | Arrangør (PDF vedhæftet), band-admins, booker |
| `arr_declined` | Afvist af arrangør | Arrangør via signeringsside (valgfri begrundelse) | Band-admins, booker |
| `expired` | Udløbet | Lazy: sættes ved indløsning af udløbet token eller næste læsning | — |
| `cancelled` | Annulleret | Booker (før `band_signed`) / band-admin (før `completed`) | Relevant part |

**Signeringsrækkefølge (bevidst designvalg):** bandets godkendelse ER bandets signatur — én handling: "Godkend og underskriv" (standard: tilbudsgiver underskriver først). Arrangøren modtager en allerede band-underskrevet kontrakt, og arrangørens signatur fuldender aftalen atomart under `_withLock` — ingen hængende "arrangør har skrevet under, venter på band"-tilstand. Ved `completed`, inde i samme lås: opret Contracts-række med status `'godkendt'` (direkte skrivning à la `saveContract` — uden om `actChangeContractStatus`-whitelisten), render + arkivér endelig PDF, skriv `contractId`/`pdfFileId` tilbage på booking-rækken.

## Signeringstoken + offentlig side

- **Token** (stateless HMAC — genbrug `_signOperatorPayload`): `bk:<base64url(JSON{v:1, bookingId, bandId, role:'arr-sign', docHash, exp})>.<hmac>`. TTL **14 dage** fra `band_signed`; `tokenExp` gemmes også på rækken så "gensend link" er deterministisk.
- **Genbrugelig indtil underskrevet** (arrangøren åbner den flere gange). Enkelt-*effekt* håndhæves server-side: `actSubmitArrangoerSignature` kører under `_withLock` og kræver status `band_signed` — anden indsendelse får "allerede underskrevet".
- **Revokering**: tokenet indlejrer `docHash`. Validering = konstant-tids HMAC-sammenligning (mønstret fra `actIcalFeed`) + `exp` + `token.docHash === row.docHash` + status-tjek. Annullering sætter `cancelled` → linket er dødt. Ændrede vilkår kræver annullér + gensend (ny hash, nyt link). Redigering efter `band_signed` er forbudt.
- **docHash** = SHA-256 (`Utilities.computeDigest`) af **kanonisk `contractDraft`-JSON + template-versionskonstant** — IKKE af renderet HTML (renderings-determinisme er skrøbelig: logo-bytes, cache-tilstand osv.).
- **Worker-ruter** (bevidst IKKE via `/api/call`, så session-kravet der forbliver intakt):
  - `GET /sign` → falder igennem til statiske assets: ny `public/sign.html` + `public/js/sign.js` (standalone; loader IKKE de 10 app-filer).
  - `POST /api/sign` (uautentificeret; `ipRateLimited`/`ipRateLimitPenalize` genbruges; Worker injicerer `clientIp` fra `CF-Connecting-IP` + `userAgent` før proxy): ops `{op:'view', t}` → `actGetSignableBooking`; `{op:'sign', t, typedName}` → `actSubmitArrangoerSignature`; `{op:'decline', t, reason?}` → `actDeclineByArrangoer`. ENS, generiske fejlbeskeder på alle fejl (ingen oracle-adfærd).
- Signeringssiden viser **hele kontrakten** (man skal kunne se hvad man underskriver); tokenet er en capability på niveau med selve kontraktens indhold.
- **Registreres ved signering**: `{name: typedName, ts, ip, ua, docHash}` på rækken + `_audit`.

## Band-admins modsignering

`actApproveAndSignBooking(bookingId, typedName, expectedUpdatedAt)` — eksisterende member-token-auth via `apiCall`; kræv `role === 'admin'` (Members-fanen). Under `_withLock`: assert `sent` (eller `draft` for `source:'band'`), beregn docHash, skriv `bandSignature`, transitionér til `band_signed`, generér token, mail arrangøren (adresse fra `contractDraft.arrangoer.email`, redigerbar i review-UI'et). Lille Worker-ændring: `apiCall` tilføjer `clientIp`/`userAgent` til ALLE proxede kald (additivt — verificér at ingen eksisterende action fejler på ukendte params).

## Endelig PDF

- Ny `_buildContractHtmlServer(contractDraft, bandConfig, signatures?)` porteret fra klientens `drawPreview` (`public/js/05-honorar.js` ~241-430). Uden signaturer til preview på signeringssiden; med begge signaturblokke (navn, dato, IP, docHash-uddrag, "Elektronisk underskrevet") til den endelige PDF.
- `_htmlToPdfBlob` → PDF; arkiveres via ny `_getContractArchiveFolder(year)` klonet fra `_getInvoiceFolder` (Code.gs ~1800); lås filen ned med `_lockdownFile` (~1817). `pdfFileId` gemmes på booking-rækken; kontraktens `notes` får en "Underskrevet kontrakt: <drive-url>"-linje (Contracts har ingen fil-kolonne — undgå skemaændring der).
- PDF'en vedhæftes arrangørens kvitteringsmail (de har intet login).

## E-mail-helper

Ny `_sendMail({to, subject, html, text})`: `MailApp.sendEmail(to, subject, text, {htmlBody: html})`, `MailApp.getRemainingDailyQuota()`-tjek, try/catch fire-and-forget, `_audit('system','email-fejl',...)` ved fejl. Ved kvoteproblem degraderes pænt (audit + UI-hint) — blokér ALDRIG selve signaturen. Den eksisterende onboarding-mail røres ikke i v1.

## UI'er

- **Booker** (`public/js/11-booker.js`, shell `?band=__booker` — efterlign operatør-shellen i `09-boot.js`): login → `/api/booker-login` (klon af `apiOperatorLogin`; KV-session `{role:'booker', token}`); tilbudsliste på tværs af tildelte bands med statusbadges; tilbudsformular (band-vælger fra grants, kontraktfelter — subset af formen i `04-contracts.js`, arrangør navn+e-mail); handlinger: gem kladde / send / annullér. Booker-token: `bt:<base64(email|pwFp|exp)>.<hmac>` — pwFp binder til passwordHash så password-reset invaliderer sessioner.
- **Operatør** (`09-boot.js`/`08-admin.js`): ny sektion "Bookere" — liste, opret (e-mail + navn + agency + midlertidig kode sendt via `_sendMail`, `forcePasswordChange`), tildel/fjern bandIds (checkbokse over tenants — spejler crossBand-toggle-UI'et), suspendér, nulstil kode. Alt `_audit`'et. Password-reset er operatør-medieret i v1 (skriv det eksplicit i UI'et).
- **Band-admin** (`04-contracts.js` + `03-dashboard.js`): sidebar-badge "Indgående tilbud (n)" når der findes `sent`-bookinger; listevisning; review-modal genbruger kontrakt-preview'et; knapper "Godkend og underskriv" (typed-name-felt) / "Afvis" (begrundelsesfelt). Plus fase A-handlingen **"Send til underskrift"** på en eksisterende `udkast`/`afventer`-kontrakt (opretter en `source:'band'`-booking) — det manuelle flow der leverer e-signering FØR booker-rollen findes.

## Nye actions (Apps Script dispatcher) og Worker-ruter

Worker (nye ruter):
| Rute | Auth | Formål |
|---|---|---|
| `POST /api/booker-login` | ingen (IP-rate-limited) | klon af `apiOperatorLogin` → KV-session `{role:'booker', token}` |
| `POST /api/sign` | ingen (IP-rate-limited; injicerer clientIp/ua) | ops `view` / `sign` / `decline` |
| `GET /sign` | ingen | statisk `sign.html` (falder igennem til assets — kræver ingen Worker-kode) |

Apps Script (alle nye):
| Action | Auth |
|---|---|
| `bookerLogin` | ingen (kaldes af Worker) |
| `bookerListOffers` / `bookerGetBands` / `bookerSaveOffer` / `bookerSendOffer` / `bookerCancelOffer` | booker-token (`bt:`); bandId ∈ grants håndhæves server-side |
| `listIncomingBookings` | medlem |
| `approveAndSignBooking` / `declineBooking` / `sendContractForSigning` / `resendSigningLink` | medlem, role admin |
| `getSignableBooking` / `submitArrangoerSignature` / `declineByArrangoer` | kun signeringstoken |
| `operatorListBookers` / `operatorSaveBooker` / `operatorDeleteBooker` / `operatorResetBookerPassword` | operatør-token |

## Filer der ændres

| Fil | Ændring |
|---|---|
| `apps-script/Code.gs` | Bookings-headers; booker-auth (login, token mint/verify, `_forEachBookerBand`); booking-actions + `_transitionBooking`; `_sendMail`; `_buildContractHtmlServer`; docHash; `_getContractArchiveFolder`; dispatcher-cases |
| `worker/src/worker.js` | `/api/booker-login`, `/api/sign`; `apiCall` videresender clientIp/ua; booker-rolle accepteres i `apiSession`/`apiCall` |
| `public/sign.html` + `public/js/sign.js` | NY standalone offentlig signeringsside |
| `public/js/11-booker.js` | NY booker-shell/UI |
| `public/js/04-contracts.js`, `03-dashboard.js` | indgående tilbud, review/sign/afvis-modal, "Send til underskrift" |
| `public/js/09-boot.js`, `08-admin.js` | `__booker`-boot-gren; operatørens booker-administration |
| `public/index.html`, `public/js/01-core.js` | script-tag til 11-booker.js; status-label-map + badge-helper |

## Faser (anbefalet rækkefølge — de-risk'er e-signaturen først)

- **Fase A (Stor): E-signatur-kerne, INGEN booker.** `booking`-feature-flag + operatør-toggle, Bookings-fane, `_sendMail`, `_buildContractHtmlServer` + docHash, signeringstoken, Worker `/api/sign` + sign.html, "Send til underskrift" på eksisterende kontrakt, godkend&underskriv, arrangør-sign/afvis, endelig PDF, konvertering til `godkendt`. Selvstændigt værdifuld (bands får e-signering med det samme) og afprøver ALLE risikable komponenter (PDF-portering, offentligt endpoint, token, e-mail) med mindst mulig overflade. **Forudsætning FØR fase A deployes:** rotér `APP_SHARED_TOKEN` væk fra den hardcodede default (`rotateAppSharedToken_RUN_ME()` findes allerede i Code.gs) — et nyt uautentificeret offentligt endpoint må ikke gå live mens raw `/exec` stadig kan kaldes med et token der står i kildekoden.
- **Fase B (Mellem): Booker-konti + login.** `BOOKER_*`-properties, operatør-UI, `/api/booker-login`, `bt:`-tokens, session-plumbing. Ingen tilbuds-UI endnu.
- **Fase C (Mellem): Booker-tilbudsflow.** `11-booker.js`, tilbuds-actions, band-admins indgående liste + afvis-med-begrundelse, alle transition-mails end-to-end.
- **Fase D (Lille): Hærdning.** Lazy expiry, gensend link, annullér-flows, kvotehåndtering i UI, audit-gennemgang, rate-limit-tuning, tomme-tilstande.

## Verifikation

- **Fase A end-to-end (lokalt, `wrangler dev` — brug KUN et testband, aldrig rigtige data):** opret testkontrakt → "Send til underskrift" → åbn `/sign?t=...` → verificér kontrakt-rendering → underskriv med testnavn → tjek at (1) Bookings-rækken har begge signaturer, (2) Contracts har fået en `godkendt`-række, (3) PDF ligger i Drive-mappen med begge signaturblokke, (4) audit-loggen har transitionerne.
- **Negativtests:** udløbet token; manipuleret token (én bit ændret); gen-indsendelse efter underskrift; annulleret booking; docHash-mismatch efter kladde-ændring.
- **E-mails:** send til egen adresse via testband; verificér HTML + tekst-fallback + vedhæftet PDF.
- **Token-enhedstests** i `apps-script/Tests.gs` efter eksisterende mønster (konstant-tids-sammenligning testes allerede): gyldig/udløbet/manipuleret `bk:`-token; booker-token med fjernet band-grant.
- **Feature-flag:** med `booking: false` (default) må INTET være synligt eller kaldbart: ingen sidebar-punkter, alle booking-actions returnerer fejl, eksisterende signeringslinks svarer generisk. Tænd flaget i operatør-panelet → alt virker. Sluk igen midt i et forløb → link dødt.
- **Sikkerhedskrav (sektion A ovenfor):** hvert af de 10 punkter afkrydses eksplicit i code review før deploy — særligt XSS-escaping af booker-input (A1) og dispatcher-whitelisten for `bt:`-tokens (A2).
- **Regression:** eksisterende login/kontrakt/honorar-flow uberørt (`apiCall`-ændringen er additiv — smoke-test med almindeligt medlemslogin).

## Sikkerhedsaudit af designet

### A. KRAV under implementering (skal verificeres i code review, ikke valgfrit)

1. **Stored XSS via booker-input — største enkeltrisiko.** Bookeren er en ekstern, kun semi-betroet part, og ALT i `contractDraft` (spillestedsnavn, arrangørnavn, noter, adresser…) renderes senere for tre andre målgrupper: den offentlige signeringsside, band-adminens review-modal og PDF'en/e-mails. Hvert eneste felt SKAL escapes ved rendering (`_escHtmlSrv` server-side, `escapeHtml` client-side — og ALDRIG i inline-`onclick`-attributter, jf. mønsteret der netop er ryddet op i hele appen). E-mail-bodies: ingen rå brugerfelter i HTML uden escaping.
2. **Booker-tokenet må KUN give adgang til `booker*`-actions.** Håndhæves i dispatcheren (whitelist), ikke i hver enkelt action: et `bt:`-token må aldrig kunne kalde medlems-/admin-/operatør-actions eller læse Contracts/Members/honorar. `bookerListOffers` filtrerer rækker på `bookerId` server-side — en booker ser aldrig andre bookeres tilbud, heller ikke i samme band.
3. **Token-type-adskillelse.** Der findes nu fire HMAC-token-typer signeret med samme `MASTER_ADMIN_SECRET` (operatør, `mt:`, `bt:`, `bk:`). Hver verifier SKAL asserte sin egen prefix + `role`-felt og afvise alt andet — skriv eksplicitte krydstests i Tests.gs (et `bk:`-token afvist af `_verifyOperator`, et `mt:`-token afvist af signeringsvalidering, osv.).
4. **Worker-injicerede params må ikke kunne smugles fra klienten.** `clientIp`/`userAgent` (og eksisterende `operatorToken`/`passwordHash`) skal tilføjes EFTER spread af klient-body (`Object.assign({}, body, inject)`-rækkefølgen) — verificér også at `callAppsScript`s `appToken` ikke kan overskrives af body (i dag står den FØRST i Object.assign; flyt den sidst eller slet nøglen fra body).
5. **Rate-limit + kvotebeskyttelse på `/api/sign` — også `view`-op'en.** Hver `view` koster en Apps Script-eksekvering + sheet-læsninger; et lækket/gættet endpoint må ikke kunne brænde dagskvoten. Per-IP-limit (genbrug eksisterende) + et loft pr. token (fx 50 visninger, tælles på booking-rækken) + overvej at cache renderet kontrakt-HTML i Worker KV keyed på docHash.
6. **Uniforme fejlsvar på det offentlige endpoint.** Ugyldigt, udløbet, annulleret, forkert-hash og ukendt token giver SAMME generiske danske besked — ingen oracle for "findes denne booking".
7. **E-mail-validering.** `arrangoerEmail` valideres strengt (format) før afsendelse; signeringslink sendes KUN til den gemte adresse; navnefelter må ikke kunne injicere headers/HTML i mails.
8. **Redigering efter `band_signed` er umulig server-side** (ikke bare skjult i UI) — docHash-bindingen håndhæver det, men skriv en eksplicit test: ændret kladde ⇒ udestående link dødt.
9. **GDPR.** Signaturposter (navn, IP, UA) og `history` er persondata: Bookings-fanen skal med i `actExportMyData`-tankegangen (arrangører er ikke brugere, men bandets dataansvar dækker dem), OG i band-sletning (`actAdminDeleteBand` sletter hele regnearket — verificér at kontrakt-PDF-arkivmappen også ryger med Drive-mappen). Notér opbevaringspolitik for signaturbeviser (anbefaling: gem så længe kontrakten gemmes).
10. **Signeringssiden viser kun `contractDraft`-afledt indhold** — aldrig band-interne data (medlemsliste, honorar-fordeling, interne felter). Kontraktens indhold er præcis hvad arrangøren skal se; intet mere.

### B. Accepterede rest-risici (dokumentér for operatøren, fix ikke i v1)

1. **Link-videresendelse / intet bevis for e-mail-ejerskab.** Simpel elektronisk signatur: den der har linket kan underskrive, og `typedName` er selv-erklæret. Evidenspakken (navn, ts, IP, UA, docHash, audit-trail, låst PDF) er passende til danske bookingkontrakter — men det er ikke MitID-niveau.
2. **`MASTER_ADMIN_SECRET` er kronjuvelen.** Kompromitteres den, kan alle fire token-typer forfalskes. Det er allerede sandt i dag (operatør + medlems-tokens); booking-systemet øger værdien af den. Rotation (`rotateMasterSecret()`) dræber alle udestående signeringslinks — acceptabelt, gensend-knappen findes.
3. **MailApp-kvote** ~100 modtagere/dag (consumer); hvert gennemført tilbud sender 3-4 mails. Fint til v1-volumen; `_sendMail` degraderer pænt og blokerer aldrig selve signaturen.
4. **`drawPreview`-portering** (~190 linjer klient-HTML) skal overleve Docs→PDF-konverteringens begrænsede CSS — budgettér iterationstid i fase A.
5. **Booker-password-reset er operatør-medieret** i v1 (ingen selvbetjening) — skriv det i booker-UI'et.
6. **KV-rate-limiterens read-then-write-race** (eksisterende, kendt): samtidige forsøg fra samme IP kan tælle lidt for lavt. Acceptabelt.
