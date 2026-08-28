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
| Selvtest | **440 tjek, alle grønne**, verificeret idempotent over gentagne kørsler |
| Kontraktrevision | **Ren** — `node worker/tools/audit-actions.mjs` |
| Ny Worker-kode | ~10.400 linjer i 45 moduler, 76 actions |
| `Code.gs` → sidecar | 4.762 → 288 linjer (`apps-script/Sidecar.gs`) |
| **I DRIFT** | **Nej.** `BACKEND = "sheets"` — alt kører fortsat på Apps Script |

Det nye datalag er altså bygget færdigt og ligger i produktion, men ingen bruger
det. Frontenden er uændret bortset fra tre filer (se "Ændret i frontenden").

---

## Næste skridt, i rækkefølge

### 1. ~~Indsæt den opdaterede `Code.gs` i Apps Script~~ ✅ GJORT 27/8

De fem nye HEX-felter kan nu gemmes. Før dette filtrerede den kørende `Code.gs`
ukendte nøgler væk med et bart `return`, så man fik "Udseende gemt" og blanke
felter efter genindlæsning.

### 2. Verificér at den live app er intakt  ← START HER

Dette er den ENESTE ting der stadig ikke er tjekket, og det kræver **band-id'et**
— giv det til en ny chat, så kan den indlæse siden, læse konsollen og bekræfte
det. Åbn appen med `?band=<dit-id>`, log ind, og se om branding, logo og
dashboard ser rigtigt ud.

Tjek også et af de nye HEX-felter under Indstillinger → Finjustér nuancer: gem en
værdi, genindlæs, og se om den står der. Det er beviset på at `Code.gs`-deployet
tog fat.

Jeg har til gengæld verificeret:
- de tre ændrede frontend-filer er hentet fra produktion og parser
- `_applyAppearanceOverrides` udleder præcis som før mod den GAMLE backend
  (`--ink` blev `#171f2c`, samme tal som før migreringen), ingen `undefined`
- `/api/call` går til Apps Script (bevist: Apps Script svarede med sin egen fejl)
- diagnostik-endpointene er lukkede uden og med forkert token

### 3. Prøv det nye lag lokalt (kræver intet fra dig)

```
preview_start med "band-app-do"     → port 8789, BACKEND=do
preview_start med "band-app-selftest" → port 8788, kør GET /api/_selftest
```

`worker/dev.mjs` sætter faste lokale udviklings-hemmeligheder, så rigtige
login- og CPR-flows virker lokalt. **De værdier er offentlige og står i en
versionsstyret fil — de må aldrig bruges i produktion.**

Jeg har allerede klikket igennem lokalt: login, tvunget kodeskift, dashboard,
kontrakter, medlemmer, honorar. Alt renderede korrekt med rigtige tal.

### 4. Sæt sidecaren op — så virker PDF, Drive, afstand og mail

Uden denne virker fire ting ikke. **Alt andet virker.**

1. Indsæt `apps-script/Sidecar.gs` i et Apps Script-projekt (opsætningen står i
   filens hoved)
2. Slå Advanced Drive Service til: Tjenester → Drive API → v2
3. Deploy som web app: *Kør som mig*, *Adgang: Alle*
4. Kør `setSidecarToken_RUN_ME()` med samme værdi du uploader nedenfor
5. Upload hemmeligheder og sæt vars:

```
cd worker
node node_modules\wrangler\bin\wrangler.js secret put SIDECAR_TOKEN
node node_modules\wrangler\bin\wrangler.js secret put RESEND_API_KEY
```

Derefter i `worker/wrangler.toml`: `SIDECAR_URL = "<Apps Script /exec>"` og
`MAIL_FROM = "band-app@<dit-domæne>"`.

Resend kræver desuden at domænet verificeres med SPF/DKIM/DMARC, ellers ryger
mailen i spam.

### 5. Omskiftningen, når du vil have det i drift

```
node node_modules\wrangler\bin\wrangler.js secret put BOOTSTRAP_TOKEN
```

Sæt `BACKEND = "do"` i `worker/wrangler.toml`, commit og push. Derefter ét kald,
hvor du vælger din egen kode (mindst 12 tegn):

```
curl.exe -s -X POST -H "X-Bootstrap-Token: DIT_TOKEN" -H "Content-Type: application/json" -d "{\"email\":\"jho@wooduppgroup.dk\",\"password\":\"din-kode\"}" https://band-app.jonasholm.workers.dev/api/_bootstrap
```

Slet så `BOOTSTRAP_TOKEN` igen. Ruten er automatisk inert bagefter (den virker
kun mens operatør-tabellen er tom), men slet den alligevel.

Åbn `?band=__operator`, log ind, opret et band. Tilbagerulning: sæt
`BACKEND = "sheets"` og push.

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
action-tabellen, og fanger to fejlklasser: en action frontenden kalder som ikke
findes, og et parameternavn ingen action læser.

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
- **Ingen har klikket igennem den live app** — kun lokalt. Se skridt 2.
- **iCal-feedet var i stykker siden juli** — før dette arbejde. Frontenden byggede
  URL'en som `location.pathname + '?action=ical'`, hvilket pegede på app-roden;
  den gamle Worker havde ingen sådan rute, så et kalenderabonnement hentede
  `index.html`. Rettet 27/8: frontenden peger på `/ical`, og ruten proxyer til
  Apps Script når flaget er `sheets`. **Ikke verificeret mod et rigtigt
  kalenderprogram** — værd at prøve når band-id'et er kendt.
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
