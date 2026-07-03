# Band-app (multi-tenant, brand-agnostisk)

Én master Apps Script servicerer N bands. Hvert band har sit eget Google Sheet
til data; brandig (navn, logo, farver, kontakt, bank, rider) ligger i Sheet'ets
`Settings`-fane. Frontenden er én statisk HTML — hvert band får en URL med
`?band=<bandId>` der bestemmer hvilket band der vises på login-skærmen.

## Arkitektur i én sætning

`band-app/index.html?band=X` (single page) + `band-app/apps-script/Code.gs`
(master backend) + N band-Sheets. Tenant-registreringen
(`bandId → sheetId`) ligger i master Script Properties.

## Datakontrol-forhold (læs før onboarding)

Master-scriptet kører under DIN Google-konto og kræver Editor-adgang til
hvert band-Sheet. **Du er dermed teknisk data controller** for alle bands.
Det skal aftales med bandene før onboarding. Tidligere variant (én Apps
Script pr. band, ejet af bandet) er erstattet af denne for at give:

- Ét sted at vedligeholde kode
- Login på tværs af bands med samme HTML
- Samlet operatør-/admin-UI i selve appen (intet separat admin-tool)

## Setup — engangstrin for master-scriptet

1. Lav et tomt "master"-projekt: nyt Google Apps Script-projekt i din Drive (ingen Sheet kobles til).
2. Kopier indholdet af `apps-script/Code.gs` og `apps-script/appsscript.json` ind.
3. Kør `bootstrapMaster_RUN_ME()` — godkend OAuth-popup. Kopier `MASTER_ADMIN_SECRET` fra Execution log. **Vises kun denne ene gang.**
4. Deploy → New deployment → Web app. **Execute as: Me · Access: Anyone**. ("Anyone" er bevidst — alle write-actions kræver email+passwordHash internt; det er nødvendigt for at frontend kan kalde uden Google-login.) Kopier `/exec`-URL.
5. Indsæt URL'en i `js/01-core.js` (`const SCRIPT_URL = '...'`). Upload **hele frontend-mappen** (`index.html` + `app.css` + `js/`-mappen, med struktur bevaret) til en statisk host. **NB:** frontend er ikke længere én fil — `index.html` loader `app.css` og `js/01..09-*.js` via relative stier, så hosten skal kunne servere undermapper (GitHub Pages, Netlify, Cloudflare Pages — IKKE Google Drives enkeltfil-deling). Rækkefølgen `01..09` af script-filerne er bevidst og må ikke ændres.
6. Ret email + password i `setOperator_RUN_ME()` og kør funktionen. Det er dit operatør-login til det samlede admin-UI (passwordet gemmes kun som hash).

## Onboarding & administration — alt sker i appen

Der er **ikke** længere et separat admin-tool. Du administrerer alt fra
operatør-UI'et i selve appen:

    https://din-hosting/index.html?band=__operator

Log ind med operatør-credentialet fra `setOperator_RUN_ME()`.

**Tilføj nyt band (ét trin):** Klik "+ Nyt band" → udfyld bandnavn +
admin-email (band-id foreslås automatisk). Scriptet **opretter selv Google
Sheet'et** (du er data controller, så ingen deling og intet sheetId at
kopiere), initialiserer alle faner, og opretter første admin-bruger med
`seedPassword` (default `skiftmig2026`, tvinges skiftet). Du får en færdig
login-URL til at sende videre.

**Rediger et bands udseende:** Vælg bandet i listen → site-editor med:
- Accentfarve (live-preview) + tema
- Logo-upload
- Rider — som tekst eller PDF
- Identitet, kontakt og bank
- Nulstil en brugers adgangskode

Auto-oprettede band-Sheets samles i Drive-mappen `Band-app/`.

(Valgfrit, kun hvis faktura-modulet skal bruges: CPR sættes i operatør-editoren
under "Bank & CPR" — krypteres server-side, vises aldrig i klartekst igen.)

## Hvilke filer indeholder hvad

- `index.html` — markup + indlæsning af `app.css` og `js/`-modulerne. Læser `?band=<id>` fra URL ved boot, henter band-config via `actGetConfig` (med bandId i payload), applyBranding() før login-skærmen vises. Alle efterfølgende fetch-kald sender `bandId` med. `?band=__operator` åbner det samlede operatør-/admin-UI.
- `app.css` — al styling (udtrukket fra det tidligere inline `<style>`).
- `js/01-core.js … 09-boot.js` — frontend-logikken, splittet pr. ansvarsområde (core/auth/dashboard/contracts/honorar/members/calendar+pdf/admin/boot). Klassiske `<script>`-filer der deler global scope; **load-rækkefølgen 01→09 svarer til den oprindelige kildeorden og skal bevares.** `SCRIPT_URL` + `APP_TOKEN` står i `01-core.js`.
- `apps-script/Code.gs` — master backend.
  - `handle()` sætter `CURRENT_BAND_ID` pr request, validerer tenant findes.
  - `getBandConfig()` læser Settings (5 min cache, namespaced pr. band).
  - Operatør-login: `operatorLogin` → udsteder kortlivet token (HMAC-signeret med `MASTER_ADMIN_SECRET`).
  - Master-actions: `listTenants`, `registerTenant` (auto-opretter Sheet), `updateTenant`, `deleteTenant`.
  - Band-scoped admin-actions: `adminReadConfig`, `adminWriteConfig`, `adminUpsertMember`, `adminDeleteMember`, `adminUploadAsset` (tager `bandId`).
  - Alle admin-/master-actions gates af **enten** operatør-token **eller** HMAC-signatur (`_verifyAdminSignature`).
- `default-logo.png` — kun for reference/test. Det rigtige logo uploades via operatør-UI'et.

## Datasikkerhed

Operatør-UI'et (og et evt. eksternt HMAC-værktøj) kan **kun** kalde de actions
backenden eksponerer. Der findes ingen `adminGetContracts`, `adminGetInvoices`
osv. — hvis du tilføjer en, er det en bevidst beslutning der skal aftales med
bandet. Operatør-token signeres med `MASTER_ADMIN_SECRET` som aldrig forlader
serveren; tokenet udløber automatisk (se `OPERATOR_TOKEN_TTL_SEC`). Audit:

```bash
grep -E "function actAdmin|function actListTenants|function actRegisterTenant" apps-script/Code.gs
```

Skal kun returnere: `actAdminReadConfig`, `actAdminWriteConfig`,
`actAdminUpsertMember`, `actAdminDeleteMember`, `actAdminUploadAsset`,
`actListTenants`, `actRegisterTenant`, `actUpdateTenant`, `actDeleteTenant`.

Bemærk: master-scriptets eksekveringsidentitet HAR teknisk adgang til alle
band-Sheets — actions-begrænsningerne gælder kun fra remote, ikke for nogen der
har direkte adgang til master-scriptet eller Sheet'ene.

## Settings-keys (læses fra `Settings`-fanen i hver band-Sheet)

Se `settings-template.md`.

## Hvad er IKKE med

- Cross-band SSO (samme email i flere bands deler ikke password — Design 2).
- Struktureret rider-editor (vi bruger fri rider-tekst eller PDF-upload).
- Self-service-onboarding for bands (kun operatøren onboarder).
