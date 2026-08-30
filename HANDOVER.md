# Overdragelse — datalag migreret til Cloudflare Durable Objects

**Skrevet 2026-08-27. Læs denne først i en ny chat.**

Planen ligger i `~/.claude/plans/we-need-to-create-joyful-pancake.md` (563 linjer,
opdateret undervejs). Den er autoritativ på *hvorfor*; dette dokument er
autoritativ på *hvor vi er*.

---

## Tilstand lige nu

| | |
|---|---|
| Alle faser (1–6) | **Kodet, testet og deployet** |
| Selvtest | **452 tjek, alle grønne**, verificeret idempotent over gentagne kørsler |
| Kontraktrevision | **Ren** — `node worker/tools/audit-actions.mjs` |
| Ny Worker-kode | ~10.400 linjer i 45 moduler, 76 actions |
| `Code.gs` → sidecar | 4.762 → 219 linjer (`apps-script/Sidecar.gs`) |
| **I DRIFT** | **JA.** `BACKEND = "do"` siden 29/8 — Durable Objects er datalaget |
| Fakturaarkiv | Bucket `band-app-arkiv`, EU-jurisdiktion, oprettet 28/8 |
| Sidecar | Kører på det gamle Apps Script-projekt, verificeret 29/8 |
| Operatør | Oprettet 29/8. `BOOTSTRAP_TOKEN` skal være slettet igen |

Omskiftningen er sket. Google Sheet'et er urørt og kan rulles tilbage til, men
`Code.gs` er overskrevet af sidecaren — se skridt 6 for hvad det koster.

---

## Næste skridt, i rækkefølge

### 1. ~~Indsæt den opdaterede `Code.gs` i Apps Script~~ ✅ GJORT 27/8

De fem nye HEX-felter kan nu gemmes. Før dette filtrerede den kørende `Code.gs`
ukendte nøgler væk med et bart `return`, så man fik "Udseende gemt" og blanke
felter efter genindlæsning.

### 2. ~~Verificér at den live app er intakt~~ ✅ GJORT 27/8

Bandene er **`testband1`** og **`testband2`** — begge testbands, ingen rigtige
data. Det er derfor omskiftningen er lavrisiko.

Verificeret på `https://band-app.jonasholm.workers.dev/?band=testband2`:

- Login-skærmen renderer, **ingen konsolfejl**
- `BAND_ID` og `BAND_CONFIG` udfyldes; temaet anvendes (`--ink-deep: #0A0A0A`)
- **`Code.gs`-deployet tog fat:** alle fem nye HEX-nøgler er nu med i
  `getConfig`-svaret (tomme, men til stede — altså kan de gemmes)
- **iCal-reparationen virker:** `/ical` svarer `Content-Type: text/calendar`,
  mens den gamle URL `?action=ical` svarer `text/html` — netop den fejl der
  gjorde at et kalenderabonnement hentede `index.html`

Jeg har til gengæld verificeret:
- de tre ændrede frontend-filer er hentet fra produktion og parser
- `_applyAppearanceOverrides` udleder præcis som før mod den GAMLE backend
  (`--ink` blev `#171f2c`, samme tal som før migreringen), ingen `undefined`
- `/api/call` går til Apps Script (bevist: Apps Script svarede med sin egen fejl)
- diagnostik-endpointene er lukkede uden og med forkert token

### 3. ~~Opret R2-bucket'en~~ ✅ GJORT 28/8

Bucket `band-app-arkiv` er oprettet med **Specify jurisdiction → European Union
(EU)** og storage class Standard. Bindingen i `wrangler.toml` har
`jurisdiction = "eu"` til at matche.

At deployet overhovedet lykkedes ER verifikationen: Cloudflare afviser en
udrulning hvis en R2-binding peger på en bucket der ikke findes, eller hvis
jurisdiktionen ikke stemmer. `/api/faktura-arkiv` svarer nu 401 mod 404 før
deployet, hvilket bekræfter at den nye kode er live.

`/api/_diag` rapporterer desuden `arkivVirker` — en rigtig skrive-læse-slet-
rundtur mod bucket'en. Kun `true` betyder at arkivering vil virke; at bindingen
findes beviser intet i sig selv, for den kan pege på den forkerte jurisdiktion.

**Vælg aldrig "Automatic"** hvis bucket'en nogensinde skal genskabes — den ville
have placeret data i Eastern Europe uden garanti for at de bliver der.

### 4. Prøv det nye lag lokalt  ← alt herfra er valgfrit (kræver intet fra dig)

```
preview_start med "band-app-do"     → port 8789, BACKEND=do
preview_start med "band-app-selftest" → port 8788, kør GET /api/_selftest
```

`worker/dev.mjs` sætter faste lokale udviklings-hemmeligheder, så rigtige
login- og CPR-flows virker lokalt. **De værdier er offentlige og står i en
versionsstyret fil — de må aldrig bruges i produktion.**

Jeg har allerede klikket igennem lokalt: login, tvunget kodeskift, dashboard,
kontrakter, medlemmer, honorar. Alt renderede korrekt med rigtige tal.

### 5. Sidecaren — Apps Script-siden er ✅ GJORT 29/8

Sidecaren har **overtaget det eksisterende Apps Script-projekt** frem for at få
sit eget. Derfor er `/exec`-URL'en uændret, og `SIDECAR_URL` var kendt på
forhånd. Prisen er at tilbagerulning til Sheets ikke er ét flag længere:
`Code.gs` er overskrevet, så en tilbagerulning kræver **Udrul → Administrer
udrulninger → rediger → vælg en tidligere version** (~5 min), eller at
`apps-script/Code.gs` indsættes igen fra repoet.

Verificeret 29/8: `doGet` svarer `{"ok":true,"sidecar":true}`, og `ping` med det
rigtige token svarer `{"ok":true,"op":"ping"}`.

**`SIDECAR_TOKEN` er lagt op i Cloudflare 29/8**, og `SIDECAR_URL` peger på
projektets `/exec` i `wrangler.toml`. Sidecaren er dermed færdig.

Tre ting afhænger af sidecaren: PDF-dannelse, køreafstand og udgående mail.
**Alt andet virker.** Den arkiverer ikke længere — det gør R2 nu — så den er
skrumpet til 245 linjer og fire operationer.

### Faldgruber der kostede tid (29/8)

- **Drive API v2 kan ikke længere vælges.** Google vælger v3, hvor metoden
  hedder `create` og ikke `insert`. Sidecaren understøtter nu begge.
- **`appsscript.json` havde to Drive-tjenester** efter v3 blev tilføjet oven på
  den gamle v2-linje. Apps Script nægter at gemme: *"tjeneste-id brugt mere end
  én gang"*. Manifestet i repoet er rettet til kun v3.
- **curl uden `-L` giver et TOMT svar.** Apps Script svarer med et viderestil.
  Og `-X POST` sammen med `-L` gentager POST mod viderestillet, hvilket ikke
  virker — brug `-d` alene, eller PowerShells `Invoke-RestMethod`, som er
  langt mindre følsom over for anførselstegn på Windows:

```powershell
$url = '<sidecarens /exec>'
$body = '{"op":"ping","sidecarToken":"<token>"}'
Invoke-RestMethod -Method Post -Uri $url -ContentType 'text/plain' -Body $body
```

Skal sidecaren nogensinde sættes op forfra, står opskriften i hovedet af
`apps-script/Sidecar.gs`.

**Mail mangler stadig** (Del C): `RESEND_API_KEY` som hemmelighed og `MAIL_FROM`
i `wrangler.toml`. Uden dem er onboarding-mails døde knapper — men intet andet
påvirkes: `sendMail` fejler kontrolleret, og hakket i "Opret band" er fravalgt
som standard. Resend kræver at afsenderdomænet verificeres med SPF/DKIM/DMARC.

### 6. ~~Omskiftningen~~ ✅ GJORT 29/8

`BACKEND = "do"` er pushet, deployet landede på 10 sekunder, og operatøren er
oprettet via `/api/_bootstrap`. Bandet `dmdt` er oprettet på det nye lag.

**Tjek at `BOOTSTRAP_TOKEN` er slettet i Cloudflare.** Ruten er inert så snart
operatør-tabellen ikke er tom, men et ubrugt token er stadig et token.

Tilbagerulning kræver nu TO ting, ikke én:

1. `BACKEND = "sheets"` i `wrangler.toml`, commit og push
2. Apps Script: **Udrul → Administrer udrulninger → rediger → tidligere
   version**, fordi sidecaren har overskrevet `Code.gs`

PowerShell-noter fra omskiftningen, som kostede tid:

- `Read-Host` kan returnere tom streng, og indsætning i den kan afkorte uset —
  et 48-tegns token blev til 39. Kontrollér altid `$x.Length` bagefter
- En `$body`-variabel er en KOPI. Retter man `$pw` bagefter, sender kaldet
  stadig den gamle værdi. Byg kroppen inde i selve kaldet:
  `-Body (@{email=$mail; password=$pw} | ConvertTo-Json -Compress)`

**Flaget er pr. band:** `"do:mit-band"` flytter kun det ene. Det fejler mod
Sheets ved enhver tastefejl — tolv tjek håndhæver det.

---

## VIGTIGT før første rigtige CPR-nummer

`CPR_KEY` skal i en password manager. Cloudflare-hemmeligheder er skrive-kun —
mister du den, bliver **alle gemte CPR-numre permanent uafkrypterbare**, og hvert
band skal indtaste sit igen. Det er den eneste hemmelighed hvor tabet er
irreversibelt.

`MASTER_SECRET` bør også gemmes: sætter du en ny, dør alle udestående tokens —
medlemmer logges ud, og signeringslinks hos arrangører holder op med at virke
midt i et forløb.

`SIDECAR_TOKEN` skal matche samme værdi i Apps Scripts Script Properties.

`DIAG_TOKEN` og `BOOTSTRAP_TOKEN` behøver ikke gemmes. `RESEND_API_KEY` kan
hentes i Resend-dashboardet.

---

## Kør denne efter enhver ændring i action-tabellen

```
node worker/tools/audit-actions.mjs
```

Den sammenligner de 63 action-navne frontenden faktisk kalder med
action-tabellen, og fanger tre fejlklasser: en action frontenden kalder som ikke
findes, en action operatør-panelet kalder som en operatør ikke må udføre, og et
parameternavn ingen action læser.

**Hvorfor den findes:** seks fejl slap gennem 440 selvtest-tjek OG en manuel
gennemklikning, fordi begge kalder actions med de navne implementeringen selv
bruger — frontenden bruger andre. `registerTenant` læste `bandId`, men frontenden
sender `newBandId`, så operatøren kunne ikke oprette et band. Tre actions manglede
helt (`adminResetMemberPassword`, `runRetentionNow`, `adminDeleteBand`), og
`bandHealth`, `backupBand` og `archiveInvoiceToDrive` læste forkerte
parameternavne. Alle rettet 27/8; revisionen er ren.

**Test-dækning beviser ikke kontrakt-overholdelse.** Det er den vigtigste lektion
fra dagen, og grunden til at dette værktøj skal køres frem for at man stoler på
grønne tjek.

## Operatør-panelet kunne ikke redigere sine egne bands (29/8)

Operatøren er ikke medlem af noget band og har derfor ingen medlems-session.
Fem actions panelet kalder var alligevel gated som band-admin:

    adminReadConfig  adminWriteConfig  adminUploadAsset  getFeedUrl  rotateFeedToken

Resultatet var at **Rediger-knappen i operatør-panelet svarede "Ikke logget
ind"** — panelet var ubrugeligt fra dag ét. `rotateFeedToken` skrev endda
allerede `ctx.operator ? ctx.operator.email : ...` i revisionssporet: den var
*skrevet* til en operatør, men *gated* som noget andet.

Rettelsen er en udtrykkelig `operatorOk: true` pr. action, ikke en generel
nøgle. Åbnede vi alle band-admin-actions for operatør-tokenet, kunne
operatøren også gemme kontrakter og honorar i et hvilket som helst band — en
rettighed panelet aldrig beder om, og som ville gøre revisionssporet
misvisende: handlingen ville se ud som bandets egen.

**Hvorfor ingen test fangede det:** selvtesten kaldte de fem actions med en
medlems-session, altså med andre rettigheder end panelet faktisk har. Nu
kaldes de med et rent operatør-token, og et modstykke-tjek sikrer at
tilladelsen ikke bliver generel.

`audit-actions.mjs` tjekker nu også denne fejlklasse: enhver action
`09-boot.js` kalder skal kunne udføres af en operatør. Den fandt straks
`getFeedUrl` og `rotateFeedToken`, som ingen endnu var stødt på.

## To fejl fundet ved at flytte arkivet (28/8)

Begge var usynlige for både selvtesten og en gennemklikning, fordi de sad i
noget der *så* ud til at virke.

**1. Arkivet lå i én persons private Drive.** `_archivePdf` i sidecaren skrev til
`DriveApp.getRootFolder()` og kørte "som mig", så hvert bands fakturaer landede i
den deployende Google-kontos eget drev og blev sat til `Access.PRIVATE`. Følgen:
"↗ Drive"-knappen i admin-panelet var **død for alle andre end den ene konto**,
og alle bands delte den persons 15 GB Google-kvote — den samme kvote som
vedkommendes Gmail. Arkivet ligger nu i R2 og hentes gennem
`/api/faktura-arkiv`, som kræver login med admin-rolle.

**2. Arkivkopien ville have indeholdt CPR.** Det her er en regression jeg selv
indførte i porteringen. Den oprindelige `Code.gs:2660` renderer arkivkopien med
`cpr = null`; min Worker-udgave kaldte i stedet `renderInvoicePdf`, som *henter*
CPR. Knappen lover brugeren "uden CPR", så hver arkivering ville have lagt et
CPR-nummer i et arkiv man har fået at vide er harmløst.

Grunden til at intet fangede det: testene så på det svar action'en returnerede,
og CPR'et lå inde i PDF-bytes. Selvtesten aflytter nu den HTML der faktisk
sendes til konvertering, og tjekker at CPR **ikke** er i den — mens bandet
har et CPR, så beviset ikke er sandt af den uinteressante grund at der ingen er.
Otte nye tjek dækker arkivet (`arkiv:` i `/api/_selftest`).

Lektien er den samme som ved kontraktdriften: **et grønt tjek beviser kun det
det faktisk kigger på.** Begge fejl sad i det led ingen test kiggede på.

## Fem arkitekturvalg der er lette at bryde

Bryder man ét af dem, virker det stadig — det bliver bare langsomt eller
usikkert på en måde ingen test fanger. Derfor står de her.

**1. Den varme sti må ALDRIG røre MasterDO.** Et Durable Object er enkelttrådet,
så et opslag i master pr. request gør master til et globalt serialiseringspunkt
for alle bands — samme flaskehals som `_withLock` i Apps Script, blot flyttet.
Bandets flag (`status`, `crossBand`, `booking`) spejles derfor ind i `BandDO`, og
operatørlistens statistik skrives til master af band-objekterne selv.

**2. `band_id` findes ikke på band-tabeller.** Isolationen er fysisk: bandet er
implicit i hvilket objekt man taler med. Tilføjer man kolonnen, er man tilbage i
en model hvor en glemt `WHERE` kan lække. Selvtesten tjekker alle 11 tabeller.

**3. Læsestien skriver ikke.** `_ensureDistance` beregnede og skrev afstande midt
i en jobliste. Nu beregnes afstand kun ved skrivning. Selvtesten beviser det med
SQLites `total_changes()` før og efter.

**4. Migreringer må ikke ligge i konstruktøren.** Objekter hiberneres efter 10
sekunder; opstart er kun under 5 ms hvis konstruktøren er tom. Skemaløft sker bag
et versionstjek i `blockConcurrencyWhile`, og hvert trin skal være kumulativt og
idempotent — der findes ingen samlet migreringskommando.

**5. EU-jurisdiktionen er en del af objektets identitet.** Den kan ikke ændres
bagefter uden at alle bands mister data. Verificeret i produktion 2026-08-27:
`euJurisdiktion: true`.

---

## Faldgruber i miljøet

**OneDrive dræber `wrangler dev`.** Repoet ligger i en synkroniseret mappe, og
OneDrives synkronisering af wranglers lokale tilstand får `workerd` til at crashe
nativt: `*** std::terminate() called with no exception`. Det ser ud som en kode-
eller konfigurationsfejl og er ingen af dem. Start ALTID gennem `worker/dev.mjs`
(begge launch-konfigurationer gør det) — den flytter tilstanden til
`LOCALAPPDATA`.

**Kør wrangler fra `worker/`.** Fra repoets rod henter `npx` en anden version
(4.127 mod den installerede 4.107) med afvigende adfærd.

**PowerShell blokerer `npx.ps1`.** Brug
`node node_modules\wrangler\bin\wrangler.js` i stedet. Og `&&` virker ikke i
Windows PowerShell — brug `;`.

**`curl` i PowerShell er `Invoke-WebRequest`.** Brug `curl.exe`.

**Git Bash ødelægger æøå i curl-bodies.** Skriv JSON til en fil med `\u`-escapes
i stedet. Appen håndterer æøå korrekt — det har jeg bevist.

---

## Ændret i frontenden (live nu)

Kun tre filer, alle bagudkompatible med den gamle backend:

- `public/js/01-core.js` — fem nye HEX-overstyringer (`bgColorCard`,
  `bgColorRaised`, `borderColor`, `textColorDim`, `textColorMute`). Tomme felter
  udleder som før.
- `public/js/09-boot.js` — de fem felter i operatør-panelet under "Finjustér
  nuancer"
- `public/js/03-dashboard.js` — rettede en **allerede eksisterende** fejl:
  dashboardet skrev "Her er status på ." uden bandnavn, fordi
  `<span data-band-name>` udfyldes ved boot, mens dashboardets HTML først
  renderes ved navigation

---

## DMDT-brandingen

`brand-presets/dmdt.json` indeholder DMDT's værdier udtrukket 1:1 fra
prototypen, backend-uafhængigt. Alle 14 CSS-variabler er verificeret identiske
med prototypens `:root`, og rider-teksterne var i forvejen ord-for-ord ens
(23/23 tekster).

`bankKto` står som `1465171` i prototypen men `0001465171` i
`settings-template.md` — **afklar hvad banken bruger** før kontrakter udsendes.

---

## Kapacitet og pris

| Grænse (Free) | Loft |
|---|---|
| DO rækker læst: 5 mio./dag | ~150 bands ← bindende |
| Worker- og DO-requests: 100k/dag | ~660 bands |
| DO-lagring: 5 GB | ~1.600 bands |
| KV-skrivninger: 1.000/dag | irrelevant nu — sessioner ligger i BandDO |

Gratis til omkring 150 bands. Workers Paid ($5/md) dækker ~220 bands inden for
de inkluderede requests; derover koster requests $0,15 pr. million.

**Ydelsen falder ikke med flere bands.** Hvert band har sin egen database, så det
er O(1) i bandantal. Ét sted skalerer med totalen: operatørlistens statistik —
derfor skrives den til master af band-objekterne i stedet for at fanne ud.

`PW_ITERATIONS = 10000` er verificeret inden for gratisplanens 10 ms CPU. Paid er
ikke påkrævet. **Bemærk:** vægur-tid kan ikke måle CPU i en Worker — uret er
frosset under synkron kørsel, så `Date.now()` giver 0 ms. Den gyldige test er
binær: gennemføres requesten, passede den.

---

## Kendte mangler

- **Cron-triggeren er aktiv** (02:00 UTC). Den finder nul bands i master og gør
  ingenting. Harmløs, men den er der.
- **`/api/_diag` bør væk** når `bandHealth` har overtaget. Den efterlod også to
  engangsobjekter i produktion (`__diag__` og `bench`) med en `bandName: "diag"`-række.
- **Operatør-tokens dør ikke ved kodeskift**, som medlems-tokens gør via `pwFp`.
  Er koden kompromitteret, skift `MASTER_SECRET` for at dræbe alle tokens.
- **iCal-feedet var i stykker siden juli** — før dette arbejde. Frontenden byggede
  URL'en som `location.pathname + '?action=ical'`, hvilket pegede på app-roden;
  den gamle Worker havde ingen sådan rute, så et kalenderabonnement hentede
  `index.html`. Rettet 27/8: frontenden peger på `/ical`, og ruten proxyer til
  Apps Script når flaget er `sheets`. Verificeret 27/8: ruten svarer
  `text/calendar`. **Ikke prøvet med et gyldigt token mod et rigtigt
  kalenderprogram** — det kræver et feed-token fra operatør-panelet.
- **Onboarding-emailen var en tom knap** indtil 27/8. Nu implementeret via
  Resend, men kan først virke når `RESEND_API_KEY` og `MAIL_FROM` er sat.
- **Planens 12-trins gennemklikning** er ikke kørt i sin helhed. Den dækker
  konflikt i to faner, signeringsflow, booker-portal, kryds-band og
  isolationstest. Kan køres når der er et band på det nye lag.

---

## Hvis du starter en ny chat

Sig noget i retning af:

> Læs HANDOVER.md i band-app. Jeg vil fortsætte med [skridt N].

Hukommelsen indeholder allerede de vigtigste beslutninger — se særligt
`do-per-band-architecture` og `cloudflare-worker-deploy-gotchas`.
