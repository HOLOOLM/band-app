# Sikkerhedsaudit — Band-app, 7. september 2026

Fem parallelle gennemgange af hele kodebasen på commit `888e829`: auth/sessioner,
brute force/DoS, offentlig angrebsflade, injection/persondata, og
secrets/infrastruktur. Ingen filer ændret under auditten. Live-kontakt med
produktionen var begrænset til ~17 rene GET/HEAD-kald; ingen loginforsøg, ingen
brute force, intet tilstandsændrende.

Fundene nedenfor er sorteret efter hvad de koster hvis de udnyttes — ikke efter
hvor svære de er at rette. De ni første er verificeret enkeltvis mod koden eller
mod live-svar; resten hviler på agenternes kodelæsning.

Dette dokument beskriver angreb mod jeres eget system. Behandl det som
SECURITY-PLAN.md: det må gerne følge koden og deles med en reviewer, men det
hører ikke i et offentligt repo.

---

## Sammenfatning

Det korte svar på "er der huller?": ja, tre af dem betyder noget, og de er alle
tre af samme slags — **arbejde der er bygget færdigt, men aldrig koblet til.**
Ikke sjusk, men den klassiske fejl i et projekt der har flyttet sig hurtigt:
mekanismen findes, testen er grøn, og ingen har efterprøvet at den kører i drift.

- CSP'en er skrevet, komplet og korrekt — og sidder på JSON-svar, hvor den intet
  udretter. Dokumentet får ingen.
- Sessionstabellen i BandDO er skrevet, testet og fungerer — og bliver aldrig
  kaldt. Sessionerne ligger stadig i KV, hvor gratisplanens kvote er en mur som
  almindelig brug selv render ind i.
- Kontrakt-rendereren på signeringssiden blev aldrig færdig. Arrangøren
  underskriver et dokument hvor der bogstaveligt talt står "undefined".

Tenant-isolationen, som er projektets bærende idé (ét Durable Object pr. band),
er reelt stærk i datalaget — men den brydes ét sted i logikken: password-SSO'en
gør, at en admin i ét band kan overtage konti i andre bands.

Det der er godt, er til gengæld usædvanligt godt: nul runtime-afhængigheder,
ingen SQL-injection nogen steder, en action-tabel der fejler lukket, disciplineret
escaping næsten overalt, og kommentarer der dokumenterer trusselsmodellen frem
for koden. Den fulde liste står nederst — den er værd at læse, så I ved hvad I
ikke behøver røre.

---

## KRITISK

### K1 — En band-admin kan overtage konti i alle andre bands

**Verificeret.** Kæden har tre led, hvor hvert led isoleret set er rimeligt:

1. `saveMember` (auth: `admin`) lader en admin tilføje en **vilkårlig** e-mail som
   medlem. `registerIdentity` kalder `addIdentityBand(email, mitBand)` uden at
   e-mailens ejer involveres — `worker/src/actions/members.js:97`.
2. `resetPassword` genererer en engangskode, returnerer den i klartekst til
   admin, og kalder `syncPasswordAcrossBands` — `members.js:185-194`.
3. Den funktion henter `bandsForIdentity(e, false)`, altså **alle** bands
   identiteten hører til, ikke kun de crossBand-aktiverede, og skriver koden ud
   til dem alle med `tvungetSkift = false`, så offeret intet opdager —
   `worker/src/auth/identity.js:54-61`.

Mallory er admin i band X. Hun tilføjer `offer@bandy.dk`, nulstiller
adgangskoden, og har nu offerets kode i band Y. Er offeret admin dér, har hun
alle kontrakter, honorarer, bankoplysninger, medlemmernes adresser og adgang til
`/api/faktura-pdf`, som renderer CPR.

Koden dokumenterer selv, at en nulstilling rammer andre bands, som "bevaret
adfærd fra originalen" (`members.js:170-173`). Det er kombinationen med **fri
tilføjelse af fremmede e-mails** der gør det til en overtagelse frem for en
bekvemmelighed. Bemærk at admin-rollen ifølge jeres egen kommentar
(`actions/index.js:171`) typisk er "et menigt medlem der har fået den".

Forstærkes af, at `mt:`-tokenet ikke er bundet til et band
(`actions/auth.js:19-22`) — efter overtagelsen kan Mallory blive i band X og
bare sende `bandId: "band-y"` i `/api/call`.

**Rettelse:** lad `syncPasswordAcrossBands` skrive til en hvidliste frem for en
sortliste — kun bands kalderen selv har admin i. Og lad `registerIdentity` ikke
kunne koble en e-mail der allerede har et identitetskort til et nyt band uden en
bekræftelse fra ejeren.

### K2 — Sikkerhedsheaders rammer ikke selve dokumentet; CSP'en er uden effekt

**Verificeret live 2026-09-07:**

```
GET /                → 200 text/html   ingen CSP, ingen HSTS, ingen X-Frame-Options
GET /app.css         → 200             ingen
GET /api/session     → 200 json        fuld CSP, HSTS, XFO: DENY, nosniff
```

Koden ser rigtig ud: `worker.js:132` og `:138` sender begge asset-svaret gennem
`withSecHeaders`. Men `[assets]` i `wrangler.toml:6-8` er sat op uden
`run_worker_first`, så Cloudflares asset-lag svarer **før** Workeren køres.
`CF-Cache-Status: HIT` på `/` bekræfter det — Workeren rørte aldrig requesten.

Konsekvensen er at CSP'en kun sidder på JSON-svar, hvor den er virkningsløs, for
et JSON-svar eksekverer ikke scripts. Der er altså ingen `frame-ancestors` (siden
kan clickjackes), ingen HSTS på dokumentet, og intet andet forsvarslag under
XSS-fundene H1, H3, M4 og M5 nedenfor.

`SECURITY-PLAN.md:7` kalder CSP "den vigtigste enkeltinvestering" og markerer
Fase 1 som gennemført. Den er i praksis ikke leveret.

**Rettelse:** en `public/_headers`-fil med de samme direktiver. Ingen kodeændring.

### K3 — Sessioner ligger i KV, ikke i BandDO; gratisplanens kvote er en afbryder

**Verificeret.** `putSession` / `getSession` / `touchSession` findes i
`worker/src/do/band.js:1472-1538`, er testet, og kaldes **kun** af selvtestene.
Produktionen bruger KV: `saveSession` skriver ved hvert eneste `/api/call`
(`worker.js:376`, `:403`), hver `/api/session` (`:315`), hver PDF-hentning
(`:454`, `:532`) og hvert login.

`wrangler.toml:25-26` siger "Kun rate-limit tilbage i KV. Sessioner er flyttet
ind i BandDO". Det passer ikke på den kørende kode.

To følger, og den første er den vigtigste:

- **Almindelig brug rammer muren selv.** Gratisplanen giver 1.000 KV-skrivninger
  i døgnet. Én bruger der arbejder i appen en formiddag laver let 50-100. Det er
  præcis den mur kommentaren siger I flyttede jer væk fra.
- **En anonym kan trække afbryderen på sekunder.** `apiSign` straffer *hvert*
  kald, ikke kun fejlede (`worker.js:558`), så ~1.000 POSTs til `/api/sign`
  bruger døgnets kvote. Derefter kaster `SESSIONS.put`, og fordi kaldet ikke er
  pakket ind, bliver det til `500 Serverfejl i proxy` på både login og alle
  indloggede kald indtil UTC-midnat. Samtidig holder `ipRateLimitPenalize` op med
  at virke, så login-rate-limiten falder ud samtidig.

Dertil: KV-værdien indeholder `mt:`-tokenet i klartekst — et password-ækvivalent
credential i otte timer på tværs af alle offerets bands. Og `setMemberPassword`
sletter rækker i den **døde** `sessions`-tabel (`band.js:388`), så koden *ser ud
til* at dræbe sessioner uden at gøre det (det virker kun indirekte via `pwFp`).
Det er farligt at læse forkert ved næste ændring.

**Rettelse:** fuldfør flytningen — koden er der. Flyt rate-limit-tælleren til et
DO eller Cloudflares ratelimit-binding samtidig, jf. H5.

---

## HØJ

### H1 — Lagret XSS: band-admin → operatørens session, via `sceneplanJson`

**Verificeret.** `sceneplanJson` står i `ALL_SETTINGS_KEYS`
(`lib/settings-defaults.js:31,97`), så enhver band-admin kan skrive den via
`adminWriteConfig`. `validerUdseende` validerer `theme`, HEX-farver, fonte og
`riderTemplates` — men rører aldrig `sceneplanJson`.

Ved læsning parses den (`09-boot.js:1333`), `normalizeState` tjekker kun
`Array.isArray` (`10-sceneplan-editor.js:161-173`), og
`sceneMarkup()` interpolerer felterne rå ind i SVG:

```js
stroke="${t.color}" ... font-size="${t.size}" fill="${t.color}"    // :377-378
data-id="${st.id}"                                                  // :313-350
```

`esc()` findes i filen (`:143`) men bruges kun på `label` og `text`.
Markuppen sættes med `svg.innerHTML` (`:388`, `:393`).

En band-admin lægger et brud-ud-af-attributtet i `color`, operatøren åbner
"Redigér i editor" på bandets indstillinger, og koden kører i operatørens
browser i app-originen — uden CSP til at stoppe den (K2). Operatøren kan slette
bands, hente alle backups med persondata og nulstille adgangskoder. Det er den
største rettighedsforskel i systemet.

**Rettelse:** escape alle interpolerede strengfelter i `sceneMarkup()`, hvidlist
`color` mod `/^#[0-9A-Fa-f]{3,8}$/`, og tving tal med `Number()` i
`normalizeState`.

### H2 — IDOR: enhver band-admin kan hente og ødelægge et andet bands iCal-token

**Verificeret.** Routeren sætter `ctx.bandId` fra `p.bandId` og verificerer admin
mod *det* band (`actions/router.js:34-41`). Men begge funktioner arbejder på et
andet felt:

```js
const bandId = String(p.targetBandId || ctx.bandId || '').trim();
```
`actions/crossband.js:127` (`getFeedUrl`) og `:136` (`rotateFeedToken`).

`POST /api/call {action:"getFeedUrl", bandId:"mit-band", targetBandId:"andet-band"}`
returnerer det andet bands `feedToken`. Derefter giver `/ical?band=…&token=…`
hele deres gigkalender: spillesteder, adresser, get-in, noter.
`rotateFeedToken` ødelægger i stedet alle deres kalenderabonnementer.

`targetBandId` er udelukkende operatørpanelets konvention (`09-boot.js:328-392`);
en band-admin har ingen legitim grund til feltet.

**Rettelse:** brug `ctx.bandId`, og accepter kun `p.targetBandId` når
`ctx.operator` er sat.

### H3 — XSS: booker → band-admin, via `venue.name` i print-vinduets titel

**Verificeret.** `openPrintWindow` interpolerer titlen rå:

```js
const html = `...<title>${title}</title>...`;   // 07-calendar-pdf.js:786
```

To kaldere sender uescaped `venue.name` ind (`:817`, `:826`), mens de øvrige
kaldere 50 linjer længere nede escaper korrekt (`:868`, `:872`). Det er altså en
forglemmelse, ikke et valg. Samme rå `${title}` i `openPreviewWindow` (`:801`).

En **booker** — den laveste konto med skriveadgang — opretter et tilbud med
`venue.name = '</title><img src=x onerror=…>'`. `draftFraTilbud` tager
`venue: o.venue || {}` uden validering (`actions/booker.js:113-133`). Efter
underskrift gemmes det i kontrakten (`do/band.js:954`). Admin trykker
"↓ PDF med Rider" → blob-dokumentet arver app-originen → scriptet kan kalde
`/api/call` med adminens httpOnly-cookie.

**Rettelse:** `escapeHtml(title)` på linje 786 og 801.

### H4 — `/api/change-password` kræver ikke den nuværende adgangskode

**Verificeret.** Klienten sender kun `newHash` (`public/js/02-auth.js:63`), og
Workeren indsætter selv sessionens token som `oldHash` (`worker.js:333`).

Et stjålet `sid` er dermed nok til permanent kontoovertagelse — og fordi
`changePassword` kalder `syncPasswordAcrossBands` (`actions/auth.js:123`),
rammer overtagelsen alle offerets bands på én gang.

Det er et bevidst designvalg ("Worker'en kender det gamle credential"), men det
fjerner den re-autentificering der er standardforsvaret mod netop session-tyveri.

**Rettelse:** kræv `oldHash` fra klienten, og brug sessionen udelukkende til at
fastslå hvem der kalder.

### H5 — Rate-limiten holder ikke, og der er ingen bremse på password spraying

`ipRateLimited` / `ipRateLimitPenalize` (`worker.js:225-238`) er en
read-modify-write mod KV. Tre uafhængige problemer:

1. **Ikke atomar.** 500 parallelle requests læser alle `0` og skriver alle `1`.
2. **Edge-cache.** KV `get()` cacher i colo'en, som standard 60 sekunder.
3. **Colo-isolation.** KV er eventually consistent; to exit-noder deler ikke
   tæller før propagering.

Nøglen er desuden `rl:<fuld IP>`, så ét IPv6-/64 giver 2^64 friske tællere.

Dertil findes der **ingen tæller på antal forskellige konti** der fejler mod
samme band. Per-e-mail-låsen (5/15 min, `actions/auth.js:15`) dækker ét offer ad
gangen. Én adgangskode prøvet mod alle konti i bandet rammer aldrig nogen
spærring — og kan gentages hvert kvarter uden at låse nogen ude eller udløse en
alarm.

**Rettelse:** flyt tælleren til et DO eller Cloudflares ratelimit-binding (begge
atomare), nøgl på /64, og tilføj en per-band fejltæller i `band_meta` som tælles
op ved *hvert* mislykket login uanset e-mail.

### H6 — Anonyme kan oprette ubegrænset mange Durable Objects

`bandStub(env, id)` bruger `idFromName(id)` uden at slå bandet op nogen steder
(`lib/addressing.js:35-39`), og første berøring kører `#ready()` →
`applyMigrations`, som anlægger 24 tabeller permanent (`do/band.js:37-47`).

To uautentificerede veje derhen, ingen af dem rate-limitet:

```
POST /api/call {"action":"getConfig","bandId":"<hvad som helst>"}   # worker.js:371
GET  /ical?band=<hvad som helst>                                     # worker.js:64
```

Objekterne står ikke i masters bandliste, så cron-oprydningen (`scheduled.js:35`)
finder dem aldrig. De bliver liggende.

**Rettelse:** slå `bandId` op i master før `bandStub()` kaldes på de to
offentlige stier, og svar med defaults hhv. tom kalender for ukendte bands.

### H7 — Prototypens Apps Script-deployment med CPR er stadig i drift

`HANDOVER.md:451-453`: DMDT-prototypens data ligger i sit eget Google Sheet bag
sit eget deployment, og "det projekt er urørt og virker stadig".
`apps-script/Eksporter-fra-prototype.gs:19-20` bekræfter at Members-arket har en
**cpr-kolonne pr. medlem**; regnearks-id'et står i klartekst i filen.

Når migreringen er færdig, tror alle at data ligger i Durable Objects. Imens
ligger den fulde CPR-holdige kopi videre i et system ingen patcher eller
overvåger. Det er projektets mest følsomme datasæt, placeret på den mindst
vedligeholdte flade.

**Rettelse:** slet deploymentet (ikke bare hold op med at bruge det), og slet
eller afhænd regnearket når importen er verificeret.

### H8 — APP_TOKEN-rotationen er aldrig kørt, og default-værdien ligger i git

`apps-script/Code.gs:146` indeholder `APP_TOKEN_DEFAULT`, committet i det aller-
første commit og stadig i HEAD. `Code.gs:587` falder tilbage på den hvis Script
Property'en ikke er sat, og koden erkender selv at værdien er "synlig i denne
offentlige kildekode" (`:238`).

`SECURITY-PLAN.md` Fase 0 har rotationen som uafkrydset, og projekthukommelsen
siger direkte at den aldrig er kørt. Det er det ældste åbne sikkerhedspunkt i
projektet.

Latent i dag, fordi det live `/exec` kører sidecaren, ikke `Code.gs`. Men
`wrangler.toml:38-42` udpeger `BACKEND="sheets"` som tilbagerulningsstien — og en
tilbagerulning kræver at `Code.gs` gen-deployes. Bemærk også H9.

**Rettelse:** fjern konstanten fra kildekoden og lad `_appTokenOk` fejle hårdt
uden Script Property. Historikken kan ikke repareres uden rewrite — behandl
værdien som permanent brændt.

### H9 — `doGet` i Code.gs springer token-tjekket over (latent)

```
Code.gs:561  function doGet(e)  { ... return handle(e.parameter); }   ← intet _appTokenOk
Code.gs:570  function doPost(e) { ... if (!_appTokenOk(params)) ... } ← kun POST er gated
```

Med `access: "ANYONE_ANONYMOUS"` (`appsscript.json:14-15`) betyder det, at hele
action-routeren kan nås over GET uden nogen delt hemmelighed — og `respond()`
returnerer JSONP når `?callback=` er sat (`Code.gs:762-770`), så svaret kan læses
fra en vilkårlig hjemmeside.

Rolletjek og per-e-mail-lockout findes også på Apps Script-siden, så det er ikke
et frit lejde. Men Workerens per-IP-loft findes kun i Workeren, og Apps Script
ser ikke klientens IP.

Latent af samme grund som H8: sidecaren gater alt bag `sidecarToken`
(`Sidecar.gs:66-70`) og har ingen persondata. Hullet bliver først live igen ved
en tilbagerulning. Bemærk at `Code.gs` og `Sidecar.gs` begge definerer
`doPost`/`doGet` — ligger de nogensinde i samme projekt, vinder én vilkårligt.

**Rettelse:** tilføj token-tjekket i `doGet` (efter ical-grenen) og fjern
JSONP-grenen, så tilbagerulningsstien ikke er en bagdør.

---

## MELLEM

### M1 — Signeringssiden viser aldrig kontrakten

**Verificeret.** `getSignableBooking` returnerer `draft`, aldrig `html`
(`actions/bookings.js:354-365`, med kommentaren "indtil da sendes dataen"), men
signeringssiden skriver `${d.html}` ind i kontraktboksen
(`public/js/sign.js:36`). Arrangøren ser ordet **`undefined`** hvor aftalen
skulle stå — og nedenunder står "bekræfter du at have læst og accepteret
kontrakten ovenfor".

Det er både en tillidsdefekt og et juridisk problem: en registreret e-signatur på
et dokument der beviseligt aldrig blev vist. Det underminerer hele det
`docHash`-arbejde der ellers er lavet ordentligt.

Selvtesten er grøn, fordi den asserterer på `syn.draft`
(`selftest-bookings.js:147-155`) — præcis det hul I selv har skrevet ned som
"selvtest fanger ikke kontraktdrift".

Bemærk også at `${d.html}` er en rå innerHTML-sink på en **offentlig, ulogget**
side. Bygger man feltet uden escaping, er der ingen CSP under (K2).

**Rettelse:** render `d.draft` felt for felt med `escapeHtml()`. Det løser begge
dele på én gang.

### M2 — `getConfig` udleverer kontaktpersoners persondata uden login

`PUBLIC_CONFIG_KEYS` (`lib/settings-defaults.js:53-78`) indeholder `contactName`,
`contactEmail`, `contactPhone`, `contactAddress`, `techContactName`,
`techContactPhone`. Alt sammen hentbart med et enkelt uautentificeret POST, hvis
man kender eller gætter et `bandId` — og id'erne er ifølge
`lib/addressing.js:34` "stabile og menneskeligt læsbare".

Svaret er samtidig et eksistens-orakel: et ukendt band svarer med
`SETTINGS_DEFAULTS` (`bandName: "Mit Band"`), et rigtigt med sit eget navn.

Login-skærmen skal bruge navn, farver, font og logo. Ikke privatnumre og
adresser på kontakt- og teknikperson.

**Rettelse:** flyt `contact*` og `techContact*` til `adminReadConfig`.

### M3 — `/api/_diag` udfører betalt arbejde før den afviser

**Verificeret.** Den uautoriserede gren kører `diagBillig(env)` — som laver R2
put+get+delete og en rigtig DO-skrivning (`do/diag.js:101-128`) — eller
`maalEtHash(iter)` med op til 20.000 PBKDF2-iterationer, altså dobbelt så dyrt
som et login. Først derefter svares 404 (`worker.js:38-57`). Ingen rate-limit.

Loftet på 20.000 er bevidst sat, så forfatteren var opmærksom på misbrug. Men
gratis arbejde for enhver anonym er stadig gratis arbejde, og 404-svaret gør det
usynligt i adgangsloggen.

`HANDOVER.md:788` siger selv at ruten bør væk, nu hvor `bandHealth` findes.

**Rettelse:** slet ruten. Ellers: flyt `return 404` op før `try`-blokken.

### M4 — `contentType` valideres ikke og ender uescaped i et `src`-attribut

`adminUploadAsset` sender `p.contentType` videre uden validering
(`actions/settings.js:181`), og `do/band.js:1057` bygger data-URL'en af den.
Værdien lander rå fire steder, hvoraf det ene er **serverside**:

```js
'<img src="' + logoDataUrl + '" alt="" style="height:56px" />'   // lib/invoice-html.js:59
```

Alt andet i den fil går gennem `esc()`. Klientsiden: `05-honorar.js:257,277,328`
og `07-calendar-pdf.js:260,699,848` — sidstnævnte på tværs af bands i
kryds-band-visningen.

**Rettelse:** hvidlist mime i `adminUploadAsset`, og escape `logoDataUrl` i
`invoice-html.js`.

### M5 — `_brandify()` omgår escaping

`07-calendar-pdf.js:760-785` erstatter `__BAND_NAME__`, `__CONTACT_NAME__`,
`__BANK_*__` m.fl. med rå settings-værdier — og substitutionen sker **efter** at
resten er escapet. Brugt i `05-honorar.js:317` (`el.innerHTML = _brandify(…)`) og
i print-stien.

En band-admin sætter `contactName` til markup; enhver der åbner kontrakt-previewet
eller printer, kører det. Bivirkning: en escapet brugerværdi der tilfældigvis
indeholder `__BAND_NAME__` bliver substitueret bagefter — escaping kan altså
ikke stole på at holde.

**Rettelse:** escape map-værdierne i `_brandify`, eller kør substitutionen før
escaping pr. felt.

### M6 — Ugentlig backup er ukrypteret, og alle bands ligger under ét præfiks

`services/backup.js:63-72` skriver `JSON.stringify(...)` direkte til R2 som
`application/json`. Filens egen kommentar siger at kopien indeholder
medlemmernes navne, adresser, telefonnumre og e-mail. Alle bands ligger under
`_backups/` (`:36`), bevidst uden for det per-band-præfiks der ellers giver
isolationen.

Det er det ene sted hvor "ét DO pr. band"-princippet brydes: ét kompromitteret
R2-token eller én operatørkonto giver læseadgang til samtlige bands persondata i
klartekst.

CPR er ikke med, opbevaringen er hård og dokumenteret (8 uger), `getBackup`
validerer præfikset, og bucket'en er EU-jurisdiktion uden offentlig adgang. Det
er ordentligt — kun krypteringen mangler.

**Rettelse:** krypter indholdet i `putBackup`; `lib/crypto.js` har allerede det
der skal bruges.

### M7 — Booker-tokens ignorerer bookerens tilstand, og bookere kan ikke skifte kode

`verifyBooker` er ren signaturkontrol (`auth/verify.js:85-87`), `bt:`-payloaden
indeholder kun `{email, exp}` uden `pwFp` (`lib/tokens.js:37-38`), og `harAdgang`
tjekker bandets status, aldrig bookerens (`actions/booker.js:136-142`).

Sætter operatøren en booker til `inactive`, beholder bookeren fuld adgang i op
til otte timer og kan blive ved med at sende tilbud. Det samme gælder efter en
adgangskode-nulstilling: det gamle token overlever.

Dertil sætter `operatorSaveBooker` `forcePasswordChange: 1` (`:272`), men der
findes ingen `bookerChangePassword`-action, og `/api/change-password` afviser alt
andet end `kind === 'member'` (`worker.js:329`). Bookere sidder permanent på den
engangskode operatøren læste op i telefonen.

**Rettelse:** læg `pwFp` i `bt:`-tokenet, verificér `status === 'active'`, og
tilføj en booker-sti i `apiChangePassword`.

### M8 — Ingen absolut sessionslevetid

Sessionsobjektet har intet `createdAt`, og hver `saveSession` sætter TTL'en
forfra (`worker.js:221`). De otte timer i `02-auth.js:110` er ren UI-kosmetik. Et
stjålet `sid` kan holdes i live for evigt med ét `/api/session`-kald i døgnet — og
`refreshSession` tæller bevidst ikke mod lockout.

**Rettelse:** gem `loginAt` og afvis fornyelse efter fx syv dage.

### M9 — Kontoeksistens kan aflæses på svartid og på fejlbeskeden

Alle tre logintyper springer KDF'en over når brugeren ikke findes
(`auth/verify.js:43-46`, `actions/operator.js:45-48`, `actions/booker.js:52-53`).
Fejlteksterne er pænt ens, men 10.000 PBKDF2-iterationer er en målbar konstant.
For bookere er det direkte i modstrid med filens egen erklærede målsætning
(`booker.js:26-28`).

Dertil to talende beskeder: `auth.js:63-66` returnerer "**N forsøg tilbage**", så
en angriber kan køre fire forsøg og pause i stedet for at ramme spærringen. Og
`auth.js:47-50` giver en unik besked for suspenderet band **før** enhver
credential-kontrol.

**Rettelse:** kør en dummy-`verifyHash` mod et fast salt når brugeren ikke
findes; drop `remaining` fra teksten; giv suspenderet band den generiske fejl.

### M10 — Ingen grænse på request-body, og bodyen parses før rate-limiten

`apiLogin`, `apiOperatorLogin`, `apiBookerLogin` og `apiSign` kalder alle
`request.json()` **før** `ipRateLimited` (`worker.js:242-249` m.fl.). Der findes
ingen `Content-Length`-kontrol nogen steder; det eneste loft er `MAX_ASSET_BYTES`,
som tjekkes efter at hele payloaden er materialiseret. Der er heller intet
metodetjek — ruterne svarer på alt.

En 100 MB body til `/api/login` bliver afvist med 429, men først efter at
isolatet har parset den.

**Rettelse:** afvis `Content-Length > 6 MB` øverst i `fetch`, og flyt
rate-limit-tjekket op før `request.json()`.

### M11 — Lockout-rækker vokser uden oprydning, i MasterDO

`penalizeLogin` (`do/band.js:1439`) og `#penalize` (`do/master.js:388`) opretter
en `band_meta`-række pr. forsøgt e-mail. Rækken slettes kun hvis netop den
e-mail forsøges igen efter vinduets udløb. `runRetention` rører ikke
`band_meta`, og MasterDO har ingen retention overhovedet.

En million POSTs til `/api/operator-login` med opdigtede e-mails giver en million
permanente rækker i **MasterDO** — det ene objekt alt andet skal igennem. Det
bryder samtidig jeres egen regel om at hot path aldrig må røre MasterDO: hvert
uautentificeret operatør-loginforsøg serialiseres gennem det enkelttrådede
masterobjekt.

**Rettelse:** ryd udløbne `loginlock:`/`oplock:`/`bklock:` i cron'en, og opret
kun rækken når e-mailen faktisk findes (kombineret med den fælles tæller i H5).

### M12 — PBKDF2 med 10.000 iterationer, og 6 tegns minimum kun i browseren

`PW_ITERATIONS = 10000` (`wrangler.toml:60`). Koden erkender selv at OWASP
anbefaler 600.000. Serveren validerer kun at hashet er 64 hex-tegn
(`actions/auth.js:107`) — minimumslængden på **6 tegn** findes udelukkende i
`public/js/02-auth.js:51`, altså i klienten, hvor den ikke er en kontrol.

Saltet er 16 tilfældige bytes pr. bruger, så rainbow tables er udelukket, og de
genererede engangskoder (~81 bit) er ukrakbare. Problemet er de selvvalgte: en
6-tegns kode med små bogstaver og tal falder på under en time på ét GPU efter et
databrud.

`needsRehash` opgraderer automatisk, så iterationstallet er én env-var væk. Men
det kræver Workers Paid, jf. kommentaren i `wrangler.toml:50-57`.

**Rettelse:** håndhæv længden server-side, og hæv iterationerne samme dag I
skifter plan.

---

## LAV

- **L1 — `/api/sign` deler rate-limit-nøgle med login** og straffer *hvert* kald,
  ikke kun fejlede (`worker.js:557-558`). En arrangør der genindlæser siden 20
  gange spærrer samtidig alle login fra samme IP i 15 minutter. Ramt hårdest på
  et spillesteds delte WiFi. Egen nøgle, fx `rls:`.
- **L2 — iCal-feedet er `Cache-Control: public`** (`worker.js:93`) og indeholder
  **udkast og interne noter**, fordi `buildIcal` ikke filtrerer på status
  (`crossband.js:204,219`). Sæt `private`, og filtrér til godkendte.
- **L3 — Signeringslinket kan ikke tilbagekaldes.** `resendSigningLink` skriver
  `setBookingTokenExp`, men `validerSigneringstoken` læser aldrig `row.tokenExp`
  (`bookings.js:312-334`). Det gamle link virker videre i sine fulde 14 dage.
- **L4 — Ingen kvittering til arrangøren.** `sign.js:72` lover "en kvittering er
  sendt til din e-mail", men `bookings.js:399` sender kun til bandets admins. En
  underskrift kan derfor ske uden at den påståede underskriver opdager det.
- **L5 — Operatør-tokens overlever operatørens eget kodeskift**
  (`actions/operator.js:137-144`) — der er intet `pwFp` i payloaden. Eneste
  nødbremse er at rotere `MASTER_SECRET`.
- **L6 — `forcePasswordChange` håndhæves kun i browseren.** Login returnerer et
  fuldt gyldigt token uanset (`actions/auth.js:30-33`).
- **L7 — Cookien mangler `__Host-`-præfiks.** `workers.dev` står på Public Suffix
  List, så en søster-Worker på samme konto kan sætte en domæne-cookie der vinder i
  `parseCookies`. Koden opfylder allerede alle krav til præfikset — det mangler
  bare i navnet.
- **L8 — CSRF hviler alene på `SameSite=Strict`.** Ingen `Origin`-kontrol nogen
  steder, og `apiCall` tjekker ikke `Content-Type`. Tilstrækkeligt i dagens
  browsere, men ét attribut fra et reelt hul.
- **L9 — `escapeHtml` i et `onclick`-attribut er ikke sikkert**
  (`09-boot.js:551`): HTML-parseren dekoder `&#39;` tilbage til `'` før
  JS-parsing. Reelt self-XSS i dag, men mønstret er en fælde.
- **L10 — `icalEsc` escaper ikke `\r`** (`crossband.js:157-160`).
- **L11 — `Db.insert`/`Db.update` konkatenerer kolonnenavne** (`lib/sql.js:84,97`).
  Ingen kalder sender i dag rå klientnøgler ind, men det er den eneste
  konstruktion i kodebasen der overhovedet kunne blive til SQL-injection.
  Valider mod `/^[a-z_][a-z0-9_]*$/` — det koster intet og lukker vejen permanent.
- **L12 — PII i logs, to steder:** `actions/import.js:152` logger en e-mail, og
  `services/sidecar.js:61` logger 200 tegn af et ikke-JSON-svar fra en sti hvor
  requesten indeholdt CPR.
- **L13 — Manglende `Permissions-Policy`**, plus COOP/CORP. Enkeltlinjes gevinst,
  når K2 alligevel skal rettes.
- **L14 — Alle id'er er sekventielle** (`inv1`, `bkg1`, `m1`, fakturanumre
  `2026-001`). Adgangskontrollen holder, så konsekvensen er at en admin kan
  aflæse eget bands forretningsvolumen af nummerrækken.
- **L15 — Rigtige persondata i git:** `brand-presets/dmdt.json:29-30` indeholder
  et navn og en mailadresse. Uden for `public/`, så det serveres ikke.
- **L16 — Den dokumenterede tilbagerulningssti er død.** `wrangler.toml:38-42`
  udpeger `BACKEND="sheets"`, men `Code.gs` er overskrevet af sidecaren. Ikke en
  sårbarhed, men en falsk antagelse i en fil man læser under pres.
- **L17 — Hele operatør- og booker-UI'et sendes til enhver besøgende**
  (`index.html:167-178`). Hver action er gated serverside, så det er ikke et hul
  — men det er gratis rekognoscering af det privilegerede API.
- **L18 — De skjulte ruter afslører deres egen eksistens:** `_selftest`,
  `_bench`, `_diag` og `_bootstrap` svarer JSON-404, mens ukendte stier får
  asset-handlerens 404. Ren rekognoscering; ingen af tokenne kan gættes.

---

## Dokumenteret, men ikke gjort

Fra `SECURITY-PLAN.md`, som ikke er opdateret siden 2026-06-19:

- Fase 0, alle tre punkter står uafkrydsede: ikke-default `APP_SHARED_TOKEN` (H8),
  CSP på dokumentet (K2), password-minimum på 12 tegn (M12).
- Fase 3: Argon2id. Ikke sket; PBKDF2 med 10.000 iterationer er stadig i drift.
- Tjeklisten før offentliggørelse: intet punkt afkrydset — GDPR-dokumentation af
  CPR-behandling, sikker opbevaring af master-secret/CPR-nøgle, og beslutningen
  om målgruppe (trusted vs. åben).

Fra `HANDOVER.md:786-812`:

- `/api/_diag` bør væk (M3); efterlod `__diag__` og `bench` som engangsobjekter i
  produktion.
- Operatør-tokens kan ikke revokeres uden at rotere `MASTER_SECRET` (L5).
- Mail er ikke sat op — `RESEND_API_KEY` og `MAIL_FROM` mangler, og domænet skal
  SPF/DKIM/DMARC-verificeres.
- Cron kører, men finder nul bands i master.
- 12-trins gennemklikningen inkl. isolationstesten er aldrig kørt i sin helhed.
- iCal-feedet er aldrig prøvet med et gyldigt token.

Og fra jeres egen projekthukommelse: de ~467 grønne selvtest-tjek beviser ikke at
frontendens parameternavne matcher backendens. M1 er endnu et eksempel — denne
gang på at de heller ikke beviser at svarets *form* matcher hvad siden læser.

---

## Hvad der er genuint solidt

Dette er ikke høflighed. Flere af punkterne er bedre end i de fleste kodebaser.

1. **Nul runtime-afhængigheder.** `worker/package.json` har kun `wrangler` som
   devDependency; alle 90 pakker i lockfilen er `dev: true`. Frontenden loader
   intet tredjeparts-JS. Der er praktisk talt ingen forsyningskæde at angribe.
   Eneste undtagelse: pdf.js hentes runtime fra cdnjs uden SRI.
2. **SQL-laget er reelt injection-frit.** Ikke én brugerværdi konkateneres — heller
   ikke i `LIKE`, `LIMIT` eller de dynamisk sammensatte `WHERE`-klausuler. Selv
   settings-*nøgler* bindes som parametre, og `PRAGMA table_info` er regex-vagtet.
3. **Action-tabellen fejler lukket.** Hver action skal erklære `scope` + `auth`,
   routeren afviser en ukendt værdi (`router.js:24-27`), og `validateActionTable`
   håndhæver det i test. Alle 85 actions gennemgået: kun `getFeedUrl` og
   `rotateFeedToken` bryder mønstret (H2). Selv prototype-nøgler som
   `ACTIONS['constructor']` fejler lukket.
4. **Ét DO pr. band giver fysisk tenant-isolation.** Der findes ingen
   `band_id`-kolonne at glemme i en `WHERE`. Ejerskab håndhæves i selve
   forespørgslen (`WHERE id = ? AND member_id = ?`), ikke med et tjek bagefter.
5. **Token-håndteringen.** Rolle-præfiks bundet til rolletjek i `verifyToken`
   (`lib/tokens.js:50-80`), konstant-tid signaturkontrol, `pwFp` der dræber
   udestående medlems-tokens ved kodeskift, og hverken medlems-, operatør- eller
   booker-token når nogensinde browseren.
6. **Ingen CORS overhovedet.** Ikke én `Access-Control-*`-header i kodebasen.
   Kombineret med `SameSite=Strict; HttpOnly; Secure` kan intet fremmed origin
   kalde API'et.
7. **CPR-håndteringen.** AES-GCM med `v3:`-præfiks, dedikeret 32-byte nøgle med
   længdetjek, nyt 96-bit tilfældigt IV pr. kryptering, fejler lukket på alle
   fejlformer. Nummeret hentes ét sted, når kun PDF-rendereren, og streames med
   `no-store`. Arkivkopien er CPR-fri fordi nummeret **aldrig hentes** — ikke
   fordi det fjernes bagefter. Den forskel er den rigtige.
8. **Signeringsflowets orakel-disciplin.** Én fælles afvisningsbesked fra to
   uafhængige lag, `docHash` bundet til indholdet og sammenlignet konstant-tid,
   genafspilning blokeret af statusmaskinen, `memberNote` bevidst holdt ude af
   snapshottet — og selvtesten kører syv afvisningsårsager mod hinanden.
9. **Fakturaruterne.** Begge kræver session + `kind==='member'` + admin, `bandId`
   tages fra sessionen, `no-store`, og samme 404 for "findes ikke", "slettet" og
   "aldrig arkiveret". Ingen id-optælling mulig.
10. **Mass assignment er lukket overalt.** Otte skrivestier, alle med eksplicit
    hvidliste. `memberUpdateProfile` udelader bevidst `role`, `email` og
    `regAccount`. Ingen `Object.assign(record, body)` findes.
11. **`getBackup`s præfikstjek** (`backup.js:137`) er forsvar i dybden man normalt
    ikke finder: nøglen kommer fra en liste systemet selv har lavet, og valideres
    alligevel — med en kommentar der forklarer hvilket angreb det stopper.
12. **`/api/_bootstrap` er dobbelt beskyttet:** konstant-tid tokenkontrol *og*
    inert så snart der findes én operatør. Et glemt token er ikke en bagdør.
13. **Assets-afgrænsningen er rigtig.** `[assets] directory = "../public"`, så
    `wrangler.toml`, `brand-presets/`, `HANDOVER.md`, `apps-script/` og
    `settings-template.md` er utilgængelige. Alle otte probes gav 404 med 0 bytes.
14. **Secrets er rene.** Otte hemmeligheder, alle som Worker secrets, ingen i
    `[vars]`. `.dev.vars` gitignoreret fra første commit og aldrig committet. 73
    commits gennemsøgt: ingen nøgler, ingen persondata, ingen slettede filer med
    hemmeligheder. Kun `APP_TOKEN_DEFAULT` (H8).
15. **Ingen debug-endpoints åbne i produktion.** `SELFTEST` sættes kun via
    `wrangler dev`. Live-verificeret: `_selftest` og `_bench` svarer 404.
16. **Kommentarerne dokumenterer trusselsmodellen, ikke koden.** Flere steder hvor
    en fejl kunne ventes — `appToken` sat *efter* spread af klientens body i både
    `worker.js:184` og `backend.js:71` — stod begrundelsen der allerede.

---

## Foreslået rækkefølge

**Først, fordi de er billige og lukker mest:**

1. `public/_headers` med CSP, HSTS, `frame-ancestors` (K2) — én fil, ingen kode.
2. `escapeHtml(title)` i `07-calendar-pdf.js:786` og `:801` (H3) — to tegn.
3. Ret `getFeedUrl`/`rotateFeedToken` til at bruge `ctx.bandId` (H2) — to linjer.
4. Slet `/api/_diag` (M3) — den er allerede erstattet af `bandHealth`.

**Derefter, fordi de kræver eftertanke:**

5. Hvidliste i `syncPasswordAcrossBands` (K1) — beslut hvad SSO *skal* betyde,
   før I koder. Det er en produktbeslutning, ikke kun en rettelse.
6. Fuldfør sessionsflytningen til BandDO (K3) — koden er der og er testet.
7. Escape sceneplan-felterne og valider `color`/tal (H1).
8. Render `d.draft` på signeringssiden (M1) — juridisk vigtigst af de mellemste.
9. Atomar rate-limit + per-band spray-tæller (H5).
10. Valider `bandId` mod master på de to offentlige stier (H6).

**Uafhængigt af koden:**

11. Slet prototypens deployment og regneark (H7).
12. Fjern `APP_TOKEN_DEFAULT` og lad `_appTokenOk` fejle hårdt (H8, H9).

Det er værd at bemærke, at fem af de ti første punkter er "gør det færdigt", ikke
"byg noget nyt".

---

## Status pr. 7. september 2026 — hvad der er rettet

Rettelserne er lavet samme dag som auditten. Selvtesten er kørt efter hver
ændring og står på **528 tjek, alle grønne** (var 513), heraf nye
regressionstests for K1, H6, H5 og M7. De vigtigste rettelser er desuden
verificeret mod en kørende `wrangler dev` med rigtige HTTP-svar, ikke kun
gennem tests.

**Lukket:** K1, K2, H1, H2, H3, H4, H5, H6, H8, H9, M1, M2, M3, M4, M5, M6,
M7, M9, M10, M11, L1, L2, L3, L4, L7, L8, L10, L11, L12, L13, L16, L18.

**Delvist:** K3 og M12 — se nedenfor.

**Ikke gjort, med begrundelse:** H7, L5, L6, L9, L14, L15, L17 — se nedenfor.

### To rettelser hvor gennemgangen ændrede planen

**K1 blev næsten rettet forkert.** Den oplagte rettelse — at gøre
admin-nulstillinger band-lokale — er nødvendig, men lukker ikke hullet. En
anden gennemgang fandt en variant der overlever den: `registerIdentity` seedede
identitetskortet med den midlertidige kode kalderen selv fik udleveret, så en
admin i band X kunne oprette en fremmed e-mail, notere koden, og vente på at
band Y onboardede personen — hvorefter Y kopierede admins kode ind som
"eksisterende konto". Den rigtige invariant er derfor:

> En admin-genereret midlertidig kode må ALDRIG blive den kanoniske
> identitets-hash.

Kun `changePassword`, hvor ejeren selv vælger koden, synkroniserer nu på tværs.

**Token-binding blev fravalgt.** Planen var at lægge `bandId` i `mt:`-tokenet.
Det ville have ødelagt kryds-band: `getAllJobs` og `getAllHonorar` sender samme
token mod hvert bands objekt (`crossband.js:63`), og et bandbundet token ville
fejle i alle andre end login-bandet — stille, fordi fan-out'en springer bands
over uden fejl. Det er ikke nødvendigt for at lukke K1, og det er derfor ikke
gjort.

### K3 — delvist

Den anonyme afbryder er væk: `/api/sign` verificerer nu tokenets HMAC i
Workeren, før den kalder videre, så vrøvl-tokens ikke længere omsættes til
lager-operationer. Almindelig brug rammer heller ikke længere kvoten —
sessionen fornys kun under en time før udløb i stedet for ved hvert kald — og
både læsning og skrivning fejler lukket i stedet for at give 500 på hele appen.

**Men sessionerne ligger stadig i KV.** Selve flytningen til
`BandDO.putSession` er ikke gjort, fordi den er større end den ser ud: en
cookie bærer kun `sid`, så Workeren kan ikke vide hvilket band-objekt den skal
spørge. Det kræver at bandet lægges i cookie-værdien og MAC-signeres (ellers
bliver `loadSession` en fjerde vej til at oprette Durable Objects), et
skema-trin i både BandDO og MasterDO, et sted at lægge operatør- og
booker-sessioner, og at `subject` gemmes som medlems-**id** frem for e-mail —
ellers holder `setMemberPassword` lydløst op med at dræbe sessioner. Det er en
selvstændig opgave med egen testrunde, ikke en linjeændring.

### M12 — så langt det kan lade sig gøre

Serveren modtager `sha256(password)`, aldrig koden selv. Den kan derfor ikke
måle længde, tegnsæt eller entropi, og minimumsgrænsen i browseren er kosmetik
for enhver der taler direkte med API'et. Det der KAN gøres uden at ændre
protokollen er at genkende hashen af de koder folk faktisk vælger — det er
`lib/weak-passwords.js`, håndhævet i alle tre kodeskift-stier. Klientgrænsen er
samtidig hævet fra 6 til 12 tegn.

Ægte længdehåndhævelse kræver at adgangskoden sendes over TLS og hashes
serverside. Det er en protokolændring, og den bør tages sammen med beslutningen
om at hæve `PW_ITERATIONS`, som alligevel kræver Workers Paid.

### Kræver din hånd — kan ikke gøres fra repoet

1. **`wrangler secret put BACKUP_KEY`** (32 bytes base64). Sikkerhedskopier
   krypteres nu, men kun hvis nøglen er sat. Uden den skrives kopien stadig —
   man skal ikke stå uden backup den dag man har brug for den — men svaret fra
   `runBackupNow` bærer en advarsel. Kommandoen til at generere står i
   `worker/wrangler.toml`.
2. **`APP_SHARED_TOKEN` som Script Property** i Apps Script-projektet. Den
   hardkodede default er fjernet, og `_appTokenOk` fejler nu lukket uden den.
   Det rører ikke driften i dag, fordi projektet kører sidecaren — men det gør
   tilbagerulningsstien ubrugelig indtil hemmeligheden er sat.
3. **H7 — slet prototypens deployment og regneark.** Det er projektets mest
   følsomme datasæt (CPR pr. medlem) på den mindst vedligeholdte flade. Kan kun
   gøres i Apps Script-editoren og Google Drive.
4. **Gen-deploy af `Code.gs`** hvis tilbagerulning nogensinde bliver aktuelt.
   H9-rettelsen ligger i filen, men filen er ikke udrullet.

### Fravalgt, med begrundelse

- **L5 (operatør-tokens overlever kodeskift)** kræver et sted at registrere
  operatør-sessioner. Det falder naturligt ud af K3's flytning og bør laves
  sammen med den — ikke som en separat halv løsning.
- **L6 (`forcePasswordChange` håndhæves kun i browseren)** er reelt lav: UI'et
  har ingen udvej, så kun den der taler direkte med API'et kan springe over —
  og det er personen selv, med deres egen midlertidige kode. Serverside-gaten
  vender ~30 selvtests røde, fordi testene opretter medlemmer med flaget sat og
  derefter kalder actions som dem. Det er en oprydning der fortjener sin egen
  runde frem for at blive hastet med her.
- **L9 (`escapeHtml` i et `onclick`-attribut)** er self-XSS i dag: kun
  operatøren kan oprette bookere. Mønstret er stadig en fælde, og den rigtige
  rettelse er at fjerne alle ~102 inline `onclick`-attributter til fordel for
  `addEventListener` — hvilket samtidig ville tillade at `'unsafe-inline'`
  fjernes fra CSP'en. Det er en mekanisk, men bred ombygning af hele frontenden.
- **L14 (sekventielle id'er)** — adgangskontrollen holder, så konsekvensen er
  at en admin kan aflæse eget bands fakturavolumen. Ikke værd at ændre.
- **L15 (persondata i `brand-presets/dmdt.json`)** — filen serveres ikke, og en
  historik-rewrite koster mere end den fjerner. Relevant hvis repoet
  offentliggøres.
- **L17 (hele operatør-UI'et sendes til alle)** — hver action er gated
  serverside, så det er rekognoscering og båndbredde, ikke et hul.

### Fundet undervejs, ikke i den oprindelige audit

- `/sign`-ruten i Workeren kører **aldrig**: Wranglers asset-lag matcher `/sign`
  mod `sign.html` og svarer selv. Den stramme CSP til signeringssiden måtte
  derfor lægges i `public/_headers`, ikke i koden. Målt lokalt.
- Spray-tælleren blev ikke øget når per-e-mail-låsen fyrede først. En rigtig
  angriber rammer det ikke — de bruger hver adresse én gang — men en låst konto
  er stadig et fejlet forsøg mod bandet, og det tælles nu med.
- `json_extract` i Durable Objects' SQLite var en antagelse i oprydnings-SQL'en.
  Den er nu dækket af en test frem for at blive opdaget en nat kl. 02.
