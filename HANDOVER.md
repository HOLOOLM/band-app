# Overdragelse — datalag migreret til Cloudflare Durable Objects

**Skrevet 2026-08-27, opdateret 2026-08-29. Læs denne først i en ny chat.**

Planen ligger i `~/.claude/plans/we-need-to-create-joyful-pancake.md` (563 linjer,
opdateret undervejs). Den er autoritativ på *hvorfor*; dette dokument er
autoritativ på *hvor vi er*.

---

## Tilstand lige nu

| | |
|---|---|
| Alle faser (1–6) | **Kodet, testet og deployet** |
| Selvtest | **467 tjek, alle grønne**, verificeret idempotent over gentagne kørsler |
| Kontraktrevision | **Ren** — `node worker/tools/audit-actions.mjs` |
| Ny Worker-kode | ~10.700 linjer i 46 moduler, 78 actions |
| `Code.gs` → sidecar | 4.762 → 219 linjer (`apps-script/Sidecar.gs`) |
| **I DRIFT** | **JA.** `BACKEND = "do"` siden 29/8 — Durable Objects er datalaget |
| Fakturaarkiv | Bucket `band-app-arkiv`, EU-jurisdiktion, oprettet 28/8 |
| Sidecar | Kører på det gamle Apps Script-projekt, verificeret 29/8 |
| Operatør | Oprettet 29/8. `BOOTSTRAP_TOKEN` skal være slettet igen |
| Bandet `dmdt` | Oprettet på det nye lag, branding + logo på plads 29/8 |
| **NÆSTE** | **Migrér prototypens data ind — se skridt 7** |

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

### 7. Migrér prototypens data ind  ← START HER

Hele værktøjet er bygget og testet. Det der mangler, er at køre det.

**7a. Tæl hvad der ligger.** Åbn PROTOTYPENS Apps Script-projekt — det med
deployment `AKfycbxQlGk_…` og regneark `1bwk_Bj2LADx_JgE6w1GlwPsos4JlnGAD5CO2gWmIV4w`.
Ikke sidecarens. Tilføj `apps-script/Eksporter-fra-prototype.gs` som en EKSTRA
fil (**rør ikke prototypens `Code.gs`** — den skal blive ved med at virke), og kør
`taelAlt()`.

**7b. Eksportér.** Kør `eksporterAlt()`. Loggen giver en Drive-URL til en privat
JSON-fil. **Filen indeholder persondata inkl. CPR** — slet den fra Drive OG
papirkurven når importen er verificeret, og læg den aldrig i repoet.

`eksporterPdfer()` skal formentlig IKKE bruges — se nedenfor.

**7c. Opret et TOMT band.** Importen afvises hvis bandet allerede har medlemmer,
og `dmdt` har din admin på `m1` — samme id som prototypens første medlem. Opret
enten et nyt band uden at udfylde admin-felterne, eller slet `dmdt` og opret det
forfra uden admin.

**7d. Importér.** `importBandData` med `{ bandId, data: <hele JSON-filen> }`.
Svaret indeholder `startkoder` — én pr. medlem. **De vises kun én gang.** Skriv
dem ned og fordel dem; hvert medlem tvinges til at skifte ved første login.

**7e. Efterarbejde.** Indtast bandets CPR under Indstillinger (eksportens
`_bandCpr` viser værdien). Klik ☁ Arkivér på hver afregning, så de lægges i R2.

### Prototypens fakturaer er ALDRIG blevet arkiveret

Vigtigt fund 29/8: alle tre afregninger i prototypen viser knappen *"☁ Arkivér
til Drive"*, ikke *"↗ Drive"*. I prototypens egen kode er det else-grenen for
`i.driveUrl` — altså er `driveFileId` tom på dem alle.

Der er derfor **ingen PDF'er at flytte**. Rækkerne (nummer, kontrakt, beløb,
dato, status) kommer med i den almindelige import, og PDF'en dannes på ny i det
nye lag med ét klik. Det er endda den bedre vej: den nye arkivkopi er
strukturelt CPR-fri, mens prototypens fjernede CPR med et regulært udtryk
bagefter.

`importInvoicePdfs` og `eksporterPdfer` bliver liggende til et band der
FAKTISK har Drive-arkiverede fakturaer.

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

## Migrering fra DMDT-prototypen (29/8)

Prototypen har **intet eksport-endpoint**, og dens data ligger i sit eget Google
Sheet bag sit eget Apps Script-deployment (`AKfycbxQlGk_…`) — et andet end det
sidecaren overtog. Det projekt er urørt og virker stadig, så data kan hentes
uden at røre noget.

**Ud:** `apps-script/Eksporter-fra-prototype.gs` indsættes som en EKSTRA fil i
prototypens projekt (rør ikke dens `Code.gs`). `taelAlt()` tæller, `eksporterAlt()`
skriver en privat JSON-fil i Drive, `eksporterPdfer(0)` henter de arkiverede
faktura-PDF'er i portioner à 25.

**Ind:** `importBandData` og `importInvoicePdfs`, begge operatør-gatede.

### Tre ting følger ikke med, og hvorfor

- **Adgangskoder.** Prototypens hash er en ældre generation som `lib/crypto.js`
  bevidst ikke accepterer. Hvert medlem får en ny startkode og tvinges til at
  skifte. Koderne returneres ÉN gang i importsvaret og kan ikke hentes igen.
- **CPR pr. medlem.** Prototypens Members-ark har en `cpr`-kolonne; den nye
  model har ét band-CPR krypteret i master. Det importeres ingen steder — heller
  ikke i en log. Bandets CPR indtastes under Indstillinger.
- **LoginLog.** Ren historik.

### Værnet der kom ud af testen

Importen skriver med INSERT OR REPLACE på id, hvilket gør den idempotent — en
import der fejler halvvejs kan køres om. Men det betyder også at et id fra
prototypen overskriver en eksisterende række med samme id.

**Og de kolliderer:** `registerTenant` opretter bandets admin som `m1`
(`operator.js:266`), præcis der hvor prototypens første medlem ligger. Selvtesten
afslørede det ved at ni senere tjek pludselig ikke kunne logge ind.

Derfor afvises en import nu, hvis bandet allerede har medlemmer, med mindre
`overskriv: true` sendes. **Importér ind i et tomt band**, eller acceptér
bevidst at admin-rækken erstattes.

### Fakturaerne: intet at flytte for DMDT

`importInvoicePdfs` bevarer originale PDF'er byte for byte frem for at gendanne
dem — en afregning der er sendt til en arrangør bør arkiveres som netop det der
blev sendt.

**Men DMDT har ingen.** Prototypens tre afregninger er aldrig blevet arkiveret
til Drive (se skridt 7). De dannes derfor på ny i det nye lag, hvor CPR-friheden
er strukturel frem for et regulært udtryk. Værktøjet bliver liggende til et band
der faktisk har Drive-arkiver.

## "Kunne ikke hente status" — og revisionens egen blindvinkel (29/8)

Bandlisten i operatør-panelet viste `Kunne ikke hente status` for hvert eneste
band. Årsagen var den samme fejlklasse som i sidste uge: `bandHealth` og
`backupBand` læste kun `p.targetBandId`, mens panelet sender `bandId`
(`09-boot.js:286` og `:929`). `deleteTenant` havde samme problem fra bandets
egen slet-knap, hvor `_apiCall` injicerer `bandId`.

**Det interessante er hvorfor `audit-actions.mjs` ikke fangede det.** Værktøjet
havde `bandId` på sin `HAANDTERET_AF_ROUTER`-liste, fordi routeren bruger navnet
til at adressere bandets Durable Object. Det er rigtigt for `scope: 'band'` — men
for `scope: 'master'` findes der intet band-objekt, og `bandId` er almindelig
nyttelast som action'en selv skal læse. Undtagelsen skjulte altså præcis den
fejl den var lavet for at fange.

Revisionen har nu en tredje tjekklasse for netop det. Den er **valideret ved at
genindføre fejlen**: med `bandHealth` rullet tilbage fejler den med exit 1, med
rettelsen på plads passerer den. Et tjek man ikke har set fejle, beviser intet.

Alle tre actions accepterer nu begge navne, og selvtesten kalder dem med
FRONTENDENS navn — ikke implementeringens. Det var netop dét der gjorde de
tidligere tests blinde.

## Udseende: ti HEX-felter, ikke otte (29/8)

`primaryColorSoft` og `primaryColorDeep` blev gemt af begge editorer, men havde
**intet felt nogen steder** — de blev altid udledt som accent ±22 %. For DMDT's
amber `#E8A867` giver det:

| | Udledt | Prototypen |
|---|---|---|
| soft | `#edbb88` | `#F0BE8A` — praktisk talt ens |
| deep | `#b58350` | `#C68642` — mærkbart mattere |

`_hexDarken` trækker en procentdel fra hver kanal og dæmper dermed mætningen,
så en håndplukket varm mørk-amber kan ikke udledes. Begge har nu felter under
Finjustér nuancer. Tomt felt = udled som hidtil.

**Farveprøvernes synkronisering var envejs.** Vælger man i prøven, skrives HEX i
tekstfeltet — men taster eller INDSÆTTER man HEX, blev prøven stående på den
gamle farve. Det er netop den vej man går når et bands palette flyttes over, og
det så ud som om værdien ikke blev taget imod. Nu går synkroniseringen begge
veje (`opHexTyped`).

Verificeret lokalt end-to-end: alle ti DMDT-farver gemt, genindlæst og
kontrolleret mod de beregnede CSS-variabler — `--accent-deep` står på `#C68642`
og ikke den udledte `#b58350`.

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

## En fejlet build ligner en bestået test (29/8)

Dette kostede mest tid af alt i dag, og det ser ikke ud som en fejl.

Fejler `wrangler dev`s build, **bliver det sidste bundt der byggede ved med at
blive serveret**. `/api/_selftest` svarer derfor stadig `ok: true` — bare med
færre tjek, fordi det er en ældre udgave af koden. Man ser 20 eller 62 grønne
tjek i stedet for 455 og tror at noget er blevet sprunget over, ikke at
oversætteren aldrig accepterede filen.

I dag var årsagerne en dobbelt `const backup` og et ødelagt strengliteral. Ingen
af delene nåede frem som en fejl i svaret.

**Tjek ALTID antallet af tjek mod det forventede.** Er det lavere, så læs
serverloggen (`preview_logs` med `level: "error"`) før du drager nogen
konklusion om testene. Loggen kan desuden vise en forældet fejl efter en
rettelse — genstart serveren for at fremtvinge en ren build.

Beslægtet: `Date.now()` fryses under synkron kørsel i Workers, så vægur-tid kan
ikke måle CPU. Begge fælder har samme form — værktøjet svarer noget der ligner
et resultat, men er det ikke.

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
prototypen, backend-uafhængigt. Rider-teksterne var i forvejen ord-for-ord ens
(23/23 tekster).

**Anvendt og verificeret i produktion 29/8.** Alle ti HEX-værdier plus begge
fonte er læst tilbage som beregnede CSS-variabler på `?band=dmdt` og matcher
prototypen. Logoet er uploadet. Login-skærmen har brandingen FØR login, fordi
`getConfig` bevidst er den eneste offentlige action — bandets navn, farver og
logo er dermed offentlige for enhver der kender band-id'et. Alt andet kræver
session.

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
- **Mail er ikke sat op.** `RESEND_API_KEY` og `MAIL_FROM` mangler, så
  onboarding-mails er døde knapper. Intet andet påvirkes: `sendMail` fejler
  kontrolleret, og hakket i "Opret band" er fravalgt som standard. Kræver et
  domæne verificeret med SPF/DKIM/DMARC i Resend.
- **Rider-teksterne er ikke efterprøvet** mod prototypen efter migreringen.
  `riderTemplates` står tom, hvilket betyder at appens indbyggede skabeloner
  bruges — de er ifølge `dmdt.json` prototypens rider ord for ord. Udfyld
  kontaktfelterne (Jesper Steensbeck / 60 24 60 60, Henning Thiim /
  30 26 97 88), så pladsholderne `__TECH_NAME__` m.fl. falder på plads, og
  sammenlign så én rider.
- **Planens 12-trins gennemklikning** er ikke kørt i sin helhed. Den dækker
  konflikt i to faner, signeringsflow, booker-portal, kryds-band og
  isolationstest. Kan køres når der er et band på det nye lag.

---

## Hvis du starter en ny chat

Sig noget i retning af:

> Læs HANDOVER.md i band-app. Jeg vil fortsætte med skridt 7 — migrering af
> prototypens data.

Alt frem til og med skridt 6 er gjort. Appen er **i drift** på Durable Objects,
bandet `dmdt` er oprettet med fuld branding, og importværktøjet er bygget og
testet. Det der mangler, er at køre eksport og import.

Hukommelsen indeholder allerede de vigtigste beslutninger — se særligt
`do-per-band-architecture` og `cloudflare-worker-deploy-gotchas`.
