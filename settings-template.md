# `Settings`-fanen — keys og eksempel-værdier

To kolonner: `key` | `value`. Én række pr. nøgle. Læses af `getBandConfig()` med
5 min cache. Sættes typisk via operatør-UI'et (`?band=__operator`), men kan også redigeres direkte i Sheet'et.

> **Alle eksempler er opdigtede** — et fiktivt band, fiktive personer, fiktive
> numre. Ingen af dem må kopieres ind i et rigtigt band. Bank-, kontohaver- og
> `seedPassword`-felterne er desuden markeret **pr. band**: arves de fra et
> andet band, sender et kopieret kontonummer arrangørens penge det forkerte
> sted hen.

| key | type | eksempel | bemærkning |
|---|---|---|---|
| `bandName` | tekst | "Nordlys Kollektivet" | Vises i kontrakter, PDF-footere, sidetitel |
| `bandShortName` | tekst | "NLK" | Bruges i filnavne, ICS UID, contract-ID-prefix |
| `bandTagline` | tekst | "Kvintet" | Vises under medlemshovedet ("Bandnavn · Kvintet · Medlem") |
| `emailDomain` | tekst | "eksempelband.dk" | Login-placeholder ("navn@eksempelband.dk"), ICS UID-domæne |
| `primaryColor` | hex | "#7FB3D5" | CSS-variabel `--accent` |
| `primaryColorSoft` | hex | "#A6CBE3" | Hover-tilstand |
| `primaryColorDeep` | hex | "#4E86AD" | Active-tilstand |
| `theme` | key | "grafit" | Tema (baggrund + font): `kul`, `grafit`, `beton`, `stål`, `tåge` |
| `bgColor` | hex | "#12141A" | Valgfri HEX-override af baggrund. Tom = brug temaets. Nuancer udledes automatisk |
| `textColor` | hex | "#ECEDF1" | Valgfri HEX-override af tekstfarve. Tom = brug temaets |
| `bgColorCard` | hex | "#1A1D26" | Valgfri override af kort/panel-baggrund (`--ink`). Tom = udledt af `bgColor` |
| `bgColorRaised` | hex | "#232734" | Valgfri override af hævede flader/inputs (`--ink-soft`). Tom = udledt |
| `borderColor` | hex | "#2E3342" | Valgfri override af rammer/streger (`--ink-line`). Tom = udledt |
| `textColorDim` | hex | "#C3C7D1" | Valgfri override af sekundær tekst (`--cream-dim`). Tom = udledt af `textColor` |
| `textColorMute` | hex | "#8A8F9C" | Valgfri override af dæmpet tekst/labels (`--cream-mute`). Tom = udledt |
| `fontUi` | font-key | "Inter" | Valgfri font (brødtekst). Tom = temaets. Gyldige: Inter, Space Grotesk, IBM Plex Sans, Instrument Serif, IBM Plex Serif, Fraunces |
| `fontDisplay` | font-key | "Fraunces" | Valgfri font (overskrifter). Samme gyldige værdier som `fontUi` |
| `logoFileId` | Drive ID | "1abc…" | Drive file ID til logo (PNG/SVG). Hentes som data-URL ved boot |
| `riderFileId` | Drive ID | "1xyz…" | Drive file ID til en færdig rider-PDF. Hvis sat, **erstatter** den de genererede rider-sider (2,3,4) i kontrakten — renderes side-for-side via PDF.js og indlejres som billeder. Hentes via `actGetRider` |
| `riderText` | tekst (multi-linje) | "Backline: …" | (Legacy) fri rider-tekst. Ingen aktiv frontend-forbruger; `riderTemplates` styrer den genererede rider |
| `riderTemplates` | JSON | `{"Spillested":{"intro":"…","points":["…"]}}` | Rider-skabeloner pr. kontrakttype (intro + punkter) der genereres ind i kontrakt-PDF'en. Tom = indbyggede defaults i frontend. Redigeres i operatør-UI'et. Pladsholdere som `__BAND_NAME__` understøttes |
| `sceneplanFileId` | Drive ID | "1abc…" | Drive file ID til sceneplan-billede (PNG/JPG). Indlejres som side 4 KUN på Festival-kontrakter. Hentes af indloggede brugere via `actGetSceneplan` |
| `sceneplanJson` | JSON | `{"stage":{"w":8,"h":6},...}` | Redigerbar tilstand fra sceneplan-editoren (operatør-værktøjet) — bruges KUN til at genåbne/redigere en tidligere bygget sceneplan. Aldrig sendt til arrangører; det er PNG'en i `sceneplanFileId` der reelt indlejres i kontrakten |
| `contactName` | tekst | "Ida Krogh" | Manager/booking |
| `contactEmail` | tekst | "ida@eksempelband.dk" | Vises i kontrakt-footer |
| `contactPhone` | tekst | "11 22 33 44" | Vises i rider-intro + kontrakt |
| `contactAddress` | tekst (multi-linje) | "Havnegade 12\n5000 Odense C" | To linjer (split på `\n`) |
| `techContactName` | tekst | "Mads Bang" | Teknisk kontakt for festival/spillested-rider |
| `techContactPhone` | tekst | "55 66 77 88" | |
| `bankName` | tekst | "<bandets bank>" | Honorar-betaling. **Pr. band — arv aldrig fra et andet band.** |
| `bankReg` | tekst | "<4 cifre>" | Vises på kontrakt (Reg/Kontonr). **Pr. band.** |
| `bankKto` | tekst | "<kontonummer>" | Vises på kontrakt (Reg/Kontonr). **Pr. band.** Skriv det som banken skriver det — uden foranstillede nuller, med mindre banken selv bruger dem |
| `payeeName` | tekst | "<kontohaver>" | Kontohaver/udbetalingsmodtager — kan afvige fra kontaktperson. **Pr. band.** Vises som "Kontohaver" på kontrakt + afsender på honorarafregning. Tom = bandnavn. Gemmes via `adminSaveBillingInfo` (admin-auth) |
| `payeeAddress` | tekst (multi-linje) | "<vej>\n<postnr by>" | Kontohavers adresse. **Pr. band.** Gemmes via `adminSaveBillingInfo` |
| `seedPassword` | tekst | "<vælg en ny pr. band>" | Initialt password ved oprettelse/reset af medlem. Tvinges skiftet ved første login. **Pr. band — genbrug aldrig et andet bands.** |
| `invoiceFolderName` | tekst | "Nordlys Fakturaer" | Navn på Drive-mappe til faktura-arkiv |

## Hvilke keys er offentlige?

`actGetConfig` (kaldes uden auth ved boot) returnerer kun disse:
`bandName, bandShortName, bandTagline, emailDomain, theme, primaryColor*,
bgColor, textColor, bgColorCard, bgColorRaised, borderColor, textColorDim,
textColorMute, fontUi, fontDisplay, contactName, contactEmail,
contactPhone, contactAddress, techContactName, techContactPhone,
riderTemplates` + `logoDataUrl` (logo som data-URL) + `hasRider` (boolean) + `hasSceneplan` (boolean).

`seedPassword`, `invoiceFolderName`, `riderText` og `logoFileId`/`riderFileId`/`sceneplanFileId`/`sceneplanJson` returneres ALDRIG offentligt.
(`riderText` hentes af indloggede medlemmer via `actGetRider`; sceneplan-billedet via `actGetSceneplan`.)
