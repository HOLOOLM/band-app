# `Settings`-fanen — keys og eksempel-værdier

To kolonner: `key` | `value`. Én række pr. nøgle. Læses af `getBandConfig()` med
5 min cache. Sættes typisk via operatør-UI'et (`?band=__operator`), men kan også redigeres direkte i Sheet'et.

| key | type | eksempel | bemærkning |
|---|---|---|---|
| `bandName` | tekst | "Danser med Drenge Tribute" | Vises i kontrakter, PDF-footere, sidetitel |
| `bandShortName` | tekst | "DMDT" | Bruges i filnavne, ICS UID, contract-ID-prefix |
| `bandTagline` | tekst | "Tribute" | Vises under medlemshovedet ("Bandnavn · Tribute · Medlem") |
| `emailDomain` | tekst | "dmdt.dk" | Login-placeholder ("navn@dmdt.dk"), ICS UID-domæne |
| `primaryColor` | hex | "#E8A867" | CSS-variabel `--accent` |
| `primaryColorSoft` | hex | "#F0BE8A" | Hover-tilstand |
| `primaryColorDeep` | hex | "#C68642" | Active-tilstand |
| `theme` | key | "kul" | Tema (baggrund + font): `kul`, `grafit`, `beton`, `stål`, `tåge` |
| `bgColor` | hex | "#101316" | Valgfri HEX-override af baggrund. Tom = brug temaets. Nuancer udledes automatisk |
| `textColor` | hex | "#E8EBEE" | Valgfri HEX-override af tekstfarve. Tom = brug temaets |
| `fontUi` | font-key | "Inter" | Valgfri font (brødtekst). Tom = temaets. Gyldige: Inter, Space Grotesk, IBM Plex Sans, Instrument Serif, IBM Plex Serif, Fraunces |
| `fontDisplay` | font-key | "Fraunces" | Valgfri font (overskrifter). Samme gyldige værdier som `fontUi` |
| `logoFileId` | Drive ID | "1abc…" | Drive file ID til logo (PNG/SVG). Hentes som data-URL ved boot |
| `riderFileId` | Drive ID | "1xyz…" | Drive file ID til en færdig rider-PDF. Hvis sat, **erstatter** den de genererede rider-sider (2,3,4) i kontrakten — renderes side-for-side via PDF.js og indlejres som billeder. Hentes via `actGetRider` |
| `riderText` | tekst (multi-linje) | "Backline: …" | (Legacy) fri rider-tekst. Ingen aktiv frontend-forbruger; `riderTemplates` styrer den genererede rider |
| `riderTemplates` | JSON | `{"Spillested":{"intro":"…","points":["…"]}}` | Rider-skabeloner pr. kontrakttype (intro + punkter) der genereres ind i kontrakt-PDF'en. Tom = indbyggede defaults i frontend. Redigeres i operatør-UI'et. Pladsholdere som `__BAND_NAME__` understøttes |
| `sceneplanFileId` | Drive ID | "1abc…" | Drive file ID til sceneplan-billede (PNG/JPG). Indlejres som side 4 KUN på Festival-kontrakter. Hentes af indloggede brugere via `actGetSceneplan` |
| `contactName` | tekst | "Jesper Steensbeck" | Manager/booking |
| `contactEmail` | tekst | "jesper@steensbeck.dk" | Vises i kontrakt-footer |
| `contactPhone` | tekst | "60 24 60 60" | Vises i rider-intro + kontrakt |
| `contactAddress` | tekst (multi-linje) | "Frejasvej 65\n6840 Oksbøl" | To linjer (split på `\n`) |
| `techContactName` | tekst | "Henning Thiim" | Teknisk kontakt for festival/spillested-rider |
| `techContactPhone` | tekst | "30 26 97 88" | |
| `bankName` | tekst | "Sparekassen for Nr. Nebel og Omegn" | Honorar-betaling |
| `bankReg` | tekst | "9682" | Vises på kontrakt (Reg/Kontonr) |
| `bankKto` | tekst | "0001465171" | Vises på kontrakt (Reg/Kontonr) |
| `payeeName` | tekst | "Peter Hansen" | Kontohaver/udbetalingsmodtager — kan afvige fra kontaktperson. Vises som "Kontohaver" på kontrakt + afsender på honorarafregning. Tom = bandnavn. Gemmes via `adminSaveBillingInfo` (admin-auth) |
| `payeeAddress` | tekst (multi-linje) | "Vejnavn 1\n1234 By" | Kontohavers adresse. Gemmes via `adminSaveBillingInfo` |
| `seedPassword` | tekst | "dmdt2026" | Initialt password ved oprettelse/reset af medlem. Tvinges skiftet ved første login. **Skift før onboarding.** |
| `invoiceFolderName` | tekst | "DMDT Fakturaer" | Navn på Drive-mappe til faktura-arkiv |

## Hvilke keys er offentlige?

`actGetConfig` (kaldes uden auth ved boot) returnerer kun disse:
`bandName, bandShortName, bandTagline, emailDomain, theme, primaryColor*,
bgColor, textColor, fontUi, fontDisplay, contactName, contactEmail,
contactPhone, contactAddress, techContactName, techContactPhone,
riderTemplates` + `logoDataUrl` (logo som data-URL) + `hasRider` (boolean) + `hasSceneplan` (boolean).

`seedPassword`, `invoiceFolderName`, `riderText` og `logoFileId`/`riderFileId`/`sceneplanFileId` returneres ALDRIG offentligt.
(`riderText` hentes af indloggede medlemmer via `actGetRider`; sceneplan-billedet via `actGetSceneplan`.)
