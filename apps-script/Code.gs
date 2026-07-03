/**
 * Band-app — Apps Script master web app backend (multi-tenant, brand-agnostisk).
 *
 * Én master Apps Script servicerer N bands. Hver request indeholder `bandId`;
 * routing-laget (handle) sætter CURRENT_BAND_ID og åbner det rigtige band-Sheet
 * via tenant-registreringen i Script Properties (TENANT_<bandId>).
 *
 * Mønster: POST med text/plain payload (undgår CORS-preflight). Hver write-action
 * validerer email + passwordHash mod det relevante band-Sheets Members-fane.
 *
 * Branding/config (band-navn, farve, logo, kontaktperson, rider) ligger i hvert
 * bands egen Settings-fane og læses via getBandConfig() med per-band cache.
 *
 * Onboarding:
 *   1. bootstrapMaster_RUN_ME()  — én gang for hele master-scriptet
 *   2. setOperator_RUN_ME()      — én gang; sætter operatør-login
 *   3. Operatør-UI (?band=__operator) → "+ Nyt band" → registerTenant — per band
 *
 * Script Properties:
 *   MASTER_ADMIN_SECRET   — HMAC-nøgle; signerer også operatør-tokens
 *   OPERATOR_EMAIL/HASH   — operatør-login til det samlede admin-UI
 *   TENANT_<bandId>       — JSON {sheetId, name} per band
 *   BAND_CPR_<bandId>     — CPR til faktura-generering per band (sat af band-admin)
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const SHEET_HEADERS = {
  Members: ['id', 'name', 'category', 'instrument', 'phone', 'email', 'regAccount', 'address', 'passwordHash', 'pwSalt', 'forcePasswordChange', 'role', 'createdAt'],
  Contracts: ['id', 'type', 'status', 'arrangoer', 'venue', 'date', 'getIn', 'soundcheck', 'showtimeFrom', 'showtimeTo', 'sets', 'setMinutes', 'musicianCount', 'crewCount', 'guestCount', 'honorar', 'paymentTerms', 'paymentTermsOther', 'notes', 'createdAt', 'updatedAt'],
  Attendances: ['id', 'contractId', 'memberId', 'share', 'status', 'confirmedAt', 'checkedInAt', 'startAddress', 'distanceKm', 'distanceOrigin'],
  Riders: ['type', 'version', 'json'],
  LoginLog: ['timestamp', 'memberId', 'email', 'userAgent'],
  Invoices: ['id', 'contractId', 'invoiceNr', 'date', 'amount', 'status', 'driveFileId', 'driveUrl', 'createdAt', 'paidAt'],
  DistanceCache: ['key', 'origin', 'destination', 'km', 'cachedAt'],
  // Brand/config — key/value rows. Læses via getBandConfig() med 5 min cache.
  Settings: ['key', 'value']
};

// Default-værdier for Settings — bruges som fallback når en key mangler.
const SETTINGS_DEFAULTS = {
  bandName: 'Mit Band',
  bandShortName: 'BAND',
  bandTagline: '',
  emailDomain: 'example.com',
  theme: 'kul',
  primaryColor: '#8A8A8A',
  primaryColorSoft: '#A8A8A8',
  primaryColorDeep: '#5C5C5C',
  bgColor: '',        // valgfri HEX-override af baggrund (tom = brug temaets)
  textColor: '',      // valgfri HEX-override af tekstfarve
  fontUi: '',         // valgfri font-override (UI/brødtekst) — key fra VALID_FONTS
  fontDisplay: '',    // valgfri font-override (overskrifter) — key fra VALID_FONTS
  logoFileId: '',
  riderFileId: '',
  riderText: '',
  riderTemplates: '',  // JSON: { "<kontrakttype>": { intro, points:[] } }. Tom = brug indbyggede defaults i frontend
  sceneplanFileId: '', // Drive file ID til sceneplan-billede (PNG/JPG). Indlejres som side 4 på Festival-kontrakter

  contactName: '',
  contactEmail: '',
  contactPhone: '',
  contactAddress: '',
  techContactName: '',
  techContactPhone: '',
  bankName: '',
  bankReg: '',
  bankKto: '',
  payeeName: '',     // kontohaver/udbetalingsmodtager — kan afvige fra kontaktperson. Vises på kontrakt + faktura
  payeeAddress: '',  // kontohavers adresse (multi-linje, split på \n)
  seedPassword: 'skiftmig2026',
  invoiceFolderName: 'Fakturaer',
  retentionLoginLogMonths: ''   // GDPR-opbevaring: tom/0 = behold alt. Sættes i operatør-UI; auto-sletning er ikke aktiveret endnu.
};

// Settings-keys der må returneres af actGetConfig (uden auth).
// seedPassword, invoiceFolderName og bankoplysninger er bevidst udeladt.
const PUBLIC_CONFIG_KEYS = [
  'bandName', 'bandShortName', 'bandTagline', 'emailDomain',
  'theme', 'primaryColor', 'primaryColorSoft', 'primaryColorDeep',
  'bgColor', 'textColor', 'fontUi', 'fontDisplay',
  'contactName', 'contactEmail', 'contactPhone', 'contactAddress',
  'techContactName', 'techContactPhone',
  'riderTemplates'   // pr. kontrakttype rider-skabeloner; ikke følsomt (sendes alligevel til arrangører)
];

// Settings-keys der kræver admin-auth — bankoplysninger bruges til fakturering.
const BILLING_CONFIG_KEYS = ['bankName', 'bankReg', 'bankKto'];

// ─── Multi-tenant config ─────────────────────────────────────────────────────
//
// Master Apps Script servicerer N bands. Hver request indeholder bandId, og
// CURRENT_BAND_ID sættes per request i handle() før actions dispatches.
// Tenants ligger som Script Properties: TENANT_<bandId> = JSON {sheetId, name}.
// CPR pr. band: BAND_CPR_<bandId>.
//
// Apps Script eksekverer hver HTTP-request i et frisk V8-context, så global
// CURRENT_BAND_ID er request-isoleret (ingen race conditions mellem requests).

const PROP_MASTER_ADMIN_SECRET = 'MASTER_ADMIN_SECRET'; // HMAC delt med admin-tool + signerer operatør-tokens
const PROP_TENANT_PREFIX = 'TENANT_';                   // TENANT_<bandId>
const PROP_BAND_CPR_PREFIX = 'BAND_CPR_';               // BAND_CPR_<bandId> — krypteret AES
const PROP_MASTER_CPR_KEY = 'MASTER_CPR_KEY';           // AES-nøgle til band-CPR kryptering
const PROP_OPERATOR_EMAIL = 'OPERATOR_EMAIL';           // operatør-login (samlet admin i selve appen)
const PROP_OPERATOR_HASH = 'OPERATOR_HASH';             // saltet hash af operatørens password
const PROP_OPERATOR_SALT = 'OPERATOR_SALT';             // salt til operatør-hash
const PROP_APP_FOLDER_ID = 'APP_FOLDER_ID';             // Drive-mappe der samler alle auto-oprettede band-Sheets
const PROP_AUDIT_SHEET_ID = 'AUDIT_SHEET_ID';           // Sheet med operatør-audit-log (oprettes første gang)
const PROP_FEED_TOKEN_PREFIX = 'FEED_TOKEN_';           // FEED_TOKEN_<bandId> — hemmelig token til iCal-kalenderfeed
const PROP_IDENTITY_PREFIX = 'IDENTITY_';               // IDENTITY_<sha256(email)> — central SSO-identitet på tværs af bands
const PROP_APP_TOKEN = 'APP_SHARED_TOKEN';              // delt hemmelighed der valideres på alle doPost-kald (jf. _verifyAppToken)

const OPERATOR_TOKEN_TTL_SEC = 8 * 60 * 60;             // operatør-session gyldig i 8 timer

// Delt app-token (lavt sikkerhedsniveau): bremser casual scraping/abuse af det
// offentlige /exec-endpoint. Værdien er bevidst synlig i index.html — den
// ERSTATTER IKKE token-/password-auth, men kræver at en kalder kender den faste
// streng. Kan roteres ved at sætte Script Property APP_SHARED_TOKEN; ellers
// bruges denne default. Samme værdi skal stå i index.html (APP_TOKEN).
const APP_TOKEN_DEFAULT = 'bandapp-shared-7f3a9c2e8b14d05f';

let CURRENT_BAND_ID = ''; // sættes per request af handle()

function _loadTenant(bandId) {
  if (!bandId) throw _userError('bandId mangler');
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_TENANT_PREFIX + bandId);
  if (!raw) throw _userError('Ukendt band: ' + bandId);
  try { return JSON.parse(raw); } catch (e) { throw _userError('Tenant data korrupt for ' + bandId); }
}

function _listTenants() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const tenants = [];
  Object.keys(all).forEach(k => {
    if (k.indexOf(PROP_TENANT_PREFIX) === 0) {
      try {
        const data = JSON.parse(all[k]);
        tenants.push({ bandId: k.substring(PROP_TENANT_PREFIX.length), sheetId: data.sheetId, name: data.name, status: data.status || 'active', crossBand: !!data.crossBand });
      } catch (e) {}
    }
  });
  return tenants.sort((a, b) => a.bandId.localeCompare(b.bandId));
}

function _getSheetId() {
  if (!CURRENT_BAND_ID) throw _userError('CURRENT_BAND_ID ikke sat — bandId mangler i request');
  return _loadTenant(CURRENT_BAND_ID).sheetId;
}

function _cacheKey(base) { return base + ':' + CURRENT_BAND_ID; }

// ─── Setup ───────────────────────────────────────────────────────────────────

function setupSheet() {
  const ss = SpreadsheetApp.openById(_getSheetId());
  Object.keys(SHEET_HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEET_HEADERS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      _migrateAddMissingColumns(sh, headers);
    }
  });

  // Seed Settings med defaults hvis tom. Admin-tool/onboarding overskriver disse.
  const settings = ss.getSheetByName('Settings');
  if (settings.getLastRow() === 1) {
    const rows = Object.keys(SETTINGS_DEFAULTS).map(k => [k, SETTINGS_DEFAULTS[k]]);
    settings.getRange(2, 1, rows.length, 2).setValues(rows);
  }
}

/**
 * MASTER-SETUP: Kør én gang efter master Apps Script er deployet.
 * Genererer MASTER_ADMIN_SECRET som admin-tool skal bruge til alle HMAC-kald.
 */
function bootstrapMaster_RUN_ME() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_MASTER_ADMIN_SECRET)) {
    throw new Error('MASTER_ADMIN_SECRET findes allerede. Kør rotateMasterSecret() i stedet hvis du vil generere en ny.');
  }
  const secret = rotateMasterSecret();
  // Generer CPR-krypteringsnøgle samtidig
  if (!props.getProperty(PROP_MASTER_CPR_KEY)) {
    props.setProperty(PROP_MASTER_CPR_KEY, _secureRandomBase64(32));
  }
  Logger.log([
    '────────────────────────────────────────',
    'MASTER SETUP OK',
    '────────────────────────────────────────',
    'MASTER_ADMIN_SECRET (kopiér NU — vises kun her):',
    '  ' + secret,
    '',
    'MASTER_CPR_KEY er genereret og gemt i Script Properties.',
    '',
    'NÆSTE SKRIDT:',
    '  1. Deploy → New deployment → Web app',
    '     Execute as: Me  |  Access: Anyone',
    '  2. Kopier /exec-URL → indsæt i index.html SCRIPT_URL',
    '  3. Kør setOperator_RUN_ME() med din email + et password (operatør-login)',
    '  4. Onboard bands i appen: åbn index.html?band=__operator → "+ Nyt band"',
    '────────────────────────────────────────'
  ].join('\n'));
  return secret;
}

/**
 * Sætter operatør-credential (det login der låser admin-/operatør-UI'et op i
 * selve appen via ?band=__operator). Ret email + password og kør funktionen.
 * Passwordet gemmes kun som sha256-hash i Script Properties.
 */
function setOperator_RUN_ME() {
  const email    = 'dig@eksempel.dk';   // ← din operatør-email
  const password = 'SKIFT-MIG';         // ← vælg et stærkt password

  if (email === 'dig@eksempel.dk' || password === 'SKIFT-MIG') {
    throw new Error('Ret email + password i setOperator_RUN_ME() før kørsel.');
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_MASTER_ADMIN_SECRET)) {
    throw new Error('Kør bootstrapMaster_RUN_ME() først — operatør-tokens signeres med MASTER_ADMIN_SECRET.');
  }
  const pf = _newPasswordFields(sha256(String(password)));
  props.setProperty(PROP_OPERATOR_EMAIL, String(email).toLowerCase().trim());
  props.setProperty(PROP_OPERATOR_SALT, pf.pwSalt);
  props.setProperty(PROP_OPERATOR_HASH, pf.passwordHash);
  Logger.log('Operatør sat: ' + email + '. Log ind via index.html?band=__operator');
}

/** Genererer ny MASTER_ADMIN_SECRET. Returnerer base64-nøglen (vises kun i Log én gang). */
function rotateMasterSecret() {
  const secret = _secureRandomBase64(32);
  PropertiesService.getScriptProperties().setProperty(PROP_MASTER_ADMIN_SECRET, secret);
  Logger.log('Ny MASTER_ADMIN_SECRET (kopiér NU): ' + secret);
  return secret;
}

/**
 * Genererer MASTER_CPR_KEY til AES-lignende kryptering af band-CPR.
 * Kør én gang efter deployment — eller kald via bootstrapMaster_RUN_ME() som gør det automatisk.
 */
function setupMasterCprKey_RUN_ME() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_MASTER_CPR_KEY)) {
    throw new Error('MASTER_CPR_KEY findes allerede. Slet den manuelt fra Script Properties hvis du vil generere en ny (ADVARSEL: eksisterende krypterede CPR-værdier vil ikke kunne dekrypteres).');
  }
  props.setProperty(PROP_MASTER_CPR_KEY, _secureRandomBase64(32));
  Logger.log('MASTER_CPR_KEY oprettet. Gem en backup af Script Properties.');
}

// ─── CPR-kryptering ──────────────────────────────────────────────────────────
//
// Encrypt-then-MAC over en HMAC-SHA256-baseret stream cipher:
//   encKey = HMAC(master, 'cpr-enc-v2')   macKey = HMAC(master, 'cpr-mac-v2')   (nøgleadskillelse)
//   random 16-byte nonce → keystream = HMAC(encKey, nonce) → XOR med plaintext
//   tag = HMAC(macKey, nonce ‖ ciphertext)
// Produkt (v2): "v2:" + base64(nonce ‖ ciphertext ‖ tag[32]).
// Sikkerhedsegenskaber: IND-CPA (random nonce, ingen nøglegenbrug) + INT-CTXT
// (en manipuleret værdi afvises i stedet for at dekryptere til en forkert CPR).
//
// BAGUDKOMPATIBILITET: ældre værdier er base64(nonce ‖ ct) UDEN "v2:"-prefix og
// UDEN tag. _decryptCpr genkender dem på det manglende prefix og dekrypterer dem
// med den gamle (uautentificerede) sti. De opgraderes til v2 næste gang CPR gemmes.

// ─── Kryptografisk sikker tilfældighed ───────────────────────────────────────
//
// Apps Script eksponerer IKKE crypto.getRandomValues, og Math.random() er en
// ikke-kryptografisk PRNG (forudsigelig) — uegnet til nøgler, salte og nonces.
// Utilities.getUuid() er derimod RFC 4122 v4, som internt trækker på Java
// SecureRandom (CSPRNG). Vi udleder vilkårligt mange uniforme bytes ved at
// strække en pulje af UUID'er gennem SHA-256 i counter-mode (HKDF-lignende
// expand). Dette er den ENESTE tilladte kilde til hemmeligheder i denne fil.

function _secureRandomBytes(n) {
  const out = [];
  let counter = 0;
  while (out.length < n) {
    const seed = counter + '|' + Utilities.getUuid() + '|' + Utilities.getUuid();
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
    for (let i = 0; i < digest.length && out.length < n; i++) {
      out.push(digest[i] < 0 ? digest[i] + 256 : digest[i]);
    }
    counter++;
  }
  return out;
}

function _secureRandomBase64(n) { return Utilities.base64Encode(_secureRandomBytes(n)); }

// Bevaret navn for CPR-nonce-kaldere; nu CSPRNG-backet.
function _randomBytes(n) { return _secureRandomBytes(n); }

const CPR_V2_PREFIX = 'v2:';

function _masterCprKey() {
  const key = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_CPR_KEY);
  if (!key) throw _userError('MASTER_CPR_KEY ikke konfigureret — kør setupMasterCprKey_RUN_ME()');
  return key;
}

/** Afled to uafhængige undernøgler fra master-nøglen (nøgleadskillelse enc/mac). */
function _cprSubKeys(master) {
  const enc = Utilities.base64Encode(Utilities.computeHmacSha256Signature('cpr-enc-v2', master));
  const mac = Utilities.base64Encode(Utilities.computeHmacSha256Signature('cpr-mac-v2', master));
  return { enc: enc, mac: mac };
}

function _unsigned(bytes) { return bytes.map(b => b < 0 ? b + 256 : b); }

function _encryptCpr(plaintext) {
  const sub = _cprSubKeys(_masterCprKey());
  const ptBytes = _unsigned(Utilities.newBlob(String(plaintext), 'UTF-8').getBytes());
  const nonce = _randomBytes(16);
  const nonce64 = Utilities.base64Encode(nonce);
  const ks = _unsigned(Utilities.computeHmacSha256Signature(nonce64, sub.enc));
  const ct = ptBytes.map((b, i) => b ^ ks[i % ks.length]);
  // tag = HMAC(macKey, base64(nonce ‖ ct)) — binder nonce og ciphertext sammen.
  // Vi HMAC'er base64-strengen (ikke byte-arrayet), da Apps Scripts HMAC ikke har
  // en overload med byte-værdi + streng-nøgle.
  const tag = _unsigned(Utilities.computeHmacSha256Signature(Utilities.base64Encode(nonce.concat(ct)), sub.mac));
  return CPR_V2_PREFIX + Utilities.base64Encode(nonce.concat(ct).concat(tag));
}

function _decryptCpr(ciphertext) {
  const master = _masterCprKey();
  const raw = String(ciphertext || '');

  // v2: autentificeret format — verificér tag FØR dekryptering.
  if (raw.indexOf(CPR_V2_PREFIX) === 0) {
    const sub = _cprSubKeys(master);
    const all = _unsigned(Utilities.base64Decode(raw.substring(CPR_V2_PREFIX.length)));
    if (all.length < 16 + 32) throw _userError('CPR-data er korrupt');
    const tag = all.slice(all.length - 32);
    const nonceAndCt = all.slice(0, all.length - 32);
    const nonce = nonceAndCt.slice(0, 16);
    const ct = nonceAndCt.slice(16);
    const expected = _unsigned(Utilities.computeHmacSha256Signature(Utilities.base64Encode(nonceAndCt), sub.mac));
    if (!_constTimeEq(Utilities.base64Encode(tag), Utilities.base64Encode(expected))) {
      throw _userError('CPR-integritetstjek fejlede — data kan være manipuleret');
    }
    const ks = _unsigned(Utilities.computeHmacSha256Signature(Utilities.base64Encode(nonce), sub.enc));
    const pt = ct.map((b, i) => b ^ ks[i % ks.length]);
    return Utilities.newBlob(pt).getDataAsString('UTF-8');
  }

  // Legacy (uautentificeret) format: base64(nonce ‖ ct) med master-nøglen direkte.
  const all = _unsigned(Utilities.base64Decode(raw));
  const nonce64 = Utilities.base64Encode(all.slice(0, 16));
  const ct = all.slice(16);
  const ks = _unsigned(Utilities.computeHmacSha256Signature(nonce64, master));
  const pt = ct.map((b, i) => b ^ ks[i % ks.length]);
  return Utilities.newBlob(pt).getDataAsString('UTF-8');
}

/**
 * Tilføj manglende kolonner til et eksisterende sheet uden at røre data.
 * Bruges af setupSheet() ved schema-udvidelser så vi ikke behøver manuel migration.
 */
function _migrateAddMissingColumns(sh, expectedHeaders) {
  const lastCol = sh.getLastColumn();
  const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const toAdd = expectedHeaders.filter(h => existing.indexOf(h) === -1);
  if (!toAdd.length) return;
  sh.getRange(1, lastCol + 1, 1, toAdd.length).setValues([toAdd]).setFontWeight('bold');
}

// ─── Maps / distance ────────────────────────────────────────────────────────

/**
 * Beregner kørselsafstand (km) mellem to adresser via Apps Script Maps service.
 * Returnerer { km: number, origin: string } eller null hvis rute ikke kan findes.
 */
function _normalizeAddr(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function _distanceCacheKey(origin, destination) {
  return _normalizeAddr(origin) + ' → ' + _normalizeAddr(destination);
}

function _calcDistance(origin, destination) {
  if (!origin || !destination) return null;
  const key = _distanceCacheKey(origin, destination);
  // Cache-tjek først — sparer Maps-kvote på tværs af medlemmer og loads.
  try {
    const cached = _readAll('DistanceCache').find(r => r.key === key);
    if (cached && cached.km !== '' && cached.km != null && !isNaN(Number(cached.km))) {
      return { km: Number(cached.km), origin: origin };
    }
  } catch (e) {
    // Hvis cache-fanen ikke eksisterer endnu, fortsætter vi til Maps-kald.
    Logger.log('DistanceCache læsefejl (kan ignoreres ved første kald): ' + e);
  }
  try {
    const dir = Maps.newDirectionFinder()
      .setOrigin(origin)
      .setDestination(destination)
      .setMode(Maps.DirectionFinder.Mode.DRIVING)
      .getDirections();
    if (!dir || !dir.routes || !dir.routes.length) return null;
    const meters = dir.routes[0].legs.reduce((s, l) => s + (l.distance ? l.distance.value : 0), 0);
    const km = Math.round(meters / 100) / 10;
    // Skriv til cache så næste gang den samme rute spørges, hopper vi Maps over.
    try {
      _writeRow('DistanceCache', { key: key, origin: origin, destination: destination, km: km, cachedAt: new Date() });
    } catch (e) {
      Logger.log('DistanceCache skrivefejl: ' + e);
    }
    return { km: km, origin: origin };
  } catch (e) {
    Logger.log('Maps fejl: ' + e);
    return null;
  }
}

function _venueAddress(c) {
  if (!c) return '';
  const v = typeof c.venue === 'string' ? _parseJson(c.venue) : c.venue;
  if (!v) return '';
  return [v.address, [v.postnr, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/**
 * Returnerer distance for attendance-rækken. Hvis ikke cached, beregnes og caches automatisk.
 * Manuel re-beregn (actRecalcJobDistance) bruges når brugeren skifter alternativ startadresse.
 */
function _ensureDistance(att, contract, memberHomeAddress) {
  const cachedOrigin = att.distanceOrigin || '';
  const cachedKm = (att.distanceKm !== '' && att.distanceKm != null) ? Number(att.distanceKm) : '';
  const desiredOrigin = att.startAddress || memberHomeAddress || '';
  // Cache hit hvis vi har en km og den blev beregnet fra samme origin som vi vil bruge nu.
  if (cachedKm !== '' && cachedOrigin && cachedOrigin === desiredOrigin) {
    return { km: cachedKm, origin: cachedOrigin };
  }
  const venueAddr = _venueAddress(contract);
  if (!venueAddr || !desiredOrigin) return { km: '', origin: desiredOrigin };
  const r = _calcDistance(desiredOrigin, venueAddr);
  if (!r) return { km: '', origin: desiredOrigin };
  _updateRowById('Attendances', att.id, { distanceKm: r.km, distanceOrigin: desiredOrigin });
  return { km: r.km, origin: desiredOrigin };
}

/**
 * Tvunget genberegning af distance for en specifik attendance.
 * Skriver til sheet'et og returnerer ny værdi.
 */
function _forceCalcDistance(att, contract, memberHomeAddress) {
  const venueAddr = _venueAddress(contract);
  const origin = att.startAddress || memberHomeAddress || '';
  if (!venueAddr) return { km: '', origin: origin, error: 'Spillested mangler adresse' };
  if (!origin) return { km: '', origin: '', error: 'Sæt din hjemmeadresse først' };
  const r = _calcDistance(origin, venueAddr);
  if (!r) return { km: '', origin: origin, error: 'Kunne ikke beregne rute — tjek at adresserne er korrekte' };
  _updateRowById('Attendances', att.id, { distanceKm: r.km, distanceOrigin: origin });
  return { km: r.km, origin: origin };
}

// ─── Routing ────────────────────────────────────────────────────────────────

function doGet(e) {
  // iCal-feed er en capability-URL (token i query) der skal returnere RÅ text/calendar —
  // ikke JSON. Derfor afskæres den FØR handle()/respond() (som tvinger JSON).
  if (e && e.parameter && e.parameter.action === 'ical') {
    return actIcalFeed(e.parameter);
  }
  return handle(e.parameter);
}

function doPost(e) {
  // Frontend sender JSON i request body med content-type=text/plain (undgår CORS-preflight)
  let payload = {};
  try { payload = JSON.parse(e.postData.contents); } catch (err) {}
  const params = Object.assign({}, e.parameter || {}, payload);
  // Lav-niveau adgangsfilter: afvis kald uden gyldig delt app-token. Apps Script
  // eksponerer ikke request-headers til scriptet, så tokenen rejser i body
  // (params.appToken) i stedet for som X-App-Token-header. Bremser casual
  // scraping; erstatter ikke password-/operatør-auth længere nede.
  if (!_appTokenOk(params)) {
    return respond({ ok: false, error: 'Adgang nægtet' }, params.callback);
  }
  return handle(params);
}

/** Konstant-tids sammenligning af den delte app-token. */
function _appTokenOk(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_APP_TOKEN) || APP_TOKEN_DEFAULT;
  const got = String((params && params.appToken) || '');
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Master-level actions kører UDEN bandId — de styrer tenant-registreringen selv.
const MASTER_ACTIONS = { listTenants: 1, registerTenant: 1, deleteTenant: 1, updateTenant: 1, operatorLogin: 1, setTenantStatus: 1, getAuditLog: 1, runRetentionNow: 1 };

// Tværgående (cross-band) actions: kører UDEN ét enkelt bandId. Authentikeres mod
// det centrale identitets-kort (SSO) og sætter selv CURRENT_BAND_ID pr. band.
const IDENTITY_ACTIONS = { getAllJobs: 1, getAllHonorar: 1 };

function handle(p) {
  const action = p.action;
  let result;
  try {
    // Master actions: ingen bandId nødvendig, HMAC/operatør-valideret indeni
    if (MASTER_ACTIONS[action]) {
      switch (action) {
        case 'operatorLogin':  result = actOperatorLogin(p); break;
        case 'listTenants':    result = actListTenants(p); break;
        case 'registerTenant': result = actRegisterTenant(p); break;
        case 'updateTenant':   result = actUpdateTenant(p); break;
        case 'deleteTenant':   result = actDeleteTenant(p); break;
        case 'setTenantStatus': result = actSetTenantStatus(p); break;
        case 'getAuditLog':    result = actGetAuditLog(p); break;
        case 'runRetentionNow': result = actRunRetentionNow(p); break;
      }
      return respond(result, p.callback);
    }

    // Tværgående actions: ingen enkelt bandId — identitets-/SSO-valideret indeni
    if (IDENTITY_ACTIONS[action]) {
      switch (action) {
        case 'getAllJobs':    result = actGetAllJobs(p); break;
        case 'getAllHonorar': result = actGetAllHonorar(p); break;
      }
      return respond(result, p.callback);
    }

    // Alle andre actions kræver bandId → set CURRENT_BAND_ID
    if (!p.bandId) {
      return respond({ ok: false, error: 'bandId mangler i request' }, p.callback);
    }
    _loadTenant(p.bandId); // smider hvis ukendt
    CURRENT_BAND_ID = String(p.bandId);

    switch (action) {
      case 'login':           result = actLogin(p); break;
      case 'changePassword':  result = actChangePassword(p); break;
      case 'trackLogin':      result = actTrackLogin(p); break;
      case 'getMembers':      result = actGetMembers(p); break;
      case 'saveMember':      result = actSaveMember(p); break;
      case 'deleteMember':    result = actDeleteMember(p); break;
      case 'resetPassword':   result = actResetPassword(p); break;
      case 'getContracts':    result = actGetContracts(p); break;
      case 'getContract':     result = actGetContract(p); break;
      case 'saveContract':          result = actSaveContract(p); break;
      case 'changeContractStatus':  result = actChangeContractStatus(p); break;
      case 'deleteContract':        result = actDeleteContract(p); break;
      case 'getJobs':         result = actGetJobs(p); break;
      case 'getJob':          result = actGetJob(p); break;
      case 'getMyHonorar':    result = actGetMyHonorar(p); break;
      case 'getHonorarAdmin': result = actGetHonorarAdmin(p); break;
      case 'getDashboard':    result = actGetDashboard(p); break;
      case 'createInvoice':   result = actCreateInvoice(p); break;
      case 'uploadInvoicePdf': result = actUploadInvoicePdf(p); break;
      case 'getInvoices':     result = actGetInvoices(p); break;
      case 'updateInvoiceStatus': result = actUpdateInvoiceStatus(p); break;
      case 'deleteInvoice':   result = actDeleteInvoice(p); break;
      case 'getBandCpr':      result = actGetBandCpr(p); break;
      case 'archiveInvoiceToDrive': result = actArchiveInvoiceToDrive(p); break;
      case 'updateMyAddress': result = actUpdateMyAddress(p); break;
      case 'exportMyData':    result = actExportMyData(p); break;
      case 'updateJobStartAddress': result = actUpdateJobStartAddress(p); break;
      case 'recalcJobDistance': result = actRecalcJobDistance(p); break;
      // Public boot config + rider download
      case 'getConfig':       result = actGetConfig(p); break;
      case 'getRider':        result = actGetRider(p); break;
      case 'getSceneplan':    result = actGetSceneplan(p); break;
      // Admin-tool actions (HMAC-signeret). Læser/skriver KUN Settings, Members og assets.
      case 'adminReadConfig':   result = actAdminReadConfig(p); break;
      case 'adminWriteConfig':  result = actAdminWriteConfig(p); break;
      case 'adminUpsertMember': result = actAdminUpsertMember(p); break;
      case 'adminDeleteMember': result = actAdminDeleteMember(p); break;
      case 'adminUploadAsset':  result = actAdminUploadAsset(p); break;
      // Faktureringsoplysninger (band-admin selvbetjening)
      case 'adminGetBillingInfo':  result = actAdminGetBillingInfo(p); break;
      case 'adminSaveBillingInfo': result = actAdminSaveBillingInfo(p); break;
      // GDPR: slet band
      case 'adminDeleteBand':   result = actAdminDeleteBand(p); break;
      // Musikerens selvbetjening
      case 'memberUpdateProfile':  result = actMemberUpdateProfile(p); break;
      // Admin-tool: nulstil password
      case 'adminResetMemberPassword': result = actAdminResetMemberPassword(p); break;
      // Udseende (tema + accentfarve)
      case 'adminSaveAppearance': result = actAdminSaveAppearance(p); break;
      // Operatør: sundhedstjek pr. band
      case 'bandHealth':        result = actBandHealth(p); break;
      // Operatør: backup + kalender-feed pr. band
      case 'backupBand':        result = actBackupBand(p); break;
      case 'getFeedUrl':        result = actGetFeedUrl(p); break;
      case 'rotateFeedToken':   result = actRotateFeedToken(p); break;
      default:                result = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    // Fuld fejl (inkl. stack) logges server-side — kun bevidste brugerbeskeder
    // (_userError) returneres til klienten, så interne detaljer ikke lækkes.
    console.error('handle() fejl [' + action + '/' + (CURRENT_BAND_ID || '-') + ']: ' + (err && err.stack || err));
    result = err && err.userFacing
      ? { ok: false, error: String(err.message) }
      : { ok: false, error: 'Der opstod en serverfejl. Prøv igen — fejlen er logget.' };
  }
  return respond(result, p.callback);
}

function respond(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

/**
 * Fejl hvis besked er beregnet til brugeren. handle() returnerer kun
 * userFacing-beskeder til klienten — alt andet logges og erstattes af
 * en generisk besked, så interne detaljer ikke lækkes.
 */
function _userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

function sha256(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

// ─── Password-hashing (saltet) ───────────────────────────────────────────────
//
// Klienten sender sha256(password) som "clientHash" (uændret bærer-credential).
// Vi gemmer IKKE clientHash direkte, men en SALTET hash: HMAC-SHA256(clientHash, salt)
// med et tilfældigt per-bruger salt. Dermed kan ens passwords ikke ses som ens i
// arket, og et læk af Sheet'et giver ikke rainbow-table-angreb. Online brute-force
// dækkes af rate-limit (5 forsøg / 15 min). Eksisterende usaltede hashes opgraderes
// automatisk ved næste login (fail-safe: login virker uanset).

function _genSalt() {
  return _secureRandomBase64(16);
}

// Nuværende password-algoritme. Et enkelt HMAC er for hurtigt: lækker Members-arket,
// kan svage passwords brute-forces offline på sekunder. Vi strækker derfor nøglen med
// mange HMAC-iterationer (PBKDF2-lignende), så hvert gæt koster ~100ms. Hash'en gemmes
// self-describing som "pbkdf2$<iter>$<base64>" — så vi kan genkende generationen og
// opgradere ældre/svagere hashes automatisk ved login UDEN en ny kolonne i arket.
// Iterationstallet er en afvejning mellem sikkerhed og hastighed. Apps Scripts
// HMAC er relativt langsom (Java-bro pr. kald), så et højt tal gør login træls
// OG gør testsuiten urimeligt langsom. 100k var for meget. Vælg empirisk: kør
// benchmarkHashing_RUN_ME() i Tests.gs og sigt efter ~200-400ms pr. login.
// Fordi hver hash gemmer sit eget iterationstal ("pbkdf2$<iter>$..."), kan
// dette tal ændres frit — gamle hashes verificeres stadig med deres eget tal,
// og opgraderes til det nye ved næste login.
const PW_ALGO = 'pbkdf2';
const PW_ITERATIONS = 10000;

/** Legacy: ét enkelt HMAC. Bevares KUN til at verificere gamle (usaltede→saltede) hashes. */
function _saltedHash(clientHash, salt) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(String(clientHash), String(salt)));
}

/** Key stretching: HMAC-SHA256 i counter-loop. iterations gæt-runder pr. password. */
function _stretch(clientHash, salt, iterations) {
  let h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(String(clientHash), String(salt)));
  for (let i = 1; i < iterations; i++) {
    h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h, String(salt)));
  }
  return h;
}

/** Producér nuværende-generations hash-streng: "pbkdf2$<iter>$<base64>". */
function _hashPassword(clientHash, salt) {
  return PW_ALGO + '$' + PW_ITERATIONS + '$' + _stretch(clientHash, salt, PW_ITERATIONS);
}

/** Konstant-tids string-sammenligning (undgår timing-læk af hvor hash'ene afviger). */
function _constTimeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verificér clientHash mod en gemt hash — på tværs af ALLE generationer:
 *   "pbkdf2$<iter>$<h>"  → stræk med samme iter og sammenlign
 *   saltet (intet "$")   → legacy ét-HMAC
 *   usaltet (intet salt) → rå sha256-lighed (ældste konti)
 */
function _verifyHash(clientHash, salt, stored) {
  stored = String(stored || '');
  if (stored.indexOf('$') !== -1) {
    const parts = stored.split('$');           // [algo, iter, hash]
    if (parts[0] !== PW_ALGO) return false;     // ukendt fremtidig algoritme
    const iter = parseInt(parts[1], 10) || PW_ITERATIONS;
    return _constTimeEq(_stretch(clientHash, salt, iter), parts[2]);
  }
  if (salt) return _constTimeEq(_saltedHash(clientHash, salt), stored);
  return _constTimeEq(clientHash, stored);
}

/** Skal en gemt hash genhashes til nuværende algoritme/iterationstal? */
function _needsRehash(stored) {
  stored = String(stored || '');
  if (stored.indexOf('$') === -1) return true;  // legacy usaltet/saltet
  const parts = stored.split('$');
  return parts[0] !== PW_ALGO || (parseInt(parts[1], 10) || 0) < PW_ITERATIONS;
}

/** Felter til at gemme et NYT password (modtaget som clientHash). Bruger nuværende algoritme. */
function _newPasswordFields(clientHash) {
  const salt = _genSalt();
  return { passwordHash: _hashPassword(clientHash, salt), pwSalt: salt };
}

// ─── Centralt identitetsregister (SSO på tværs af bands) ─────────────────────
//
// Hvert band er et isoleret Sheet, men den SAMME musiker (samme e-mail) kan spille
// i flere bands. For at ét password kan virke alle steder ("single sign-on") og for
// at kunne samle jobs/honorar på tværs, holder vi ét centralt identitets-kort pr.
// e-mail i Script Properties:
//   IDENTITY_<sha256(email)> = { email, passwordHash, pwSalt, bands: [bandId,...] }
// passwordHash/pwSalt bruger NØJAGTIG samme saltede skema som Members-fanen, så et
// kort kan "seedes" ved at kopiere et verificeret medlems felter direkte.
// Per-band-data (rolle, share, adresse) bliver liggende i hvert bands eget Sheet —
// registret styrer KUN authentikation + hvilke bands e-mailen er med i.

function _identityKey(email) {
  return PROP_IDENTITY_PREFIX + sha256(String(email || '').toLowerCase().trim());
}

function _loadIdentity(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return null;
  const raw = PropertiesService.getScriptProperties().getProperty(_identityKey(e));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!Array.isArray(o.bands)) o.bands = [];
    return o;
  } catch (err) { return null; }
}

function _saveIdentity(identity) {
  if (!identity || !identity.email) return;
  identity.email = String(identity.email).toLowerCase().trim();
  PropertiesService.getScriptProperties().setProperty(_identityKey(identity.email), JSON.stringify(identity));
}

/**
 * Opretter/udfylder et identitets-kort ud fra et verificeret medlems gemte
 * (saltede) password-felter. Sætter kun password hvis kortet ikke allerede har et
 * (så vi ikke overskriver et nyere SSO-password med en gammel band-værdi).
 */
function _seedIdentity(email, passwordHash, pwSalt, bandId) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return;
  const id = _loadIdentity(e) || { email: e, bands: [] };
  if (!id.passwordHash) { id.passwordHash = passwordHash; id.pwSalt = pwSalt; }
  if (bandId && id.bands.indexOf(bandId) === -1) id.bands.push(bandId);
  _saveIdentity(id);
}

/** Registrér at en e-mail er med i et band. Skriver kun hvis bandet ikke allerede står der. */
function _addBandToIdentity(email, bandId) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !bandId) return;
  const id = _loadIdentity(e) || { email: e, bands: [] };
  if (id.bands.indexOf(bandId) === -1) {
    id.bands.push(bandId);
    _saveIdentity(id);
  }
}

/** Synkronisér nyt password ind i identitets-kortet (kaldes ved password-skift/-reset). */
function _syncIdentityPassword(email, pf) {
  const id = _loadIdentity(email);
  if (!id) return; // intet kort endnu → seedes ved næste login
  id.passwordHash = pf.passwordHash;
  id.pwSalt = pf.pwSalt;
  _saveIdentity(id);
}

/**
 * Verificér password DIREKTE mod det centrale identitets-kort — uden band-kontekst.
 * Bruges af de tværgående actions (getAllJobs/getAllHonorar), der ikke kører i ét
 * enkelt band. Returnerer identitets-kortet ved succes, ellers null.
 */
function _verifyIdentity(email, hash) {
  if (!email || !hash) return null;
  const id = _loadIdentity(email);
  if (!id || !id.passwordHash || !id.pwSalt) return null;
  if (!_verifyHash(hash, id.pwSalt, id.passwordHash)) return null;
  // Opgradér hash til nuværende algoritme ved login (fail-safe).
  if (_needsRehash(id.passwordHash)) {
    try {
      const pf = _newPasswordFields(hash);
      id.passwordHash = pf.passwordHash; id.pwSalt = pf.pwSalt;
      _saveIdentity(id);
    } catch (e) { Logger.log('Identitets-hash-opgradering fejlede (login virker stadig): ' + e); }
  }
  return id;
}

/** Sikrer at en kolonne findes i header-rækken (tilføjer den hvis ikke). */
function _ensureColumn(name, col) {
  const sh = _getSheet(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  if (headers.indexOf(col) === -1) sh.getRange(1, headers.length + 1).setValue(col);
}

function _verifyAuth(email, hash) {
  if (!email || !hash) return null;
  // Man skal være medlem af DETTE band for at få adgang — også med SSO.
  const m = _findMemberByEmail(email);
  if (!m) return null;

  // SSO: findes der et centralt identitets-kort, er DET kilden til sandhed for
  // password. Per-band passwordHash er da kun en (evt. forældet) skygge.
  const identity = _loadIdentity(email);
  if (identity && identity.passwordHash && identity.pwSalt) {
    if (!_verifyHash(hash, identity.pwSalt, identity.passwordHash)) return null;
    let dirty = false;
    // Opgradér hash til nuværende algoritme ved login (fail-safe: login virker uanset).
    if (_needsRehash(identity.passwordHash)) {
      try {
        const pf = _newPasswordFields(hash);
        identity.passwordHash = pf.passwordHash; identity.pwSalt = pf.pwSalt; dirty = true;
      } catch (e) { Logger.log('Identitets-hash-opgradering fejlede (login virker stadig): ' + e); }
    }
    // Registrér bandet på identiteten, første gang e-mailen logger ind her.
    if (identity.bands.indexOf(CURRENT_BAND_ID) === -1) { identity.bands.push(CURRENT_BAND_ID); dirty = true; }
    if (dirty) _saveIdentity(identity);
    return m;
  }

  // Intet identitets-kort endnu (konto fra før SSO) → verificér mod bandets eget
  // password (alle generationer), og seed derefter identiteten ud fra det medlem.
  if (!_verifyHash(hash, m.pwSalt, m.passwordHash)) return null;
  // Opgradér legacy/svagere hash til nuværende algoritme (engangs, ved login).
  if (_needsRehash(m.passwordHash)) {
    try {
      _ensureColumn('Members', 'pwSalt');
      const f = _newPasswordFields(hash);
      _updateRowById('Members', m.id, { passwordHash: f.passwordHash, pwSalt: f.pwSalt });
      m.passwordHash = f.passwordHash; m.pwSalt = f.pwSalt;
    } catch (e) { Logger.log('Password-opgradering fejlede (login virker stadig): ' + e); }
  }
  // Migrér: opret det centrale kort ud fra denne verificerede konto.
  try { _seedIdentity(email, m.passwordHash, m.pwSalt, CURRENT_BAND_ID); }
  catch (e) { Logger.log('Identitets-seed fejlede (login virker stadig): ' + e); }
  return m;
}

function _requireAdmin(email, hash) {
  const m = _verifyAuth(email, hash);
  if (!m) throw _userError('Ikke logget ind');
  if (m.role !== 'admin') throw _userError('Kræver admin-rettigheder');
  return m;
}

// ─── Sheet helpers ──────────────────────────────────────────────────────────

function _getSheet(name) {
  const ss = SpreadsheetApp.openById(_getSheetId());
  let sh = ss.getSheetByName(name);
  if (!sh) {
    // Auto-opret hvis vi har headers defineret (sparer manuel setupSheet-kørsel)
    if (SHEET_HEADERS[name]) {
      sh = ss.insertSheet(name);
      const headers = SHEET_HEADERS[name];
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      return sh;
    }
    throw _userError('Mangler fane: ' + name);
  }
  return sh;
}

/**
 * Slår en kolonne op i header-rækken og fejler højlydt hvis den mangler —
 * ellers ville indexOf() returnere -1 og getRange ramme en forkert kolonne.
 */
function _colIndexOrThrow(headers, name) {
  const i = headers.indexOf(name);
  if (i === -1) throw _userError('Kolonnen "' + name + '" mangler i arket — tilføj den eller kør setupSheet');
  return i;
}

function _readAll(name) {
  const sh = _getSheet(name);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// ─── Concurrency (atomare skrivninger) ───────────────────────────────────────
//
// Sheets er datalaget, og to samtidige requests kan ellers ødelægge data:
// "læs højeste id → skriv ny række" (_nextId + append) kan give to rækker SAMME
// id, og "læs række → opdatér" kan tabe en samtidig opdatering (lost update).
// LockService.getScriptLock() serialiserer skrivninger på tværs af hele scriptet;
// låsen holdes kun i de få ms en mutation tager.
//
// _withLock er REENTRANT: en action kan tage låsen om en hel transaktion (fx
// id-generering + flere skrivninger), og de indre _writeRow/_updateRowById ser
// at låsen allerede holdes og tager den ikke igen. _LOCK_DEPTH er request-isoleret
// fordi hver HTTP-request kører i et frisk V8-context (jf. note øverst i filen).
//
// NB: dette er det korrekte værktøj inden for Apps Script. Et rigtigt SaaS-datalag
// (Cloud SQL/Firestore) ville bruge ægte transaktioner med per-tenant-isolation;
// her er låsen global på tværs af bands — acceptabelt ved dette skrivevolumen.

let _LOCK_DEPTH = 0;

function _withLock(fn) {
  if (_LOCK_DEPTH > 0) {            // reentrant: vi holder allerede script-låsen
    _LOCK_DEPTH++;
    try { return fn(); } finally { _LOCK_DEPTH--; }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw _userError('Systemet er optaget lige nu. Prøv igen om et øjeblik.');
  _LOCK_DEPTH = 1;
  try { return fn(); }
  finally { _LOCK_DEPTH = 0; lock.releaseLock(); }
}

/** Atomar indsættelse: genererer id og skriver rækken under én lås (ingen id-kollision). */
function _insertWithId(name, prefix, build) {
  return _withLock(function() {
    const id = _nextId(name, prefix);
    _writeRow(name, build(id));   // reentrant — tager ikke låsen igen
    return id;
  });
}

function _writeRow(name, obj) {
  return _withLock(function() {
    const sh = _getSheet(name);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const row = headers.map(h => obj[h] === undefined ? '' : obj[h]);
    sh.appendRow(row);
  });
}

function _updateRowById(name, id, patch) {
  return _withLock(function() {
    const sh = _getSheet(name);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const idCol = headers.indexOf('id');
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;
    const ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        const rowNum = i + 2;
        headers.forEach((h, j) => {
          if (patch[h] !== undefined) {
            sh.getRange(rowNum, j + 1).setValue(patch[h]);
          }
        });
        return true;
      }
    }
    return false;
  });
}

function _deleteRowById(name, id) {
  return _withLock(function() {
    const sh = _getSheet(name);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const idCol = headers.indexOf('id');
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;
    const ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        sh.deleteRow(i + 2);
        return true;
      }
    }
    return false;
  });
}

function _findMemberByEmail(email) {
  const lower = String(email || '').toLowerCase().trim();
  const all = _readAll('Members');
  return all.find(m => String(m.email || '').toLowerCase().trim() === lower) || null;
}

function _findMemberById(id) {
  return _readAll('Members').find(m => String(m.id) === String(id)) || null;
}

function _nextId(name, prefix) {
  const all = _readAll(name);
  let max = 0;
  all.forEach(r => {
    const n = parseInt(String(r.id).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return prefix + (max + 1);
}

function _publicMember(m) {
  if (!m) return null;
  return {
    id: m.id, name: m.name, category: m.category, instrument: m.instrument,
    phone: m.phone, email: m.email, role: m.role
  };
}

function _privateMember(m) {
  if (!m) return null;
  return Object.assign(_publicMember(m), {
    regAccount: m.regAccount,
    address: m.address || '',
    forcePasswordChange: !!m.forcePasswordChange, createdAt: m.createdAt
  });
}

function _parseJsonField(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return {}; }
}

function _serializeContract(c) {
  return {
    id: c.id, type: c.type, status: c.status,
    arrangoer: _parseJsonField(c.arrangoer),
    venue: _parseJsonField(c.venue),
    date: c.date ? new Date(c.date).toISOString() : '',
    getIn: c.getIn, soundcheck: c.soundcheck,
    showtimeFrom: c.showtimeFrom, showtimeTo: c.showtimeTo,
    sets: Number(c.sets) || 0, setMinutes: Number(c.setMinutes) || 0,
    musicianCount: Number(c.musicianCount) || 0,
    crewCount: Number(c.crewCount) || 0,
    guestCount: Number(c.guestCount) || 0,
    honorar: Number(c.honorar) || 0,
    paymentTerms: c.paymentTerms, paymentTermsOther: c.paymentTermsOther,
    notes: c.notes, createdAt: c.createdAt, updatedAt: c.updatedAt
  };
}

// ─── Actions: auth ──────────────────────────────────────────────────────────

// Login rate limit: 5 fejlede forsøg per email → 15 min lockout.
// Bruger CacheService (auto-expiring, hurtigere end PropertiesService, atomic put).
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SEC = 15 * 60;

function _loginAttemptKey(email) { return 'loginAttempts:' + CURRENT_BAND_ID + ':' + String(email || '').toLowerCase().trim(); }
function _loginLockKey(email) { return 'loginLock:' + CURRENT_BAND_ID + ':' + String(email || '').toLowerCase().trim(); }

function actLogin(p) {
  // Suspenderet band → login blokeret (data forbliver urørt; operatør kan genaktivere).
  try {
    if (_loadTenant(CURRENT_BAND_ID).status === 'suspended') {
      return { ok: false, error: 'Dette band er midlertidigt deaktiveret. Kontakt din administrator.' };
    }
  } catch (e) { /* ukendt band fanges allerede i handle() */ }
  const cache = CacheService.getScriptCache();
  const lockKey = _loginLockKey(p.email);
  if (cache.get(lockKey)) {
    return { ok: false, error: 'For mange mislykkede forsøg. Prøv igen om 15 minutter.' };
  }
  const m = _verifyAuth(p.email, p.passwordHash);
  if (!m) {
    // Tæl op — efter LOGIN_MAX_ATTEMPTS læg lock i 15 min og nulstil tæller
    const attKey = _loginAttemptKey(p.email);
    const current = Number(cache.get(attKey) || 0) + 1;
    if (current >= LOGIN_MAX_ATTEMPTS) {
      cache.put(lockKey, '1', LOGIN_LOCK_SEC);
      cache.remove(attKey);
      return { ok: false, error: 'For mange mislykkede forsøg. Kontoen er låst i 15 minutter.' };
    }
    cache.put(attKey, String(current), LOGIN_LOCK_SEC);
    const remaining = LOGIN_MAX_ATTEMPTS - current;
    return { ok: false, error: 'Forkert email eller adgangskode. ' + remaining + ' forsøg tilbage.' };
  }
  // Lykkedes — ryd tæller
  cache.remove(_loginAttemptKey(p.email));
  return {
    ok: true,
    member: _privateMember(m),
    forcePasswordChange: !!m.forcePasswordChange,
    role: m.role || 'member'
  };
}

function actChangePassword(p) {
  const m = _verifyAuth(p.email, p.oldHash); // håndterer både saltet og legacy
  if (!m) return { ok: false, error: 'Den gamle adgangskode passer ikke.' };
  if (!p.newHash || String(p.newHash).length !== 64) return { ok: false, error: 'Ugyldig ny adgangskode.' };
  const pf = _newPasswordFields(p.newHash);
  _updateRowById('Members', m.id, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt, forcePasswordChange: false });
  // SSO: ét password gælder alle bands → opdatér det centrale identitets-kort.
  _syncIdentityPassword(m.email, pf);
  return { ok: true };
}

function actTrackLogin(p) {
  _writeRow('LoginLog', {
    timestamp: new Date(),
    memberId: p.memberId || '',
    email: p.email || '',
    userAgent: (p.ua || '').toString().slice(0, 200)
  });
  return { ok: true };
}

/**
 * GDPR art. 15/20: medlem henter ALLE egne persondata som struktureret JSON.
 * Kun den indloggede brugers egne data — aldrig andres.
 */
function actExportMyData(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const myId = String(me.id);
  const cById = {};
  _readAll('Contracts').forEach(c => { cById[String(c.id)] = c; });
  const jobs = _readAll('Attendances').filter(a => String(a.memberId) === myId).map(a => {
    const c = cById[String(a.contractId)] || {};
    const venue = _parseJsonField(c.venue);
    return {
      contractId: a.contractId, date: c.date || '', venue: venue.name || '', city: venue.city || '',
      share: a.share, status: a.status, checkedInAt: a.checkedInAt || '',
      distanceKm: a.distanceKm || '', startAddress: a.startAddress || ''
    };
  });
  const myEmail = String(me.email || '').toLowerCase();
  const loginHistory = _readAll('LoginLog')
    .filter(l => String(l.email || '').toLowerCase() === myEmail)
    .map(l => ({ timestamp: l.timestamp, userAgent: l.userAgent }));
  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    band: getBandConfig().bandName || CURRENT_BAND_ID,
    profile: {
      id: me.id, name: me.name, email: me.email, phone: me.phone,
      category: me.category, instrument: me.instrument,
      address: me.address || '', regAccount: me.regAccount || '',
      role: me.role, createdAt: me.createdAt
    },
    jobs: jobs,
    loginHistory: loginHistory
  };
}

// ─── Actions: members (admin) ───────────────────────────────────────────────

function actGetMembers(p) {
  _requireAdmin(p.email, p.passwordHash);
  return { ok: true, members: _readAll('Members').map(_privateMember) };
}

function actSaveMember(p) {
  _requireAdmin(p.email, p.passwordHash);
  const data = p.member || {};
  const isNew = !data.id;
  if (isNew) {
    const pf = _newPasswordFields(sha256(getBandConfig().seedPassword));
    const id = _insertWithId('Members', 'm', function(newId) {
      return {
        id: newId,
        name: data.name || '',
        category: data.category || 'Musiker',
        instrument: data.instrument || '',
        phone: data.phone || '',
        email: (data.email || '').toLowerCase().trim(),
        regAccount: data.regAccount || '',
        address: data.address || '',
        passwordHash: pf.passwordHash,
        pwSalt: pf.pwSalt,
        forcePasswordChange: true,
        role: data.role || 'member',
        createdAt: new Date()
      };
    });
    _addBandToIdentity((data.email || '').toLowerCase().trim(), CURRENT_BAND_ID);
    // Seed-password ejes af backend og returneres KUN her, lige efter oprettelse,
    // så admin-UI kan vise den initiale adgangskode uden at den er hardcodet i frontend.
    return { ok: true, id: id, seedPassword: getBandConfig().seedPassword };
  } else {
    const patch = {};
    ['name', 'category', 'instrument', 'phone', 'regAccount', 'address', 'role'].forEach(k => {
      if (data[k] !== undefined) patch[k] = data[k];
    });
    if (data.email !== undefined) {
      const newEmail = String(data.email).toLowerCase().trim();
      const existing = _findMemberByEmail(newEmail);
      if (existing && String(existing.id) !== String(data.id)) {
        return { ok: false, error: 'Email er allerede i brug af et andet medlem.' };
      }
      patch.email = newEmail;
      _addBandToIdentity(newEmail, CURRENT_BAND_ID);
    }
    _updateRowById('Members', data.id, patch);
    return { ok: true, id: data.id };
  }
}

function actDeleteMember(p) {
  _requireAdmin(p.email, p.passwordHash);
  const id = p.id;
  if (!id) return { ok: false, error: 'Mangler id' };
  // Forbid sletning af admin der er logget ind
  const me = _findMemberByEmail(p.email);
  if (me && String(me.id) === String(id)) return { ok: false, error: 'Du kan ikke slette dig selv.' };
  _deleteRowById('Members', id);
  return { ok: true };
}

function actResetPassword(p) {
  _requireAdmin(p.email, p.passwordHash);
  const id = p.id;
  if (!id) return { ok: false, error: 'Mangler id' };
  const pf = _newPasswordFields(sha256(getBandConfig().seedPassword));
  _updateRowById('Members', id, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt, forcePasswordChange: true });
  // SSO: nulstilling gælder alle bands. NB: en band-admin kan dermed også nulstille
  // en delt musikers password i de andre bands musikeren spiller i.
  const target = _findMemberById(id);
  if (target) _syncIdentityPassword(target.email, pf);
  // Returnér den midlertidige adgangskode, så admin-UI kan vise den efter nulstilling
  // (backend ejer seed-passwordet — det er ikke hardcodet i frontend).
  return { ok: true, seedPassword: getBandConfig().seedPassword };
}

// ─── Actions: contracts (admin) ─────────────────────────────────────────────

function actGetContracts(p) {
  _requireAdmin(p.email, p.passwordHash);
  return { ok: true, contracts: _readAll('Contracts').map(_serializeContract) };
}

function actGetContract(p) {
  _requireAdmin(p.email, p.passwordHash);
  const id = p.id;
  const c = _readAll('Contracts').find(r => String(r.id) === String(id));
  if (!c) return { ok: false, error: 'Kontrakt ikke fundet' };
  const attendees = _readAll('Attendances').filter(a => String(a.contractId) === String(id));
  return { ok: true, contract: _serializeContract(c), attendees: attendees };
}

function actSaveContract(p) {
  _requireAdmin(p.email, p.passwordHash);
  const data = p.contract || {};
  const attendees = p.attendees || []; // [{memberId, share}]
  const providedId = String(data.id || '').trim();
  const originalId = String(p.originalId || '').trim();

  // Rename: brugeren har ændret kontrakt-nr på en eksisterende kontrakt.
  // Tjek at det nye id ikke kolliderer, opdater Contracts-rækken og cascade
  // til alle Attendances med den gamle contractId.
  if (originalId && providedId && originalId !== providedId) {
    const all = _readAll('Contracts');
    const orig = all.find(r => String(r.id) === originalId);
    if (!orig) return { ok: false, error: 'Original kontrakt ikke fundet (id: ' + originalId + ')' };
    if (all.find(r => String(r.id) === providedId)) {
      return { ok: false, error: 'Kontrakt-nr "' + providedId + '" er allerede i brug' };
    }
    _updateRowById('Contracts', originalId, { id: providedId });
    // Cascade attendances
    const attSh = _getSheet('Attendances');
    const attHeaders = attSh.getRange(1, 1, 1, attSh.getLastColumn()).getValues()[0];
    const cidCol = attHeaders.indexOf('contractId');
    const lastRow = attSh.getLastRow();
    if (lastRow >= 2 && cidCol >= 0) {
      const cidValues = attSh.getRange(2, cidCol + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < cidValues.length; i++) {
        if (String(cidValues[i][0]) === originalId) {
          attSh.getRange(i + 2, cidCol + 1).setValue(providedId);
        }
      }
    }
  }

  const existingRow = providedId ? _readAll('Contracts').find(r => String(r.id) === providedId) : null;
  const isNew = !existingRow;

  // Beskyt mod utilsigtet overskrivning: hvis der ikke var noget originalId
  // (dvs. brugeren er ved at oprette en ny kontrakt) men nummeret allerede findes,
  // afvis gem så vi ikke skriver oven i den eksisterende.
  if (existingRow && !originalId) {
    return { ok: false, error: 'Kontrakt-nr "' + providedId + '" er allerede i brug. Vælg et andet nummer.' };
  }

  // Conflict detection: hvis klienten har en stale version af kontrakten
  // (en anden admin har gemt siden klienten åbnede den) → afvis save.
  if (existingRow && p.expectedUpdatedAt) {
    const serverTs = existingRow.updatedAt ? new Date(existingRow.updatedAt).getTime() : 0;
    const clientTs = new Date(p.expectedUpdatedAt).getTime();
    if (serverTs && clientTs && serverTs > clientTs) {
      return { ok: false, conflict: true, error: 'Kontrakten er ændret af en anden bruger siden du åbnede den. Genindlæs og prøv igen.' };
    }
  }
  const now = new Date();
  const row = {
    id: providedId || '',   // tildeles atomart under _withLock nedenfor hvis ny
    type: data.type || 'Spillested',
    status: data.status || 'udkast',
    arrangoer: JSON.stringify(data.arrangoer || {}),
    venue: JSON.stringify(data.venue || {}),
    date: data.date ? new Date(data.date) : '',
    getIn: data.getIn || '',
    soundcheck: data.soundcheck || '',
    showtimeFrom: data.showtimeFrom || '',
    showtimeTo: data.showtimeTo || '',
    sets: Number(data.sets) || 0,
    setMinutes: Number(data.setMinutes) || 0,
    musicianCount: Number(data.musicianCount) || 0,
    crewCount: Number(data.crewCount) || 0,
    guestCount: Number(data.guestCount) || 0,
    honorar: Number(data.honorar) || 0,
    paymentTerms: data.paymentTerms || '',
    paymentTermsOther: data.paymentTermsOther || '',
    notes: data.notes || '',
    updatedAt: now
  };
  // Hele gemningen (id-tildeling + kontrakt-skrivning + attendance-resync) er ÉN
  // atomar transaktion — ellers kunne en samtidig save give id-kollision eller en
  // halvt opdateret kontrakt (kontrakt skrevet, men attendances ikke).
  _withLock(function() {
    if (isNew) {
      if (!row.id) row.id = _nextId('Contracts', 'c');
      row.createdAt = now;
      _writeRow('Contracts', row);
    } else {
      _updateRowById('Contracts', row.id, row);
    }

    // Sync attendances: slet ALLE eksisterende rækker for kontrakten ved row-scan
    // (robust mod legacy-rækker uden id) og indsæt nye.
    const attSh = _getSheet('Attendances');
    const attHeaders = attSh.getRange(1, 1, 1, attSh.getLastColumn()).getValues()[0];
    const contractIdCol = attHeaders.indexOf('contractId');
    const lastRow = attSh.getLastRow();
    if (lastRow >= 2 && contractIdCol >= 0) {
      const cidValues = attSh.getRange(2, contractIdCol + 1, lastRow - 1, 1).getValues();
      for (let i = cidValues.length - 1; i >= 0; i--) {
        if (String(cidValues[i][0]) === String(row.id)) {
          attSh.deleteRow(i + 2);
        }
      }
    }
    attendees.forEach((a, i) => {
      _writeRow('Attendances', {
        id: 'a' + Date.now() + '_' + i,
        contractId: row.id,
        memberId: a.memberId,
        share: Number(a.share) || 0,
        status: 'invited',
        confirmedAt: '',
        checkedInAt: ''
      });
    });
  });

  return { ok: true, id: row.id };
}

function actChangeContractStatus(p) {
  _requireAdmin(p.email, p.passwordHash);
  const id = String(p.id || '').trim();
  const status = p.status || 'udkast';
  const allowed = ['udkast', 'afventer', 'godkendt'];
  if (!id) return { ok: false, error: 'Mangler id' };
  if (!allowed.includes(status)) return { ok: false, error: 'Ugyldig status' };
  const existing = _readAll('Contracts').find(r => String(r.id) === id);
  if (!existing) return { ok: false, error: 'Kontrakt ikke fundet' };
  _updateRowById('Contracts', id, { status: status, updatedAt: new Date() });
  return { ok: true };
}


function actDeleteContract(p) {
  _requireAdmin(p.email, p.passwordHash);
  const id = p.id;
  if (!id) return { ok: false, error: 'Mangler id' };
  const allAtt = _readAll('Attendances');
  allAtt.forEach(a => {
    if (String(a.contractId) === String(id)) _deleteRowById('Attendances', a.id);
  });
  _deleteRowById('Contracts', id);
  return { ok: true };
}

// ─── Actions: dashboard ─────────────────────────────────────────────────────

function actGetDashboard(p) {
  _requireAdmin(p.email, p.passwordHash);
  const contracts = _readAll('Contracts').map(_serializeContract);
  const members = _readAll('Members');
  const now = new Date();
  const upcoming = contracts.filter(c => c.date && new Date(c.date) >= now);
  upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
  const me = _findMemberByEmail(p.email);
  const allAtt = _readAll('Attendances');
  const myAttendances = me ? allAtt.filter(a => String(a.memberId) === String(me.id)) : [];
  const upcomingIds = new Set(upcoming.map(c => String(c.id)));
  const mitHonorar = myAttendances
    .filter(a => upcomingIds.has(String(a.contractId)))
    .reduce((s, a) => s + (Number(a.share) || 0), 0);
  const stats = {
    aktiveKontrakter: contracts.filter(c => c.status !== 'udkast').length,
    bookedHonorar: upcoming.reduce((s, c) => s + (c.honorar || 0), 0),
    mitHonorar: mitHonorar,
    aktiveMedlemmer: members.length,
    afventer: contracts.filter(c => c.status === 'afventer').length
  };
  // Build unique arranger list
  const arrangoerMap = {};
  contracts.forEach(c => {
    const name = (c.arrangoer && c.arrangoer.name) ? c.arrangoer.name.trim() : null;
    if (!name) return;
    if (!arrangoerMap[name]) arrangoerMap[name] = { name: name, count: 0, honorar: 0, lastDate: '' };
    arrangoerMap[name].count++;
    arrangoerMap[name].honorar += Number(c.honorar) || 0;
    if (c.date && (!arrangoerMap[name].lastDate || c.date > arrangoerMap[name].lastDate)) {
      arrangoerMap[name].lastDate = c.date;
    }
  });
  const arrangoere = Object.values(arrangoerMap).sort((a, b) => b.count - a.count);

  // Enrich next 4 upcoming jobs with attendee summary for dashboard popup
  const memMap = {};
  members.forEach(m => { memMap[m.id] = m; });
  const top4 = upcoming.slice(0, 4).map(c => {
    const seen = {};
    const attendees = [];
    allAtt
      .filter(a => String(a.contractId) === String(c.id))
      .forEach(a => {
        const k = String(a.memberId);
        if (seen[k]) return;
        seen[k] = true;
        const m = memMap[a.memberId];
        if (m) attendees.push({
          id: m.id, name: m.name,
          instrument: m.instrument || '', category: m.category || '',
          status: a.status || 'invited'
        });
      });
    return Object.assign({}, c, { attendees: attendees });
  });
  return { ok: true, stats: stats, upcoming: top4, arrangoere: arrangoere };
}

// ─── Actions: member-facing ─────────────────────────────────────────────────

function actGetJobs(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const myAtt = _readAll('Attendances').filter(a => String(a.memberId) === String(me.id));
  const contracts = _readAll('Contracts');
  const cMap = {};
  contracts.forEach(c => { cMap[c.id] = c; });
  // Dedup: hvis samme medlem har flere attendance-rækker for samme kontrakt
  // (legacy data), vis kun ét job pr. kontrakt.
  const seenContracts = {};
  const jobs = [];
  myAtt
    .filter(a => cMap[a.contractId] && String(cMap[a.contractId].status) === 'godkendt')
    .forEach(a => {
      const cid = String(a.contractId);
      if (seenContracts[cid]) return;
      seenContracts[cid] = true;
      const rawContract = cMap[a.contractId];
      const c = _serializeContract(rawContract);
      const dist = _ensureDistance(a, rawContract, me.address);
      jobs.push({
        attendanceId: a.id,
        contractId: c.id,
        type: c.type,
        date: c.date,
        venue: c.venue,
        getIn: c.getIn,
        soundcheck: c.soundcheck,
        showtimeFrom: c.showtimeFrom,
        showtimeTo: c.showtimeTo,
        share: Number(a.share) || 0,
        status: a.status,
        confirmedAt: a.confirmedAt,
        checkedInAt: a.checkedInAt,
        startAddress: a.startAddress || '',
        distanceKm: dist.km,
        distanceOrigin: dist.origin
      });
    });
  jobs.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { ok: true, jobs: jobs, member: _privateMember(me) };
}

function actGetJob(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const att = _readAll('Attendances').find(a => String(a.id) === String(p.attendanceId));
  if (!att || String(att.memberId) !== String(me.id)) return { ok: false, error: 'Job ikke fundet' };
  const c = _readAll('Contracts').find(x => String(x.id) === String(att.contractId));
  if (!c) return { ok: false, error: 'Kontrakt ikke fundet' };
  const dist = _ensureDistance(att, c, me.address);
  // Hele besætningen for denne kontrakt — dedup på memberId så duplikerede attendance-rækker
  // ikke giver samme person flere gange i UI'et.
  const allAtt = _readAll('Attendances').filter(a => String(a.contractId) === String(c.id));
  const allMembers = _readAll('Members');
  const seen = {};
  const besaetning = [];
  allAtt.forEach(a => {
    const key = String(a.memberId);
    if (seen[key]) return;
    seen[key] = true;
    const m = allMembers.find(x => String(x.id) === key);
    if (m) besaetning.push({ id: m.id, name: m.name, instrument: m.instrument, status: a.status });
  });

  const sc = _serializeContract(c);
  delete sc.honorar;        // members never see total contract honorar
  delete sc.arrangoer;      // members don't need arranger contact details
  delete sc.paymentTerms;
  delete sc.paymentTermsOther;
  return {
    ok: true,
    job: {
      attendanceId: att.id,
      contract: sc,
      share: Number(att.share) || 0,
      status: att.status,
      confirmedAt: att.confirmedAt,
      checkedInAt: att.checkedInAt,
      besaetning: besaetning,
      startAddress: att.startAddress || '',
      distanceKm: dist.km,
      distanceOrigin: dist.origin,
      homeAddress: me.address || ''
    }
  };
}

function actUpdateMyAddress(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const addr = (p.address || '').toString().trim();
  _updateRowById('Members', me.id, { address: addr });
  // Invalidate cached distances for jobs that brugte hjemmeadressen som origin.
  // Vi sletter bare cache-felterne; næste actGetJobs re-beregner.
  const allAtt = _readAll('Attendances').filter(a => String(a.memberId) === String(me.id));
  allAtt.forEach(a => {
    if (!a.startAddress) _updateRowById('Attendances', a.id, { distanceKm: '', distanceOrigin: '' });
  });
  return { ok: true, address: addr };
}

function actUpdateJobStartAddress(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const att = _readAll('Attendances').find(a => String(a.id) === String(p.attendanceId));
  if (!att || String(att.memberId) !== String(me.id)) return { ok: false, error: 'Job ikke fundet' };
  const start = (p.startAddress || '').toString().trim();
  // Gem ny startadresse, tøm cache så næste re-beregn bruger ny origin.
  // Beregner IKKE automatisk — brugeren skal klikke "Beregn km".
  _updateRowById('Attendances', att.id, { startAddress: start, distanceKm: '', distanceOrigin: '' });
  return { ok: true, startAddress: start, distanceKm: '', distanceOrigin: '' };
}

function actRecalcJobDistance(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const att = _readAll('Attendances').find(a => String(a.id) === String(p.attendanceId));
  if (!att || String(att.memberId) !== String(me.id)) return { ok: false, error: 'Job ikke fundet' };
  const c = _readAll('Contracts').find(x => String(x.id) === String(att.contractId));
  if (!c) return { ok: false, error: 'Kontrakt ikke fundet' };
  const r = _forceCalcDistance(att, c, me.address);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, distanceKm: r.km, distanceOrigin: r.origin };
}

function _buildHonorarRows(myAtt, contracts, allAttendances, allMembers, fra, til, memberHomeAddress) {
  const cMap = {};
  contracts.forEach(c => { cMap[c.id] = c; });
  // group attendances by contractId for besætning lookup
  const attByContract = {};
  allAttendances.forEach(a => {
    if (!attByContract[a.contractId]) attByContract[a.contractId] = [];
    attByContract[a.contractId].push(a);
  });
  const memberMap = {};
  allMembers.forEach(m => { memberMap[m.id] = m; });

  const rows = myAtt
    .filter(a => cMap[a.contractId])
    .map(a => {
      const rawContract = cMap[a.contractId];
      const c = _serializeContract(rawContract);
      const besaetning = (attByContract[c.id] || []).map(x => {
        const mbr = memberMap[x.memberId];
        return mbr ? mbr.name + (mbr.instrument ? ' (' + mbr.instrument + ')' : '') : null;
      }).filter(Boolean);
      const dist = _ensureDistance(a, rawContract, memberHomeAddress);
      return {
        date: c.date, venue: c.venue, type: c.type,
        share: Number(a.share) || 0, status: c.status, attendanceStatus: a.status,
        getIn: c.getIn, soundcheck: c.soundcheck,
        showtimeFrom: c.showtimeFrom, showtimeTo: c.showtimeTo,
        sets: Number(c.sets) || 0, setMinutes: Number(c.setMinutes) || 0,
        besaetning: besaetning,
        startAddress: a.startAddress || '',
        distanceKm: dist.km
      };
    })
    .filter(r => {
      if (!r.date) return false;
      const d = new Date(r.date);
      if (fra && d < fra) return false;
      if (til && d > til) return false;
      return true;
    });
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return rows;
}

// ─── Actions: Invoice archive (Google Drive) ────────────────────────────────

function _getInvoiceFolder(year) {
  // Per-band mappe: Band-app/<bandId>/<invoiceFolderName>/<år>/ — auto-oprettes.
  // Mapperne låses til Restricted access (kun ejer) så PDF-links ikke virker
  // for tilfældige med adressen — kun de personer du eksplicit deler med.
  const root = _getBandSubFolder(getBandConfig().invoiceFolderName, true);
  const yearStr = String(year);
  const sub = root.getFoldersByName(yearStr);
  if (sub.hasNext()) return sub.next();
  const yearFolder = root.createFolder(yearStr);
  _lockdownFolder(yearFolder);
  return yearFolder;
}

function _lockdownFolder(folder) {
  try { folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) { Logger.log('Folder lockdown fejl: ' + e); }
}

function _lockdownFile(file) {
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) { Logger.log('File lockdown fejl: ' + e); }
}

/**
 * Kør én gang fra editoren for at låse eksisterende faktura-mappe
 * + alle års-undermapper + alle PDF-filer til Restricted access.
 * Sikker at køre flere gange — idempotent.
 * Kræver CURRENT_BAND_ID sat — kør fx: CURRENT_BAND_ID='mitband'; migrateLockdownInvoiceFolder()
 */
function migrateLockdownInvoiceFolder() {
  const root = _getBandSubFolder(getBandConfig().invoiceFolderName, true);
  _lockdownFolder(root);
  Logger.log('Låste root: ' + root.getName());
  const subs = root.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    _lockdownFolder(sub);
    Logger.log('Låste undermappe: ' + sub.getName());
    const files = sub.getFiles();
    let count = 0;
    while (files.hasNext()) { _lockdownFile(files.next()); count++; }
    Logger.log('  → låste ' + count + ' filer');
  }
}

/**
 * Engangs-migration: flyt eksisterende Drive-filer fra de gamle delte,
 * navnebaserede mapper ("Fakturaer", "<bandShortName> Assets") til de nye
 * per-band-mapper (Band-app/<bandId>/...). Flytter EFTER fil-ID — den eneste
 * pålidelige ejerskabskilde er hvert bands Invoices-fane (driveFileId) og
 * Settings (logoFileId/riderFileId). Idempotent og sletter intet; filer som
 * intet band refererer, bliver liggende i legacy-mapperne til manuel gennemgang.
 * Kør manuelt fra editoren efter deploy. Trash selv tomme legacy-mapper bagefter.
 */
function migrateDriveFoldersToPerBand() {
  _listTenants().forEach(function (t) {
    CURRENT_BAND_ID = t.bandId;
    // 1) Fakturaer: flyt hver fil refereret fra Invoices til per-band års-mappe
    let invoices = [];
    try { invoices = _readAll('Invoices'); }
    catch (e) { Logger.log(t.bandId + ': kunne ikke læse Invoices (' + e + ') — springer over'); return; }
    invoices.forEach(function (inv) {
      if (!inv.driveFileId) return;
      try {
        const file = DriveApp.getFileById(String(inv.driveFileId));
        const year = inv.date ? new Date(inv.date).getFullYear() : new Date().getFullYear();
        const target = _getInvoiceFolder(year);
        const parents = file.getParents();
        if (parents.hasNext() && parents.next().getId() === target.getId()) return; // allerede flyttet
        file.moveTo(target);
        _lockdownFile(file);
        Logger.log(t.bandId + ': flyttede ' + file.getName());
      } catch (e) {
        Logger.log(t.bandId + ': kunne ikke flytte ' + inv.driveFileId + ': ' + e);
      }
    });
    // 2) Assets: flyt logo/rider refereret fra Settings
    const cfg = getBandConfig();
    ['logoFileId', 'riderFileId'].forEach(function (k) {
      if (!cfg[k]) return;
      try {
        const file = DriveApp.getFileById(String(cfg[k]));
        const target = _getAssetsFolder();
        const parents = file.getParents();
        if (parents.hasNext() && parents.next().getId() === target.getId()) return;
        file.moveTo(target);
        Logger.log(t.bandId + ': flyttede asset ' + k);
      } catch (e) {
        Logger.log(t.bandId + ': asset ' + k + ' fejl: ' + e);
      }
    });
  });
  Logger.log('Migration færdig. Tjek at legacy-mapperne ("Fakturaer" / "* Assets") er tomme før du trasher dem manuelt.');
}

function _nextInvoiceNr(year) {
  // Find første ledige nummer for året — slettede fakturaers numre genbruges,
  // så sekvensen forbliver tæt (ingen huller).
  const all = _readAll('Invoices');
  const prefix = String(year) + '-';
  const used = {};
  all.forEach(r => {
    if (String(r.status) === 'slettet') return;
    const nr = String(r.invoiceNr || '');
    if (nr.indexOf(prefix) === 0) {
      const n = parseInt(nr.slice(prefix.length), 10);
      if (!isNaN(n)) used[n] = true;
    }
  });
  let n = 1;
  while (used[n]) n++;
  return prefix + String(n).padStart(3, '0');
}

/**
 * Konverterer HTML til PDF via Drive (kræver Advanced Drive Service).
 * Returnerer PDF-blob hvis muligt, ellers null så caller falder tilbage til HTML.
 */
function _htmlToPdfBlob(html, baseName) {
  try {
    if (typeof Drive === 'undefined' || !Drive.Files) return null;
    const htmlBlob = Utilities.newBlob(html, 'text/html', baseName + '.html');
    const tempDoc = Drive.Files.insert(
      { title: '__tmp_' + baseName, mimeType: 'application/vnd.google-apps.document' },
      htmlBlob
    );
    const docFile = DriveApp.getFileById(tempDoc.id);
    const pdfBlob = docFile.getAs('application/pdf').setName(baseName + '.pdf');
    docFile.setTrashed(true);
    return pdfBlob;
  } catch (err) {
    Logger.log('PDF-konvertering fejlede, falder tilbage til HTML: ' + err);
    return null;
  }
}

function actCreateInvoice(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.contractId) return { ok: false, error: 'contractId mangler' };
  const c = _readAll('Contracts').find(x => String(x.id) === String(p.contractId));
  if (!c) return { ok: false, error: 'Kontrakt ikke fundet' };

  const allInv = _readAll('Invoices');
  // Find aktiv (ikke-slettet) faktura for denne kontrakt
  const existing = allInv.find(i =>
    String(i.contractId) === String(p.contractId) && String(i.status) !== 'slettet'
  );

  const dateObj = c.date ? new Date(c.date) : new Date();
  const year = dateObj.getFullYear();
  const invoiceNr = existing ? existing.invoiceNr : _nextInvoiceNr(year);
  const fileName = 'Faktura ' + invoiceNr + ' — ' + ((c.venue && c.venue.name) || c.id);
  const folder = _getInvoiceFolder(year);

  // Trash gammel Drive-fil hvis vi opdaterer en eksisterende faktura — ellers ophober vi filer
  let trashWarning = null;
  if (existing && existing.driveFileId) {
    try { DriveApp.getFileById(existing.driveFileId).setTrashed(true); }
    catch (e) {
      console.error('createInvoice: kunne ikke trashe Drive-fil ' + existing.driveFileId + ': ' + e);
      trashWarning = 'Den gamle Drive-fil kunne ikke fjernes — der kan ligge en forældet kopi i Drive.';
    }
  }

  // reserveOnly = bare opret faktura-række (intet Drive-file). Bruges når brugeren selv uploader PDF bagefter.
  // pdfBase64 = klienten har en færdig PDF (fra print-til-PDF) — gem den som Drive-fil.
  // html (legacy) = bruges ikke længere fra klienten, men beholdes som fallback.
  let file = null;
  if (!p.reserveOnly) {
    try {
      if (p.pdfBase64) {
        const bytes = Utilities.base64Decode(String(p.pdfBase64));
        const pdfBlob = Utilities.newBlob(bytes, 'application/pdf', fileName + '.pdf');
        file = folder.createFile(pdfBlob);
      } else if (p.html) {
        const html = String(p.html);
        const pdfBlob = _htmlToPdfBlob(html, fileName);
        if (pdfBlob) {
          file = folder.createFile(pdfBlob);
        } else {
          const htmlBlob = Utilities.newBlob(html, 'text/html', fileName + '.html');
          file = folder.createFile(htmlBlob).setName(fileName + '.html');
        }
      }
      if (file) _lockdownFile(file);
    } catch (err) {
      console.error('actArchiveInvoiceToDrive: Drive-fejl [' + (CURRENT_BAND_ID || '-') + ']: ' + (err && err.stack || err));
      return { ok: false, error: 'Kunne ikke gemme filen på Drive. Prøv igen — fejlen er logget.' };
    }
  }

  if (existing) {
    // Opdater eksisterende række (samme nr, evt. ny Drive-URL, friske data)
    const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
    const data = sh.getDataRange().getValues();
    const headers = data[0];
    const idCol = _colIndexOrThrow(headers, 'id');
    const amountCol = _colIndexOrThrow(headers, 'amount');
    const fileIdCol = _colIndexOrThrow(headers, 'driveFileId');
    const urlCol = _colIndexOrThrow(headers, 'driveUrl');
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][idCol]) === String(existing.id)) {
        sh.getRange(r + 1, amountCol + 1).setValue(Number(c.honorar) || 0);
        if (file) {
          sh.getRange(r + 1, fileIdCol + 1).setValue(file.getId());
          sh.getRange(r + 1, urlCol + 1).setValue(file.getUrl());
        }
        break;
      }
    }
    const updated = Object.assign({}, existing, {
      amount: Number(c.honorar) || 0
    });
    if (file) {
      updated.driveFileId = file.getId();
      updated.driveUrl = file.getUrl();
    }
    const resReused = { ok: true, invoice: updated, reused: true };
    if (trashWarning) resReused.warning = trashWarning;
    return resReused;
  }

  // Ny faktura — id-tildeling + append under én lås (ingen dobbelt-id / fakturanr-kollision).
  const inv = {
    id: '',
    contractId: c.id,
    invoiceNr: invoiceNr,
    date: dateObj,
    amount: Number(c.honorar) || 0,
    status: 'udestaaende',
    driveFileId: file ? file.getId() : '',
    driveUrl: file ? file.getUrl() : '',
    createdAt: new Date(),
    paidAt: ''
  };
  _withLock(function() {
    inv.id = _nextId('Invoices', 'inv');
    const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
    const headers = SHEET_HEADERS.Invoices;
    sh.appendRow(headers.map(h => inv[h] != null ? inv[h] : ''));
  });
  return { ok: true, invoice: inv, reused: false };
}

function actUploadInvoicePdf(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.id) return { ok: false, error: 'id mangler' };
  if (!p.pdfBase64) return { ok: false, error: 'pdfBase64 mangler' };

  const inv = _readAll('Invoices').find(x => String(x.id) === String(p.id));
  if (!inv) return { ok: false, error: 'Faktura ikke fundet' };

  const c = _readAll('Contracts').find(x => String(x.id) === String(inv.contractId));
  const dateObj = inv.date ? new Date(inv.date) : new Date();
  const year = dateObj.getFullYear();
  const fileName = 'Faktura ' + inv.invoiceNr + ' — ' + ((c && c.venue && c.venue.name) || inv.contractId);
  const folder = _getInvoiceFolder(year);

  // Trash gammel Drive-fil
  let trashWarning = null;
  if (inv.driveFileId) {
    try { DriveApp.getFileById(inv.driveFileId).setTrashed(true); }
    catch (e) {
      console.error('uploadInvoicePdf: kunne ikke trashe Drive-fil ' + inv.driveFileId + ': ' + e);
      trashWarning = 'Den gamle Drive-fil kunne ikke fjernes — der kan ligge en forældet kopi i Drive.';
    }
  }

  let file;
  try {
    const bytes = Utilities.base64Decode(String(p.pdfBase64));
    const pdfBlob = Utilities.newBlob(bytes, 'application/pdf', fileName + '.pdf');
    file = folder.createFile(pdfBlob);
    _lockdownFile(file);
  } catch (err) {
    console.error('actUploadInvoicePdf: Drive-fejl [' + (CURRENT_BAND_ID || '-') + ']: ' + (err && err.stack || err));
    return { ok: false, error: 'Kunne ikke gemme PDF på Drive. Prøv igen — fejlen er logget.' };
  }

  const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = _colIndexOrThrow(headers, 'id');
  const fileIdCol = _colIndexOrThrow(headers, 'driveFileId');
  const urlCol = _colIndexOrThrow(headers, 'driveUrl');
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.id)) {
      sh.getRange(r + 1, fileIdCol + 1).setValue(file.getId());
      sh.getRange(r + 1, urlCol + 1).setValue(file.getUrl());
      break;
    }
  }

  const res = { ok: true, driveFileId: file.getId(), driveUrl: file.getUrl() };
  if (trashWarning) res.warning = trashWarning;
  return res;
}

function actDeleteInvoice(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.id) return { ok: false, error: 'id mangler' };
  const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = _colIndexOrThrow(headers, 'id');
  const statusCol = _colIndexOrThrow(headers, 'status');
  const driveIdCol = _colIndexOrThrow(headers, 'driveFileId');
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.id)) {
      // Soft-delete: behold række så fakturanr forbliver "brugt"; flyt Drive-fil til papirkurv
      sh.getRange(r + 1, statusCol + 1).setValue('slettet');
      const driveId = data[r][driveIdCol];
      if (driveId) {
        try { DriveApp.getFileById(String(driveId)).setTrashed(true); }
        catch (e) {
          console.error('deleteInvoice: kunne ikke trashe Drive-fil ' + driveId + ': ' + e);
          return { ok: true, warning: 'Fakturaen er slettet, men Drive-filen kunne ikke flyttes til papirkurven — slet den manuelt i Drive.' };
        }
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Faktura ikke fundet' };
}

function actGetBandCpr(p) {
  _requireAdmin(p.email, p.passwordHash);
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID);
  if (!raw) return { ok: false, error: 'CPR ikke konfigureret for dette band — gå til Indstillinger og udfyld faktureringsoplysninger' };
  try {
    return { ok: true, cpr: _decryptCpr(raw) };
  } catch (e) {
    console.error('actGetBandCpr: dekryptering fejlede [' + (CURRENT_BAND_ID || '-') + ']: ' + (e && e.stack || e));
    // Integritets-/konfig-fejl er bevidste brugerbeskeder; alt andet generaliseres.
    return { ok: false, error: e && e.userFacing ? String(e.message) : 'CPR kunne ikke dekrypteres — fejlen er logget.' };
  }
}

/**
 * Arkivér en CPR-løs version af honorarafregningen på Drive.
 * Klienten sender HTML uden CPR-injektion → server konverterer til PDF → erstatter Drive-fil.
 */
function actArchiveInvoiceToDrive(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.invoiceId) return { ok: false, error: 'invoiceId mangler' };
  if (!p.html) return { ok: false, error: 'html mangler' };

  const inv = _readAll('Invoices').find(x => String(x.id) === String(p.invoiceId));
  if (!inv) return { ok: false, error: 'Faktura ikke fundet' };

  const c = _readAll('Contracts').find(x => String(x.id) === String(inv.contractId));
  const dateObj = inv.date ? new Date(inv.date) : new Date();
  const year = dateObj.getFullYear();
  const fileName = 'Honorarafregning ' + inv.invoiceNr + ' — ' + ((c && c.venue && _parseJson(c.venue) && _parseJson(c.venue).name) || inv.contractId);
  const folder = _getInvoiceFolder(year);

  // Trash gammel Drive-fil hvis den findes
  let trashWarning = null;
  if (inv.driveFileId) {
    try { DriveApp.getFileById(inv.driveFileId).setTrashed(true); }
    catch (e) {
      console.error('archiveInvoiceToDrive: kunne ikke trashe Drive-fil ' + inv.driveFileId + ': ' + e);
      trashWarning = 'Den gamle Drive-fil kunne ikke fjernes — der kan ligge en forældet kopi i Drive.';
    }
  }

  const pdfBlob = _htmlToPdfBlob(String(p.html), fileName);
  if (!pdfBlob) return { ok: false, error: 'PDF-konvertering fejlede (kræver Advanced Drive Service)' };
  const file = folder.createFile(pdfBlob);
  _lockdownFile(file);

  const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = _colIndexOrThrow(headers, 'id');
  const fileIdCol = _colIndexOrThrow(headers, 'driveFileId');
  const urlCol = _colIndexOrThrow(headers, 'driveUrl');
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.invoiceId)) {
      sh.getRange(r + 1, fileIdCol + 1).setValue(file.getId());
      sh.getRange(r + 1, urlCol + 1).setValue(file.getUrl());
      break;
    }
  }
  const res = { ok: true, driveFileId: file.getId(), driveUrl: file.getUrl() };
  if (trashWarning) res.warning = trashWarning;
  return res;
}

function actGetInvoices(p) {
  _requireAdmin(p.email, p.passwordHash);
  // Skjul slettede fakturaer fra UI'et — de ligger stadig i sheet'et så fakturanr forbliver brugt
  const invoices = _readAll('Invoices').filter(i => String(i.status) !== 'slettet');
  const contracts = _readAll('Contracts');
  const cMap = {};
  contracts.forEach(c => { cMap[c.id] = c; });
  const enriched = invoices.map(i => {
    const c = cMap[i.contractId];
    return Object.assign({}, i, {
      arrangoer: c ? _parseJson(c.arrangoer) : null,
      venue:     c ? _parseJson(c.venue)     : null,
      contractDate: c ? c.date : null
    });
  });
  enriched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { ok: true, invoices: enriched };
}

function actUpdateInvoiceStatus(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.id || !p.status) return { ok: false, error: 'id eller status mangler' };
  const sh = SpreadsheetApp.openById(_getSheetId()).getSheetByName('Invoices');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = _colIndexOrThrow(headers, 'id');
  const statusCol = _colIndexOrThrow(headers, 'status');
  const paidCol = _colIndexOrThrow(headers, 'paidAt');
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idCol]) === String(p.id)) {
      sh.getRange(r + 1, statusCol + 1).setValue(p.status);
      if (p.status === 'betalt') sh.getRange(r + 1, paidCol + 1).setValue(new Date());
      else if (p.status === 'udestaaende') sh.getRange(r + 1, paidCol + 1).setValue('');
      return { ok: true };
    }
  }
  return { ok: false, error: 'Faktura ikke fundet' };
}

function _parseJson(s) {
  if (s == null || s === '') return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function actGetHonorarAdmin(p) {
  _requireAdmin(p.email, p.passwordHash);
  const targetMember = _findMemberById(p.memberId);
  if (!targetMember) return { ok: false, error: 'Medlem ikke fundet' };
  const fra = p.fra ? new Date(p.fra) : null;
  const til = p.til ? new Date(p.til) : null;
  const myAtt = _readAll('Attendances').filter(a => String(a.memberId) === String(p.memberId));
  const contracts = _readAll('Contracts');
  const allAttendances = _readAll('Attendances');
  const allMembers = _readAll('Members');
  const rows = _buildHonorarRows(myAtt, contracts, allAttendances, allMembers, fra, til, targetMember.address);
  const total = rows.reduce((s, r) => s + r.share, 0);
  const totalKm = rows.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
  return { ok: true, rows: rows, total: total, totalKm: Math.round(totalKm * 10) / 10, member: _privateMember(targetMember) };
}

function actGetMyHonorar(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const fra = p.fra ? new Date(p.fra) : null;
  const til = p.til ? new Date(p.til) : null;
  const myAtt = _readAll('Attendances').filter(a => String(a.memberId) === String(me.id));
  const contracts = _readAll('Contracts');
  const allAttendances = _readAll('Attendances');
  const allMembers = _readAll('Members');
  const rows = _buildHonorarRows(myAtt, contracts, allAttendances, allMembers, fra, til, me.address);
  const total = rows.reduce((s, r) => s + r.share, 0);
  const totalKm = rows.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
  return { ok: true, rows: rows, total: total, totalKm: Math.round(totalKm * 10) / 10, member: _privateMember(me) };
}

// ─── Tværgående (cross-band) actions — kun for musikeren selv ────────────────
//
// Betalt feature pr. band (TENANT_<bandId>.crossBand). En musiker med samme e-mail
// i flere bands kan se ALLE sine jobs/honorar samlet — men KUN fra de bands hvor
// operatøren har slået featuren til. Authentikeres mod det centrale identitets-kort
// (SSO), ikke ét enkelt band, så de routes i en egen gren i handle().

/**
 * Let branding pr. band til de tværgående visninger: navn, accentfarve og et lille
 * logo (data-URL). Logoet caches pr. logoFileId; store logoer springes over
 * (frontend viser et farve-chip i stedet). Forudsætter CURRENT_BAND_ID == bandId.
 */
function _bandBrandLite(bandId, tenantName) {
  const cfg = getBandConfig();
  const brand = {
    bandId: bandId,
    bandName: cfg.bandName || tenantName || bandId,
    bandShortName: cfg.bandShortName || '',
    bandColor: cfg.primaryColor || '#8A8A8A',
    bandLogo: ''
  };
  if (cfg.logoFileId) {
    const cache = CacheService.getScriptCache();
    const ck = 'logoLite:' + cfg.logoFileId;
    const cached = cache.get(ck);
    if (cached !== null) {
      brand.bandLogo = cached; // '' = forsøgt før, men for stort/utilgængeligt
    } else {
      try {
        const blob = DriveApp.getFileById(cfg.logoFileId).getBlob();
        const url = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
        const toStore = url.length <= 90000 ? url : ''; // CacheService-grænse ~100KB pr. nøgle
        cache.put(ck, toStore, 21600); // 6 timer
        brand.bandLogo = toStore;
      } catch (e) { Logger.log('Logo-lite fetch fejl (' + bandId + '): ' + e); }
    }
  }
  return brand;
}

/** Itererer crossBand-aktiverede bands hvor e-mailen er medlem, og kalder fn() pr. band. */
function _forEachCrossBand(identity, fn) {
  identity.bands.forEach(bandId => {
    let tenant;
    try { tenant = _loadTenant(bandId); } catch (e) { return; } // band fjernet fra listen
    if ((tenant.status || 'active') !== 'active') return;
    if (!tenant.crossBand) return; // kun bands der har betalt for featuren
    CURRENT_BAND_ID = bandId;
    try { fn(bandId, tenant); }
    catch (e) { Logger.log('cross-band fejl (' + bandId + '): ' + e); }
  });
}

function actGetAllJobs(p) {
  const id = _verifyIdentity(p.email, p.passwordHash);
  if (!id) return { ok: false, error: 'Ikke logget ind' };
  const out = [];
  const bands = [];
  _forEachCrossBand(id, (bandId, tenant) => {
    const r = actGetJobs(p); // genbruger SSO-auth + job-logik i band-kontekst
    if (!r || !r.ok || !r.jobs) return;
    const brand = _bandBrandLite(bandId, tenant.name);
    bands.push(brand);
    r.jobs.forEach(j => {
      j.bandId = bandId;
      j.bandName = brand.bandName;
      j.bandShortName = brand.bandShortName;
      j.bandColor = brand.bandColor;
      j.bandLogo = brand.bandLogo;
      out.push(j);
    });
  });
  out.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { ok: true, jobs: out, bands: bands, bandCount: bands.length };
}

function actGetAllHonorar(p) {
  const id = _verifyIdentity(p.email, p.passwordHash);
  if (!id) return { ok: false, error: 'Ikke logget ind' };
  const bands = [];
  let grandTotal = 0, grandKm = 0;
  _forEachCrossBand(id, (bandId, tenant) => {
    const r = actGetMyHonorar(p); // genbruger honorar-beregning i band-kontekst
    if (!r || !r.ok) return;
    const brand = _bandBrandLite(bandId, tenant.name);
    grandTotal += Number(r.total) || 0;
    grandKm += Number(r.totalKm) || 0;
    bands.push({
      bandId: bandId, bandName: brand.bandName, bandShortName: brand.bandShortName,
      bandColor: brand.bandColor, bandLogo: brand.bandLogo,
      rows: r.rows, total: r.total, totalKm: r.totalKm
    });
  });
  bands.sort((a, b) => String(a.bandName).localeCompare(String(b.bandName)));
  // Samlet honorar er et OVERBLIK — selve faktureringen sker fortsat pr. band.
  return { ok: true, bands: bands, grandTotal: grandTotal, grandTotalKm: Math.round(grandKm * 10) / 10 };
}

// ─── Band config (Settings-fanen) ───────────────────────────────────────────

/**
 * Læser Settings-fanen som key/value-objekt. Cache 5 min via CacheService.
 * Manglende keys fyldes ud fra SETTINGS_DEFAULTS.
 */
function getBandConfig() {
  const cache = CacheService.getScriptCache();
  const ck = _cacheKey('bandConfig');
  const cached = cache.get(ck);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const rows = _readAll('Settings');
  const cfg = Object.assign({}, SETTINGS_DEFAULTS);
  rows.forEach(r => { if (r.key) cfg[r.key] = r.value; });
  try { cache.put(ck, JSON.stringify(cfg), 300); } catch (e) {}
  return cfg;
}

/** Invalidér config-cache for nuværende band. Kald efter actAdminWriteConfig. */
function _invalidateBandConfigCache() {
  try { CacheService.getScriptCache().remove(_cacheKey('bandConfig')); } catch (e) {}
}

// ─── Public boot config + rider ─────────────────────────────────────────────

/**
 * Returnerer offentlig config + base64-logo. Ingen auth — kaldes ved app-boot
 * før brugeren er logget ind, så login-skærmen kan vise band-navn/logo/farve.
 */
function actGetConfig(p) {
  const cfg = getBandConfig();
  const pub = {};
  PUBLIC_CONFIG_KEYS.forEach(k => { pub[k] = cfg[k] || ''; });
  // Logo som data-URL (inline base64 — undgår at vi skal eksponere Drive-file public).
  pub.logoDataUrl = '';
  if (cfg.logoFileId) {
    try {
      const blob = DriveApp.getFileById(cfg.logoFileId).getBlob();
      pub.logoDataUrl = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
    } catch (e) {
      Logger.log('Logo-fetch fejl (fileId=' + cfg.logoFileId + '): ' + e + ' — tjek at filen findes og at Apps Script har Drive-adgang.');
    }
  }
  pub.hasRider = !!cfg.riderFileId || !!String(cfg.riderText || '').trim();
  pub.hasRiderPdf = !!String(cfg.riderFileId || '').trim();  // PDF der erstatter de genererede rider-sider i kontrakten
  pub.hasSceneplan = !!String(cfg.sceneplanFileId || '').trim();
  // Betalt feature: tværgående jobs/honorar slået til for dette band af operatøren.
  try { pub.crossBand = !!_loadTenant(CURRENT_BAND_ID).crossBand; } catch (e) { pub.crossBand = false; }
  return { ok: true, config: pub };
}

/**
 * Streamer rider-PDF som base64 data-URL. Kun for indloggede medlemmer.
 */
function actGetRider(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const cfg = getBandConfig();
  // PDF har forrang hvis uploadet; ellers fald tilbage til rider-tekst.
  if (cfg.riderFileId) {
    try {
      const blob = DriveApp.getFileById(cfg.riderFileId).getBlob();
      return {
        ok: true,
        kind: 'pdf',
        name: blob.getName(),
        contentType: blob.getContentType(),
        dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes())
      };
    } catch (e) {
      console.error('actGetRider: Drive-fetch fejl [' + (CURRENT_BAND_ID || '-') + ']: ' + (e && e.stack || e));
      return { ok: false, error: 'Kunne ikke hente rider lige nu. Prøv igen — fejlen er logget.' };
    }
  }
  const text = String(cfg.riderText || '').trim();
  if (text) return { ok: true, kind: 'text', text: text };
  return { ok: false, error: 'Ingen rider uploadet endnu' };
}

/**
 * Streamer sceneplan-billede som base64 data-URL. Kun for indloggede medlemmer.
 * Indlejres som side 4 på Festival-kontrakter (frontend).
 */
function actGetSceneplan(p) {
  const me = _verifyAuth(p.email, p.passwordHash);
  if (!me) return { ok: false, error: 'Ikke logget ind' };
  const cfg = getBandConfig();
  const fileId = String(cfg.sceneplanFileId || '').trim();
  if (!fileId) return { ok: false, error: 'Ingen sceneplan uploadet endnu' };
  try {
    const blob = DriveApp.getFileById(fileId).getBlob();
    return {
      ok: true,
      name: blob.getName(),
      contentType: blob.getContentType(),
      dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes())
    };
  } catch (e) {
    console.error('actGetSceneplan: Drive-fetch fejl [' + (CURRENT_BAND_ID || '-') + ']: ' + (e && e.stack || e));
    return { ok: false, error: 'Kunne ikke hente sceneplan lige nu. Prøv igen — fejlen er logget.' };
  }
}

// ─── Admin-tool actions (HMAC-signeret) ─────────────────────────────────────
//
// VIGTIGT: Disse actions har KUN skrive/læse-adgang til Settings, Members og assets.
// De læser ALDRIG Contracts, Invoices, Attendances eller LoginLog. Dette er den
// tekniske håndhævelse af "admin-tool kan ikke se band'ets driftsdata".
// Hvis du tilføjer nye actAdmin*-funktioner: hold dig til samme afgrænsning.

// ─── Operatør-login (samlet admin i selve appen) ────────────────────────────
//
// I stedet for et separat admin-tool der holder MASTER_ADMIN_SECRET, logger
// operatøren ind direkte i appen (?band=__operator). Backenden udsteder et
// kortlivet token (HMAC-signeret med MASTER_ADMIN_SECRET) som frontenden sender
// med i payloaden (operatorToken). Hemmeligheden forlader aldrig serveren.

function _b64url(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _signOperatorPayload(payloadStr) {
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_ADMIN_SECRET);
  if (!secret) throw _userError('MASTER_ADMIN_SECRET ikke konfigureret — kør bootstrapMaster_RUN_ME()');
  return _b64url(Utilities.computeHmacSha256Signature(payloadStr, secret));
}

// Operatør-kontoen styrer ALLE bands (tenant-registrering, sletning, audit, data).
// Den er det mest privilegerede login i systemet og endpointet er åbent (Access:
// Anyone), så uden throttling kan password gættes ubegrænset. Vi genbruger samme
// lockout-model som medlems-login (5 forsøg → 15 min), men keyet globalt på
// operatør-email (intet bandId i denne kontekst) via CacheService.
function _operatorAttemptKey(email) { return 'opLoginAttempts:' + String(email || '').toLowerCase().trim(); }
function _operatorLockKey(email) { return 'opLoginLock:' + String(email || '').toLowerCase().trim(); }

function actOperatorLogin(p) {
  const props = PropertiesService.getScriptProperties();
  const email = String(p.email || '').toLowerCase().trim();
  const storedEmail = String(props.getProperty(PROP_OPERATOR_EMAIL) || '').toLowerCase().trim();
  const storedHash = props.getProperty(PROP_OPERATOR_HASH);
  const storedSalt = props.getProperty(PROP_OPERATOR_SALT);
  if (!storedEmail || !storedHash) {
    return { ok: false, error: 'Operatør ikke konfigureret — kør setOperator_RUN_ME() i Apps Script-editoren' };
  }
  // Rate-limit FØR password verificeres, så et låst login ikke kan brute-forces videre.
  const cache = CacheService.getScriptCache();
  const lockKey = _operatorLockKey(email);
  if (cache.get(lockKey)) {
    return { ok: false, error: 'For mange mislykkede forsøg. Prøv igen om 15 minutter.' };
  }
  // Verificér mod alle generationer; opgradér legacy/svagere hash ved login.
  const pwOk = _verifyHash(String(p.passwordHash || ''), storedSalt, storedHash);
  if (pwOk && _needsRehash(storedHash)) {
    const pf = _newPasswordFields(String(p.passwordHash));
    props.setProperty(PROP_OPERATOR_SALT, pf.pwSalt);
    props.setProperty(PROP_OPERATOR_HASH, pf.passwordHash);
  }
  if (email !== storedEmail || !pwOk) {
    // Tæl fejlede forsøg op; efter LOGIN_MAX_ATTEMPTS læg 15 min lock og nulstil tæller.
    const attKey = _operatorAttemptKey(email);
    const current = Number(cache.get(attKey) || 0) + 1;
    if (current >= LOGIN_MAX_ATTEMPTS) {
      cache.put(lockKey, '1', LOGIN_LOCK_SEC);
      cache.remove(attKey);
      return { ok: false, error: 'For mange mislykkede forsøg. Operatør-login er låst i 15 minutter.' };
    }
    cache.put(attKey, String(current), LOGIN_LOCK_SEC);
    return { ok: false, error: 'Forkert email eller adgangskode' };
  }
  // Lykkedes — ryd tæller.
  cache.remove(_operatorAttemptKey(email));
  const exp = Date.now() + OPERATOR_TOKEN_TTL_SEC * 1000;
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ role: 'operator', email: storedEmail, exp: exp })).replace(/=+$/, '');
  const token = payload + '.' + _signOperatorPayload(payload);
  return { ok: true, token: token, exp: exp };
}

/** Verificér operatør-token. Smider hvis ugyldigt/udløbet. Returnerer payload. */
function _verifyOperator(p) {
  const token = String(p.operatorToken || '');
  const dot = token.indexOf('.');
  if (dot < 1) throw _userError('Ugyldigt operatør-token');
  const payload = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = _signOperatorPayload(payload);
  // Konstant-tids sammenligning
  if (sig.length !== expected.length) throw _userError('Ugyldigt operatør-token');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) throw _userError('Ugyldigt operatør-token');
  let data;
  try { data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString('UTF-8')); }
  catch (e) { throw _userError('Ugyldigt operatør-token'); }
  if (!data || data.role !== 'operator') throw _userError('Ugyldigt operatør-token');
  if (!data.exp || Date.now() > Number(data.exp)) throw _userError('Operatør-session udløbet — log ind igen');
  return data;
}

/** Tillader enten band-admin (email+passwordHash) eller operatør-token. */
function _requireAdminOrOperator(p) {
  if (p.operatorToken) { _verifyOperator(p); return { operator: true }; }
  return _requireAdmin(p.email, p.passwordHash);
}

function _verifyAdminSignature(p) {
  // Operatør-token er en accepteret alternativ vej til HMAC-signatur, så admin-UI
  // kan leve i selve appen (samme actions, men gated af et server-udstedt token i
  // stedet for en delt hemmelighed der ellers ville ende i browseren).
  if (p.operatorToken) { _verifyOperator(p); return true; }
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_ADMIN_SECRET);
  if (!secret) throw _userError('MASTER_ADMIN_SECRET ikke konfigureret — kør bootstrapMaster_RUN_ME()');
  const ts = Number(p.timestamp);
  if (!ts || isNaN(ts)) throw _userError('Manglende timestamp');
  const ageMs = Date.now() - ts;
  if (ageMs < -60000 || ageMs > 5 * 60 * 1000) throw _userError('Timestamp udløbet/ugyldigt');
  const action = p.action || '';
  // Payload = JSON-string af alle p-keys undtagen signature/timestamp/action/callback
  const dataObj = {};
  Object.keys(p).sort().forEach(k => {
    if (k !== 'signature' && k !== 'timestamp' && k !== 'action' && k !== 'callback') {
      dataObj[k] = p[k];
    }
  });
  const message = ts + ':' + action + ':' + JSON.stringify(dataObj);
  const macBytes = Utilities.computeHmacSha256Signature(message, secret);
  const expected = Utilities.base64Encode(macBytes);
  // Konstant-tids sammenligning
  const got = String(p.signature || '');
  if (got.length !== expected.length) throw _userError('Forkert signature');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff !== 0) throw _userError('Forkert signature');
  return true;
}

// ─── Master-level: tenant management ────────────────────────────────────────
//
// Disse actions kører UDEN bandId-context. De læser/skriver Script Properties
// for at vedligeholde listen af bands. Admin-tool bruger dem til onboarding.

function actListTenants(p) {
  _verifyAdminSignature(p);
  return { ok: true, tenants: _listTenants() };
}

function actRegisterTenant(p) {
  _verifyAdminSignature(p);
  const bandId = String(p.newBandId || '').trim();
  let sheetId = String(p.sheetId || '').trim();
  const bandName = String(p.bandName || '').trim();
  if (!bandId || !bandName) return { ok: false, error: 'newBandId og bandName kræves' };
  if (!/^[a-z0-9-]+$/.test(bandId)) return { ok: false, error: 'Ugyldigt bandId — kun a-z, 0-9, og bindestreg' };
  const props = PropertiesService.getScriptProperties();
  const key = PROP_TENANT_PREFIX + bandId;
  if (props.getProperty(key)) return { ok: false, error: 'Band-id findes allerede' };

  let createdSheet = false;
  if (sheetId) {
    // Eksisterende Sheet — verificér at vi kan åbne det før vi registrerer.
    try { SpreadsheetApp.openById(sheetId); }
    catch (e) {
      console.error('actRegisterTenant: kunne ikke åbne Sheet ' + sheetId + ': ' + (e && e.stack || e));
      return { ok: false, error: 'Kunne ikke åbne Sheet — tjek sheetId og at master-scriptet har Editor-adgang. (Detaljer er logget.)' };
    }
  } else {
    // Auto-provisionér: scriptet kører som data controller og opretter selv Sheet'et.
    // Intet manuelt sheetId, ingen deling — den oprettende konto ejer filen.
    try {
      // Opret Sheet'et nu; flyttes ind i bandets egen mappe længere nede
      // (når rootFolderId er klar), så ALT for bandet ligger samlet.
      const ss = SpreadsheetApp.create(bandName + ' – Banddata');
      sheetId = ss.getId();
      createdSheet = true;
    } catch (e) {
      console.error('actRegisterTenant: kunne ikke oprette Sheet automatisk: ' + (e && e.stack || e));
      return { ok: false, error: 'Kunne ikke oprette Sheet automatisk. Prøv igen — detaljer er logget.' };
    }
  }

  props.setProperty(key, JSON.stringify({ sheetId: sheetId, name: bandName }));
  // Initialiser fanerne i bandet's sheet
  CURRENT_BAND_ID = bandId;
  setupSheet();
  // Opret bandets Drive-rodmappe (Band-app/<bandId>/) og flyt det auto-oprettede
  // Sheet ind i den, så ALT for bandet — Sheet, Assets og Fakturaer — ligger
  // samlet ét sted. rootFolderId caches i tenant-JSON fra dag ét.
  try {
    const bandRoot = _getBandRootFolder();
    if (createdSheet) {
      const f = DriveApp.getFileById(sheetId);
      bandRoot.addFile(f);
      DriveApp.getRootFolder().removeFile(f);
    }
  } catch (e) { Logger.log('Kunne ikke flytte Sheet til band-mappe (oprettes/flyttes ved første brug): ' + e); }
  // Skriv det rigtige bandnavn ind i Settings (setupSheet seeder kun defaults).
  _setSettings({ bandName: bandName });

  // Skabelon: kopiér udseende/opsætning fra et eksisterende band, hvis valgt.
  // Kun brand-/udseende-felter — IKKE kontaktinfo, bank, CPR eller logo-fil (band-specifikt).
  if (p.templateBandId) {
    try {
      const tpl = String(p.templateBandId).trim();
      PropertiesService.getScriptProperties().getProperty(PROP_TENANT_PREFIX + tpl); // findes?
      const newId = CURRENT_BAND_ID;
      CURRENT_BAND_ID = tpl; _invalidateBandConfigCache();
      const tcfg = getBandConfig();
      CURRENT_BAND_ID = newId; _invalidateBandConfigCache();
      const COPY_KEYS = ['theme', 'primaryColor', 'primaryColorSoft', 'primaryColorDeep',
                         'bgColor', 'textColor', 'fontUi', 'fontDisplay', 'riderText', 'riderTemplates', 'bandTagline'];
      const changes = {};
      COPY_KEYS.forEach(k => { if (tcfg[k] !== undefined && String(tcfg[k]) !== '') changes[k] = tcfg[k]; });
      if (Object.keys(changes).length) _setSettings(changes);
    } catch (e) { Logger.log('Skabelon-kopiering fejlede (band oprettet uden skabelon): ' + e); }
  }

  const seedPw = SETTINGS_DEFAULTS.seedPassword || 'skiftmig2026';
  if (p.adminEmail && p.adminName) {
    const pf = _newPasswordFields(sha256(seedPw));
    _writeRow('Members', {
      id: 'm' + Date.now(),
      name: String(p.adminName).trim(),
      category: 'Musiker', instrument: '', phone: '',
      email: String(p.adminEmail).trim(),
      regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt, forcePasswordChange: true,
      role: 'admin', createdAt: new Date()
    });
    _addBandToIdentity(String(p.adminEmail).trim().toLowerCase(), bandId);
  }
  _audit(_operatorActor(p), 'band-oprettet', bandId, bandName + (p.templateBandId ? (' (skabelon: ' + p.templateBandId + ')') : ''));

  // Onboarding-email til ny admin (#7). Fejler aldrig oprettelsen — mailen er en bonus.
  let emailSent = false;
  if (p.sendOnboardingEmail && p.adminEmail) {
    try {
      const loginUrl = String(p.loginUrl || '').trim();
      const subject = 'Velkommen til ' + bandName + ' – din band-app';
      const body = [
        'Hej' + (p.adminName ? ' ' + String(p.adminName).trim() : '') + ',',
        '',
        'Der er oprettet en band-app til ' + bandName + ', og du er sat op som administrator.',
        '',
        loginUrl ? ('Log ind her:\n' + loginUrl) : ('Band-id: ' + bandId),
        '',
        'Email: ' + String(p.adminEmail).trim(),
        'Midlertidig adgangskode: ' + seedPw,
        '',
        'Du bliver bedt om at vælge en ny adgangskode første gang du logger ind.',
        '',
        'God fornøjelse!'
      ].join('\n');
      MailApp.sendEmail(String(p.adminEmail).trim(), subject, body);
      emailSent = true;
      _audit(_operatorActor(p), 'onboarding-email-sendt', bandId, String(p.adminEmail).trim());
    } catch (e) {
      Logger.log('Onboarding-email fejlede (band oprettet alligevel): ' + e);
    }
  }

  return { ok: true, bandId: bandId, sheetId: sheetId, seedPassword: seedPw, createdSheet: createdSheet, emailSent: emailSent };
}

/**
 * Drive-mappe der samler alle auto-oprettede band-Sheets, så din Drive forbliver
 * organiseret efterhånden som antallet af bands vokser. ID caches i Script Properties.
 */
function _getAppFolder() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP_APP_FOLDER_ID);
  if (cached) {
    try { return DriveApp.getFolderById(cached); } catch (e) { /* mappe slettet — opret ny */ }
  }
  const it = DriveApp.getFoldersByName('Band-app');
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder('Band-app');
  props.setProperty(PROP_APP_FOLDER_ID, folder.getId());
  return folder;
}

/**
 * Persisterer et ekstra felt på tenant-objektet (fx rootFolderId).
 * Tenant-JSON round-trippes som helhed, så eksisterende felter bevares.
 */
function _saveTenantField(bandId, field, value) {
  const props = PropertiesService.getScriptProperties();
  const key = PROP_TENANT_PREFIX + bandId;
  const data = JSON.parse(props.getProperty(key));
  data[field] = value;
  props.setProperty(key, JSON.stringify(data));
}

/**
 * Band-app/<bandId>/ — per-band rodmappe i Drive. ID caches i tenant-JSON og
 * mappen genskabes hvis den er slettet. Alle band-specifikke Drive-opslag SKAL
 * gå gennem denne (aldrig DriveApp.getFoldersByName globalt) — ellers kan
 * bands med samme mappenavne kollidere på tværs af tenants.
 */
function _getBandRootFolder() {
  if (!CURRENT_BAND_ID) throw _userError('CURRENT_BAND_ID ikke sat — bandId mangler i request');
  const tenant = _loadTenant(CURRENT_BAND_ID);
  if (tenant.rootFolderId) {
    try {
      const f = DriveApp.getFolderById(tenant.rootFolderId);
      if (!f.isTrashed()) return f;
    } catch (e) { /* slettet — opret ny */ }
  }
  const app = _getAppFolder();
  const it = app.getFoldersByName(CURRENT_BAND_ID);
  const folder = it.hasNext() ? it.next() : app.createFolder(CURRENT_BAND_ID);
  _lockdownFolder(folder);
  _saveTenantField(CURRENT_BAND_ID, 'rootFolderId', folder.getId());
  return folder;
}

/** Undermappe i bandets rodmappe — oprettes hvis den mangler. */
function _getBandSubFolder(name, lockdown) {
  const root = _getBandRootFolder();
  const it = root.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  const f = root.createFolder(name);
  if (lockdown) _lockdownFolder(f);
  return f;
}

/**
 * Opdaterer (eller tilføjer) key/value-rækker i nuværende bands Settings-fane.
 * Genbruges af onboarding og operatør-actions. Invaliderer config-cachen.
 */
function _setSettings(changes) {
  const sh = _getSheet('Settings');
  const lastRow = sh.getLastRow();
  const rows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const keyToRow = {};
  rows.forEach((r, i) => { keyToRow[r[0]] = i + 2; });
  Object.keys(changes).forEach(k => {
    if (keyToRow[k]) sh.getRange(keyToRow[k], 2).setValue(changes[k]);
    else sh.appendRow([k, changes[k]]);
  });
  _invalidateBandConfigCache();
}

function actUpdateTenant(p) {
  _verifyAdminSignature(p);
  const bandId = String(p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
  const props = PropertiesService.getScriptProperties();
  const key = PROP_TENANT_PREFIX + bandId;
  const raw = props.getProperty(key);
  if (!raw) return { ok: false, error: 'Ukendt band: ' + bandId };
  const data = JSON.parse(raw);
  if (p.bandName) {
    data.name = String(p.bandName);
    // Synkronisér bandnavnet ind i bandets egen Settings, så branding (titel, login-skærm)
    // følger med omdøbningen — ikke kun routing-listen i operatør-UI'et.
    try { CURRENT_BAND_ID = bandId; _setSettings({ bandName: String(p.bandName) }); }
    catch (e) { Logger.log('Kunne ikke synkronisere Settings.bandName ved omdøbning: ' + e); }
  }
  if (p.sheetId) data.sheetId = String(p.sheetId);
  // Betalt feature: tværgående jobs/honorar. Kun operatøren kan slå den til/fra.
  if (p.crossBand !== undefined) {
    data.crossBand = (p.crossBand === true || p.crossBand === 'true' || p.crossBand === 1 || p.crossBand === '1');
    _audit(_operatorActor(p), data.crossBand ? 'crossband-slaaet-til' : 'crossband-slaaet-fra', bandId, '');
  }
  props.setProperty(key, JSON.stringify(data));
  if (p.bandName) _audit(_operatorActor(p), 'band-omdoebt', bandId, '→ ' + p.bandName);
  return { ok: true };
}

function actDeleteTenant(p) {
  _verifyAdminSignature(p);
  const bandId = String(p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
  // Sletter kun routing-bindingen. Sheet, Drive og data forbliver urørt.
  PropertiesService.getScriptProperties().deleteProperty(PROP_TENANT_PREFIX + bandId);
  _audit(_operatorActor(p), 'band-fjernet-fra-liste', bandId, '');
  return { ok: true };
}

/**
 * Sætter band-status: 'active' eller 'suspended'. Suspenderet = login blokeret
 * (actLogin afviser), men intet data slettes. Operatør-only.
 */
function actSetTenantStatus(p) {
  _verifyAdminSignature(p);
  const bandId = String(p.targetBandId || '').trim();
  const status = String(p.status || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
  if (status !== 'active' && status !== 'suspended') return { ok: false, error: 'Ugyldig status (active/suspended)' };
  const props = PropertiesService.getScriptProperties();
  const key = PROP_TENANT_PREFIX + bandId;
  const raw = props.getProperty(key);
  if (!raw) return { ok: false, error: 'Ukendt band: ' + bandId };
  const data = JSON.parse(raw);
  data.status = status;
  props.setProperty(key, JSON.stringify(data));
  _audit(_operatorActor(p), status === 'suspended' ? 'band-sat-paa-pause' : 'band-genaktiveret', bandId, '');
  return { ok: true, status: status };
}

// ─── Audit-log (operatør-handlinger) ────────────────────────────────────────
//
// Hver operatør-/admin-handling der ændrer data logges til et dedikeret Sheet i
// Band-app-mappen (timestamp, hvem, handling, band, detalje). Sheet frem for
// Script Properties pga. 9KB-grænsen pr. property — loggen kan vokse frit og er
// eksporterbar for GDPR-ansvarlighed. Logning fejler aldrig en handling.

const AUDIT_HEADERS = ['timestamp', 'actor', 'action', 'bandId', 'detail'];

/** Hvem udførte handlingen — operatør-email fra token, ellers HMAC-admin. */
function _operatorActor(p) {
  if (p && p.operatorToken) {
    try {
      const payload = String(p.operatorToken).split('.')[0];
      const data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString('UTF-8'));
      return data.email || 'operator';
    } catch (e) { return 'operator'; }
  }
  return 'hmac-admin';
}

function _getAuditSheet() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(PROP_AUDIT_SHEET_ID);
  if (cached) {
    try { return SpreadsheetApp.openById(cached).getSheets()[0]; } catch (e) { /* slettet — opret ny */ }
  }
  const ss = SpreadsheetApp.create('Band-app – Audit-log');
  const sh = ss.getSheets()[0];
  sh.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Flyt ind i Band-app-mappen så alt ligger samlet.
  try {
    const app = _getAppFolder();
    const f = DriveApp.getFileById(ss.getId());
    app.addFile(f);
    DriveApp.getRootFolder().removeFile(f);
  } catch (e) { Logger.log('Kunne ikke flytte audit-sheet til app-mappe: ' + e); }
  props.setProperty(PROP_AUDIT_SHEET_ID, ss.getId());
  return sh;
}

/** Append én audit-linje. Sluger fejl — en handling må aldrig fejle pga. logning. */
function _audit(actor, action, bandId, detail) {
  try {
    _getAuditSheet().appendRow([new Date(), actor || '', action || '', bandId || '', detail || '']);
  } catch (e) { Logger.log('Audit-log fejlede (handling fortsætter): ' + e); }
}

function actGetAuditLog(p) {
  _verifyAdminSignature(p);
  const sh = _getAuditSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, entries: [] };
  const n = Math.min(200, lastRow - 1);
  const data = sh.getRange(lastRow - n + 1, 1, n, AUDIT_HEADERS.length).getValues();
  const entries = data.map(r => ({
    ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
    actor: String(r[1]), action: String(r[2]), bandId: String(r[3]), detail: String(r[4])
  })).reverse(); // nyeste først
  return { ok: true, entries: entries };
}

// ─── Operatør: sundhedstjek pr. band ────────────────────────────────────────
//
// Band-scoped (CURRENT_BAND_ID sat af handle()). Returnerer nøgletal + hvad der
// mangler, så operatøren ser status uden at logge ind som bandet. Kaldes pr. band
// (frontend fyrer dem parallelt) — holder hver request lille og undgår timeout.

function actBandHealth(p) {
  _verifyAdminSignature(p);
  const cfg = getBandConfig();
  const members = _readAll('Members');
  const contracts = _readAll('Contracts');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let upcoming = 0, nextGig = '';
  const contractIds = {};
  contracts.forEach(c => {
    contractIds[String(c.id)] = true;
    if (!c.date) return;
    const d = new Date(c.date);
    if (isNaN(d.getTime()) || d < today) return;
    upcoming++;
    if (!nextGig || d < new Date(nextGig)) nextGig = d.toISOString();
  });
  const hasCpr = !!PropertiesService.getScriptProperties().getProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID);

  // Dataintegritets-tjek (#10): faresignaler operatøren bør reagere på.
  const admins = members.filter(m => String(m.role) === 'admin').length;
  let orphanAttendances = 0;
  _readAll('Attendances').forEach(a => {
    if (a.contractId && !contractIds[String(a.contractId)]) orphanAttendances++;
  });
  const overdueCutoff = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  let overdueInvoices = 0;
  _readAll('Invoices').forEach(inv => {
    if (String(inv.status) !== 'udestaaende' || !inv.date) return;
    const d = new Date(inv.date);
    if (!isNaN(d.getTime()) && d < overdueCutoff) overdueInvoices++;
  });

  return {
    ok: true,
    health: {
      members: members.length,
      admins: admins,
      upcomingGigs: upcoming,
      nextGig: nextGig,
      hasLogo: !!String(cfg.logoFileId || '').trim(),
      hasRider: !!(String(cfg.riderFileId || '').trim() || String(cfg.riderText || '').trim()),
      hasBank: !!(String(cfg.bankReg || '').trim() && String(cfg.bankKto || '').trim()),
      hasCpr: hasCpr,
      warnings: {
        noAdmin: admins === 0,
        orphanAttendances: orphanAttendances,
        overdueInvoices: overdueInvoices
      }
    }
  };
}

// ─── GDPR-opbevaring: auto-slet gammel login-log (#3) ───────────────────────
//
// retentionLoginLogMonths (pr. band, i Settings) gemmes i operatør-UI'et men blev
// ikke håndhævet. purgeOldLoginLogs() køres dagligt af en tidsstyret trigger og
// sletter LoginLog-rækker ældre end politikken. Tom/0 = behold alt (uændret).

/** Sletter LoginLog-rækker ældre end N måneder for nuværende band. Returnerer antal slettede. */
function _pruneLoginLog(months) {
  const m = Number(months);
  if (!m || m <= 0) return 0;
  const sh = _getSheet('LoginLog');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - m);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const tsCol = headers.indexOf('timestamp');
  if (tsCol === -1) return 0;
  const data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const keep = data.filter(row => {
    const d = new Date(row[tsCol]);
    return isNaN(d.getTime()) ? true : d >= cutoff; // ulæselig timestamp beholdes for en sikkerheds skyld
  });
  const deleted = data.length - keep.length;
  if (deleted === 0) return 0;
  // Omskriv databladet (LoginLog har ingen id-kolonne → kan ikke bruge _deleteRowById).
  sh.getRange(2, 1, data.length, headers.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, headers.length).setValues(keep);
  return deleted;
}

/** Trigger-mål: kører oprydning for ALLE bands efter hvert bands egen politik. */
function purgeOldLoginLogs() {
  const summary = [];
  _listTenants().forEach(t => {
    try {
      CURRENT_BAND_ID = t.bandId;
      const months = getBandConfig().retentionLoginLogMonths;
      const deleted = _pruneLoginLog(months);
      if (deleted > 0) {
        summary.push({ bandId: t.bandId, deleted: deleted });
        _audit('system', 'login-log-renset', t.bandId, 'slettede ' + deleted + ' rækker (>' + months + ' mdr.)');
      }
    } catch (e) { Logger.log('Log-oprydning fejlede for ' + t.bandId + ': ' + e); }
  });
  return summary;
}

/** Operatør: kør oprydning nu (manuelt, til test/ad hoc). */
function actRunRetentionNow(p) {
  _verifyAdminSignature(p);
  return { ok: true, summary: purgeOldLoginLogs() };
}

/**
 * KØR ÉN GANG: installerer en daglig trigger (kl. 03) der renser gammel login-log.
 * Kræver script.scriptapp-scope. Sikker at køre flere gange — rydder dubletter først.
 */
function installRetentionTrigger_RUN_ME() {
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (tr.getHandlerFunction() === 'purgeOldLoginLogs') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('purgeOldLoginLogs').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Daglig log-oprydning installeret (kører ~kl. 03). Politik styres pr. band via retentionLoginLogMonths.');
}

// ─── Backup/eksport pr. band (#8) ───────────────────────────────────────────

function actBackupBand(p) {
  _verifyAdminSignature(p);
  const sheetId = _getSheetId();
  const cfg = getBandConfig();
  const name = (cfg.bandName || CURRENT_BAND_ID) + ' – backup ' + _isoDateStamp(new Date());
  const folder = _getBandSubFolder('Backups', true);
  const copy = DriveApp.getFileById(sheetId).makeCopy(name, folder);
  _audit(_operatorActor(p), 'backup-oprettet', CURRENT_BAND_ID, name);
  return { ok: true, url: copy.getUrl(), name: name };
}

/** YYYY-MM-DD til filnavne. */
function _isoDateStamp(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ─── iCal-kalenderfeed pr. band (#9) ────────────────────────────────────────
//
// Capability-URL: ?action=ical&band=<id>&token=<t>. Token (hemmelig, pr. band)
// gater adgang — kalender-apps abonnerer på URL'en uden login. doGet() afskærer
// 'ical' før handle() og returnerer rå text/calendar (se actIcalFeed).

function _getOrCreateFeedToken(bandId) {
  const props = PropertiesService.getScriptProperties();
  const key = PROP_FEED_TOKEN_PREFIX + bandId;
  let token = props.getProperty(key);
  if (!token) {
    token = Utilities.base64EncodeWebSafe(_secureRandomBytes(24)).replace(/=+$/, '');
    props.setProperty(key, token);
  }
  return token;
}

function actGetFeedUrl(p) {
  _verifyAdminSignature(p);
  const token = _getOrCreateFeedToken(CURRENT_BAND_ID);
  return { ok: true, token: token, bandId: CURRENT_BAND_ID };
}

function actRotateFeedToken(p) {
  _verifyAdminSignature(p);
  PropertiesService.getScriptProperties().deleteProperty(PROP_FEED_TOKEN_PREFIX + CURRENT_BAND_ID);
  const token = _getOrCreateFeedToken(CURRENT_BAND_ID);
  _audit(_operatorActor(p), 'feed-token-fornyet', CURRENT_BAND_ID, '');
  return { ok: true, token: token, bandId: CURRENT_BAND_ID };
}

/** Returnerer rå .ics. Valideres via band+token (konstant-tid). Intet login. */
function actIcalFeed(params) {
  const bandId = String(params.band || '').trim();
  const token = String(params.token || '');
  const ics = (body) => ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.ICAL);
  if (!bandId) return ics('');
  try { _loadTenant(bandId); } catch (e) { return ics(''); }
  CURRENT_BAND_ID = bandId;
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_FEED_TOKEN_PREFIX + bandId) || '';
  // Konstant-tids sammenligning
  if (!expected || token.length !== expected.length) return ics('');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  if (diff !== 0) return ics('');

  const cfg = getBandConfig();
  const calName = (cfg.bandName || bandId) + ' – gigs';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Band-app//Gigs//DA',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + _icalEsc(calName), 'X-WR-TIMEZONE:Europe/Copenhagen'
  ];
  _readAll('Contracts').forEach(c => {
    if (!c.date) return;
    const day = new Date(c.date);
    if (isNaN(day.getTime())) return;
    const venue = _parseJsonField(c.venue) || {};
    const arr = _parseJsonField(c.arrangoer) || {};
    const title = venue.name || arr.name || c.type || 'Gig';
    const loc = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const descParts = [];
    if (c.getIn) descParts.push('Get-in: ' + c.getIn);
    if (c.soundcheck) descParts.push('Soundcheck: ' + c.soundcheck);
    if (c.showtimeFrom) descParts.push('Show: ' + c.showtimeFrom + (c.showtimeTo ? '–' + c.showtimeTo : ''));
    if (c.notes) descParts.push(String(c.notes));
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + bandId + '-' + c.id + '@band-app');
    lines.push('SUMMARY:' + _icalEsc(title));
    // Timet hvis showtimeFrom (HH:MM) findes, ellers heldags.
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(c.showtimeFrom || '').trim());
    if (t) {
      const start = new Date(day); start.setHours(Number(t[1]), Number(t[2]), 0, 0);
      const te = /^(\d{1,2}):(\d{2})$/.exec(String(c.showtimeTo || '').trim());
      const end = new Date(start);
      if (te) { end.setHours(Number(te[1]), Number(te[2]), 0, 0); if (end <= start) end.setDate(end.getDate() + 1); }
      else end.setHours(end.getHours() + 2);
      lines.push('DTSTART:' + _icalDateTime(start));
      lines.push('DTEND:' + _icalDateTime(end));
    } else {
      const next = new Date(day); next.setDate(next.getDate() + 1);
      lines.push('DTSTART;VALUE=DATE:' + _icalDate(day));
      lines.push('DTEND;VALUE=DATE:' + _icalDate(next));
    }
    if (loc) lines.push('LOCATION:' + _icalEsc(loc));
    if (descParts.length) lines.push('DESCRIPTION:' + _icalEsc(descParts.join('\n')));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return ics(lines.join('\r\n'));
}

function _icalEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function _icalDate(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}
function _icalDateTime(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  // Floating local time (ingen Z) — vises i abonnentens lokale tid; passer til faste klokkeslæt.
  return _icalDate(d) + 'T' + p(d.getHours()) + p(d.getMinutes()) + '00';
}

// ─── Band-scoped admin actions ──────────────────────────────────────────────

function actAdminReadConfig(p) {
  _verifyAdminSignature(p);
  return { ok: true, config: getBandConfig() };
}

function actAdminWriteConfig(p) {
  _verifyAdminSignature(p);
  const changes = p.changes; // {key: value}
  if (!changes || typeof changes !== 'object') return { ok: false, error: 'changes mangler' };
  const sh = _getSheet('Settings');
  const lastRow = sh.getLastRow();
  const rows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const keyToRow = {};
  rows.forEach((r, i) => { keyToRow[r[0]] = i + 2; });
  Object.keys(changes).forEach(k => {
    if (!(k in SETTINGS_DEFAULTS)) return; // ignorér ukendte keys
    const value = changes[k];
    if (keyToRow[k]) {
      sh.getRange(keyToRow[k], 2).setValue(value);
    } else {
      sh.appendRow([k, value]);
    }
  });
  _invalidateBandConfigCache();
  _audit(_operatorActor(p), 'config-aendret', CURRENT_BAND_ID, Object.keys(changes).filter(k => k in SETTINGS_DEFAULTS).join(', '));
  return { ok: true };
}

function actAdminUpsertMember(p) {
  _verifyAdminSignature(p);
  const m = p.member;
  if (!m || !m.email || !m.name) return { ok: false, error: 'email + name kræves' };
  const existing = _findMemberByEmail(m.email);
  const cfg = getBandConfig();
  if (existing) {
    const patch = {};
    ['name','category','instrument','phone','regAccount','address','role'].forEach(k => {
      if (m[k] !== undefined) patch[k] = m[k];
    });
    _updateRowById('Members', existing.id, patch);
    _addBandToIdentity(m.email, CURRENT_BAND_ID);
    _audit(_operatorActor(p), 'medlem-aendret', CURRENT_BAND_ID, m.email);
    return { ok: true, id: existing.id, created: false };
  }
  const id = 'm' + Date.now();
  const pf = _newPasswordFields(sha256(cfg.seedPassword));
  _writeRow('Members', {
    id: id,
    name: m.name, category: m.category || 'Musiker', instrument: m.instrument || '',
    phone: m.phone || '', email: m.email, regAccount: m.regAccount || '',
    address: m.address || '',
    passwordHash: pf.passwordHash, pwSalt: pf.pwSalt, forcePasswordChange: true,
    role: m.role || 'member', createdAt: new Date()
  });
  _addBandToIdentity(m.email, CURRENT_BAND_ID);
  _audit(_operatorActor(p), 'medlem-oprettet', CURRENT_BAND_ID, m.email);
  return { ok: true, id: id, created: true };
}

function actAdminDeleteMember(p) {
  _verifyAdminSignature(p);
  if (!p.id) return { ok: false, error: 'id mangler' };
  const ok = _deleteRowById('Members', p.id);
  if (ok) _audit(_operatorActor(p), 'medlem-slettet', CURRENT_BAND_ID, String(p.id));
  return { ok: ok };
}

/**
 * Upload logo eller rider til en delt assets-mappe. Returnerer Drive file ID.
 * payload: { kind: 'logo'|'rider', filename, contentType, dataBase64 }
 * Admin-tool skriver derefter file ID til Settings via actAdminWriteConfig.
 */
function actAdminUploadAsset(p) {
  _verifyAdminSignature(p);
  if (!p.dataBase64 || !p.filename) return { ok: false, error: 'dataBase64 + filename kræves' };
  const folder = _getAssetsFolder();
  const blob = Utilities.newBlob(
    Utilities.base64Decode(p.dataBase64),
    p.contentType || 'application/octet-stream',
    p.filename
  );
  const file = folder.createFile(blob);
  _audit(_operatorActor(p), 'asset-uploadet', CURRENT_BAND_ID, (p.kind || 'fil') + ': ' + p.filename);
  return { ok: true, fileId: file.getId(), url: file.getUrl() };
}

function _getAssetsFolder() {
  // Per-band mappe: Band-app/<bandId>/Assets/ — bandId-forælderen disambiguerer,
  // så intet navnebaseret globalt opslag (kolliderede tidligere på tværs af bands).
  // Logo/rider serveres som bytes gennem scriptet (actGetConfig/actGetRider),
  // så mappen kan være låst uden at noget brækker.
  return _getBandSubFolder('Assets', true);
}

// ─── Faktureringsoplysninger (band-admin selvbetjening) ──────────────────────

/**
 * Returnerer bankoplysninger + CPR-status til autentificeret admin.
 * CPR returneres IKKE i klartekst her — brug getBandCpr til faktura-rendering.
 */
function actAdminGetBillingInfo(p) {
  _requireAdmin(p.email, p.passwordHash);
  const cfg = getBandConfig();
  const hasCpr = !!PropertiesService.getScriptProperties().getProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID);
  return {
    ok: true,
    billing: {
      bankName: cfg.bankName || '',
      bankReg: cfg.bankReg || '',
      bankKto: cfg.bankKto || '',
      payeeName: cfg.payeeName || '',
      payeeAddress: cfg.payeeAddress || '',
      hasCpr: hasCpr
    }
  };
}

/**
 * Gemmer bankoplysninger + krypteret band-CPR. Kaldes fra Indstillinger-siden i admin-UI.
 * p.cpr: CPR-nummer i klartekst (sendes over HTTPS, krypteres inden lagring).
 * p.bankName / p.bankReg / p.bankKto: bankoplysninger til Settings-sheet.
 */
function actAdminSaveBillingInfo(p) {
  _requireAdmin(p.email, p.passwordHash);
  const props = PropertiesService.getScriptProperties();

  // Gem krypteret CPR hvis det er sendt
  if (p.cpr !== undefined && p.cpr !== '') {
    const cpr = String(p.cpr).trim();
    if (!/^\d{6}-?\d{4}$/.test(cpr)) {
      return { ok: false, error: 'Ugyldigt CPR-format — forventet DDMMYY-XXXX' };
    }
    props.setProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID, _encryptCpr(cpr));
  }

  // Gem bankoplysninger i Settings-sheet
  const changes = {};
  ['bankName', 'bankReg', 'bankKto', 'payeeName', 'payeeAddress'].forEach(k => {
    if (p[k] !== undefined) changes[k] = String(p[k]).trim();
  });
  if (Object.keys(changes).length > 0) {
    const sh = _getSheet('Settings');
    const lastRow = sh.getLastRow();
    const rows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
    const keyToRow = {};
    rows.forEach((r, i) => { keyToRow[r[0]] = i + 2; });
    Object.keys(changes).forEach(k => {
      if (keyToRow[k]) {
        sh.getRange(keyToRow[k], 2).setValue(changes[k]);
      } else {
        sh.appendRow([k, changes[k]]);
      }
    });
    _invalidateBandConfigCache();
  }

  const hasCpr = !!props.getProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID);
  return { ok: true, hasCpr: hasCpr };
}

// ─── Slet band (GDPR: ret til sletning ved ophør) ────────────────────────────

/**
 * Sletter alle data for bandet: Sheet, Drive-mapper og Script Properties.
 * Kræver admin-auth + dobbelt bekræftelse (p.confirm === bandId).
 * Logger sletning i DELETED_BANDS property inden data fjernes (audit trail).
 */
function actAdminDeleteBand(p) {
  _requireAdmin(p.email, p.passwordHash);
  if (!p.confirm || String(p.confirm) !== String(CURRENT_BAND_ID)) {
    return { ok: false, error: 'Bekræftelse mangler eller forkert — send confirm: "<bandId>"' };
  }

  const props = PropertiesService.getScriptProperties();

  // Audit-log inden sletning (hvem, hvornår, hvilket band)
  const auditKey = 'DELETED_BANDS';
  const existing = props.getProperty(auditKey) || '[]';
  let log = [];
  try { log = JSON.parse(existing); } catch (e) {}
  log.push({ bandId: CURRENT_BAND_ID, deletedBy: p.email, deletedAt: new Date().toISOString() });
  props.setProperty(auditKey, JSON.stringify(log));

  // Slet Drive: Sheet
  const tenant = _loadTenant(CURRENT_BAND_ID);
  try {
    DriveApp.getFileById(tenant.sheetId).setTrashed(true);
  } catch (e) {
    Logger.log('Kunne ikke slette Sheet for ' + CURRENT_BAND_ID + ': ' + e);
  }

  // Slet Drive: bandets egen rodmappe (Band-app/<bandId>/ med Fakturaer + Assets).
  // VIGTIGT: kun via cached folder-ID — aldrig navnebaseret søgning, som kunne
  // ramme andre bands' mapper med samme navn.
  try {
    if (tenant.rootFolderId) DriveApp.getFolderById(tenant.rootFolderId).setTrashed(true);
    else Logger.log('Ingen rootFolderId for ' + CURRENT_BAND_ID + ' — ingen band-mappe at slette (evt. legacy-mapper skal ryddes manuelt)');
  } catch (e) {
    Logger.log('Kunne ikke slette band-mappe for ' + CURRENT_BAND_ID + ': ' + e);
  }

  // Slet Script Properties for bandet
  props.deleteProperty(PROP_TENANT_PREFIX + CURRENT_BAND_ID);
  props.deleteProperty(PROP_BAND_CPR_PREFIX + CURRENT_BAND_ID);

  // Invalider cache
  try { CacheService.getScriptCache().remove(_cacheKey('bandConfig')); } catch (e) {}

  _audit(p.email || _operatorActor(p), 'band-SLETTET-permanent', CURRENT_BAND_ID, 'Sheet + Drive-mappe flyttet til papirkurv');
  return { ok: true };
}

// ─── Udseende (tema + accentfarve) ──────────────────────────────────────────

const VALID_THEMES = ['kul', 'grafit', 'beton', 'stål', 'tåge'];
// Tilladte font-keys (skal matche FONT_OPTIONS i index.html + de loadede Google Fonts).
const VALID_FONTS = ['Inter', 'Space Grotesk', 'IBM Plex Sans', 'Instrument Serif', 'IBM Plex Serif', 'Fraunces'];

/**
 * Gemmer tema og accentfarver til Settings-sheet.
 * Kun whitelistede keys tillades — forhindrer overskrivning af andre settings.
 */
/**
 * Musiker opdaterer egne profildata.
 * Kun felter der er harmløse at lade musikeren ændre selv tillades.
 * Role og passwordHash kan aldrig ændres ad denne vej.
 */
function actMemberUpdateProfile(p) {
  const m = _verifyAuth(p.email, p.passwordHash);
  if (!m) throw _userError('Ikke logget ind');
  const allowed = ['name', 'phone', 'instrument', 'address'];
  const patch = {};
  allowed.forEach(k => { if (p[k] !== undefined) patch[k] = String(p[k]); });
  if (!Object.keys(patch).length) return { ok: false, error: 'Ingen felter at opdatere' };
  _updateRowById('Members', m.id, patch);
  // Returnér opdaterede data så frontend kan opdatere SESSION.member
  return { ok: true, member: Object.assign({}, m, patch) };
}

/**
 * Deployer (via admin-tool) nulstiller en brugers password til bandets seedPassword.
 * Brugeren tvinges til at vælge nyt password ved næste login.
 */
function actAdminResetMemberPassword(p) {
  _verifyAdminSignature(p);
  const email = String(p.memberEmail || '').trim();
  if (!email) return { ok: false, error: 'memberEmail mangler' };
  const m = _findMemberByEmail(email);
  if (!m) return { ok: false, error: 'Ingen bruger med den email' };
  const seedPw = getBandConfig().seedPassword || SETTINGS_DEFAULTS.seedPassword || 'skiftmig2026';
  const pf = _newPasswordFields(sha256(seedPw));
  _updateRowById('Members', m.id, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt, forcePasswordChange: true });
  _syncIdentityPassword(m.email, pf); // SSO: nulstilling gælder alle bands
  _audit(_operatorActor(p), 'kode-nulstillet', CURRENT_BAND_ID, email);
  return { ok: true, seedPassword: seedPw };
}

function actAdminSaveAppearance(p) {
  _requireAdminOrOperator(p);
  const allowed = { theme: 1, primaryColor: 1, primaryColorSoft: 1, primaryColorDeep: 1, bgColor: 1, textColor: 1, fontUi: 1, fontDisplay: 1 };
  const changes = {};
  Object.keys(allowed).forEach(k => {
    if (p[k] !== undefined) changes[k] = String(p[k]).trim();
  });
  if (changes.theme && VALID_THEMES.indexOf(changes.theme) === -1) {
    return { ok: false, error: 'Ukendt tema: ' + changes.theme };
  }
  // HEX-farver: tom værdi = ryd override; ellers skal det være #RRGGBB.
  ['primaryColor', 'bgColor', 'textColor'].forEach(k => {
    if (changes[k] && !/^#[0-9A-Fa-f]{6}$/.test(changes[k])) {
      throw new Error('Ugyldig farve i ' + k + ' — brug hex-format #RRGGBB');
    }
  });
  // Fonte: tom = brug temaets; ellers skal det være en kendt font-key.
  ['fontUi', 'fontDisplay'].forEach(k => {
    if (changes[k] && VALID_FONTS.indexOf(changes[k]) === -1) {
      throw new Error('Ukendt font i ' + k + ': ' + changes[k]);
    }
  });
  if (!Object.keys(changes).length) return { ok: false, error: 'Ingen ændringer sendt' };

  const sh = _getSheet('Settings');
  const lastRow = sh.getLastRow();
  const rows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const keyToRow = {};
  rows.forEach((r, i) => { keyToRow[r[0]] = i + 2; });
  Object.keys(changes).forEach(k => {
    if (keyToRow[k]) {
      sh.getRange(keyToRow[k], 2).setValue(changes[k]);
    } else {
      sh.appendRow([k, changes[k]]);
    }
  });
  _invalidateBandConfigCache();
  return { ok: true };
}
