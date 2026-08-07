/**
 * Tests.gs — in-script testsuite for band-app backenden.
 *
 * Apps Script har ingen ekstern test-runner uden clasp+jest, så vi kører testene
 * INDE i scriptet: åbn projektet, vælg `runAllTests` i funktions-dropdownen og kør.
 * Resultatet (PASS/FAIL pr. test) skrives til Execution log.
 *
 * To lag:
 *   1. UNIT (runUnitTests) — rene funktioner med ÉT entydigt korrekt svar:
 *      CSPRNG, CPR-kryptering, password-hashing, app-token, lås-reentrans.
 *      Kræver INTET band-Sheet og er sikre at køre når som helst.
 *   2. INTEGRATION (runIntegrationTests) — kører mod et SEPARAT test-band, så de
 *      rører rigtige Sheets uden at røre produktion. Kræver at TEST_BAND_ID
 *      (Script Property) peger på et engangs-band. Springes over hvis ikke sat.
 *
 * Hvorfor det er sat op sådan: en test er kun en test hvis den asserter mod en
 * kendt-korrekt opførsel. Unit-laget har facit indbygget (roundtrip, determinisme,
 * konstant-tid). Integration-laget skal have et "rent" band at måle op imod —
 * derfor et dedikeret test-tenant frem for produktionsdata.
 */

// ─── Mini-assert framework ────────────────────────────────────────────────────

var _TEST_RESULTS = [];

function _ok(name, cond, detail) {
  _TEST_RESULTS.push({ name: name, pass: !!cond, detail: cond ? '' : (detail || '') });
}

function _eq(name, actual, expected) {
  const pass = String(actual) === String(expected);
  _ok(name, pass, 'forventet ' + JSON.stringify(expected) + ', fik ' + JSON.stringify(actual));
}

function _report(label) {
  const passed = _TEST_RESULTS.filter(r => r.pass).length;
  const failed = _TEST_RESULTS.filter(r => !r.pass);
  Logger.log('──────── ' + label + ' ────────');
  _TEST_RESULTS.forEach(r => Logger.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.pass ? '' : '  → ' + r.detail)));
  Logger.log('──────── ' + passed + '/' + _TEST_RESULTS.length + ' bestået' + (failed.length ? ', ' + failed.length + ' FEJLEDE' : '') + ' ────────');
  const out = { total: _TEST_RESULTS.length, passed: passed, failed: failed.length };
  _TEST_RESULTS = [];
  return out;
}

// ─── Opsætning af test-bands (kør disse FØR runAllTests) ──────────────────────

/**
 * 1) Kør denne for at se ALLE bands' bandId'er. Find dine to test-bands i listen
 *    og kopiér deres bandId (kolonnen til venstre — IKKE det viste navn).
 */
function listTestBandIds_RUN_ME() {
  const tenants = _listTenants();
  if (!tenants.length) { Logger.log('Ingen bands fundet endnu.'); return; }
  Logger.log('──── bandId  →  navn ────');
  tenants.forEach(t => Logger.log('  ' + t.bandId + '   →   ' + t.name));
  Logger.log('─────────────────────────');
  Logger.log('Indsæt de to test-bandId\'er i setupTests_RUN_ME() nedenfor og kør den.');
}

/**
 * 2) Indsæt dine to test-bandId'er her og kør funktionen ÉN gang. Den gemmer dem
 *    som Script Properties, så runAllTests() kan finde dem. (Alternativt kan de
 *    sættes manuelt under ⚙ Project Settings → Script Properties.)
 */
function setupTests_RUN_ME() {
  const TEST_BAND_ID   = 'SKIFT-MIG-1';   // ← bandId for testband1 (fra listen ovenfor)
  const TEST_BAND_ID_2 = 'SKIFT-MIG-2';   // ← bandId for testband2 (skal være et ANDET band)

  if (TEST_BAND_ID === 'SKIFT-MIG-1' || TEST_BAND_ID_2 === 'SKIFT-MIG-2') {
    throw new Error('Ret de to bandId\'er i setupTests_RUN_ME() først. Kør listTestBandIds_RUN_ME() for at se dem.');
  }
  if (TEST_BAND_ID === TEST_BAND_ID_2) {
    throw new Error('De to test-bands skal være FORSKELLIGE (ellers kan isolation ikke testes).');
  }
  const props = PropertiesService.getScriptProperties();
  // Verificér at begge bandId'er faktisk findes, så vi ikke kører mod ingenting.
  [TEST_BAND_ID, TEST_BAND_ID_2].forEach(id => {
    if (!props.getProperty(PROP_TENANT_PREFIX + id)) {
      throw new Error('Ukendt bandId: "' + id + '". Kør listTestBandIds_RUN_ME() og kopiér en gyldig værdi.');
    }
  });
  props.setProperty('TEST_BAND_ID', TEST_BAND_ID);
  props.setProperty('TEST_BAND_ID_2', TEST_BAND_ID_2);
  Logger.log('OK — TEST_BAND_ID=' + TEST_BAND_ID + ', TEST_BAND_ID_2=' + TEST_BAND_ID_2 + '. Kør nu runAllTests().');
}

/**
 * Mål hvor lang tid ét password-hash tager med det NUVÆRENDE PW_ITERATIONS, og
 * anbefal et tal der rammer ~250ms pr. login. Kør den, læs loggen, og justér
 * PW_ITERATIONS i Code.gs hvis nødvendigt.
 */
function benchmarkHashing_RUN_ME() {
  const clientHash = sha256('benchmark-password');
  const salt = _genSalt();
  const t0 = Date.now();
  _hashPassword(clientHash, salt);
  const ms = Date.now() - t0;
  const perIter = ms / PW_ITERATIONS;
  const target = 250;                       // ønsket login-tid i ms
  const recommended = Math.max(1000, Math.round((target / perIter) / 1000) * 1000);
  Logger.log('Ét hash med ' + PW_ITERATIONS + ' iterationer tog ' + ms + ' ms (' + perIter.toFixed(4) + ' ms/iter).');
  Logger.log('For ~' + target + ' ms login: sæt PW_ITERATIONS ≈ ' + recommended + ' i Code.gs.');
  Logger.log('(Login laver dette ÉN gang; testsuiten laver mange — hold tallet rimeligt.)');
}

// ─── Entry points ─────────────────────────────────────────────────────────────

function runAllTests() {
  const u = runUnitTests();
  const i = runIntegrationTests();
  Logger.log('SAMLET: unit ' + u.passed + '/' + u.total + ', integration ' + i.passed + '/' + i.total);
  return { unit: u, integration: i };
}

// ─── UNIT ─────────────────────────────────────────────────────────────────────

function runUnitTests() {
  _TEST_RESULTS = [];

  // CSPRNG: korrekt længde + ingen triviel gentagelse mellem to træk.
  const a = _secureRandomBytes(16);
  const b = _secureRandomBytes(16);
  _eq('csprng: returnerer ønsket antal bytes', a.length, 16);
  _ok('csprng: alle bytes i [0,255]', a.every(x => x >= 0 && x <= 255), 'byte uden for interval: ' + a.join(','));
  _ok('csprng: to træk er forskellige', a.join(',') !== b.join(','), 'to træk var identiske — ikke tilfældigt');
  _eq('csprng: vilkårlig længde understøttes (40)', _secureRandomBytes(40).length, 40);

  // base64-varianten skal dekode til samme antal bytes.
  _eq('csprng: base64(32) dekoder til 32 bytes', Utilities.base64Decode(_secureRandomBase64(32)).length, 32);

  // Password-hashing: deterministisk pr. (hash,salt), men salt ændrer output.
  const clientHash = sha256('hunter2');
  const salt1 = _genSalt();
  const salt2 = _genSalt();
  _eq('hash: deterministisk for samme salt', _saltedHash(clientHash, salt1), _saltedHash(clientHash, salt1));
  _ok('hash: forskelligt salt → forskelligt resultat',
      _saltedHash(clientHash, salt1) !== _saltedHash(clientHash, salt2),
      'to forskellige salte gav samme hash');
  _ok('hash: salt er unikt pr. kald', salt1 !== salt2, 'to _genSalt-kald gav samme salt');

  // Key stretching (#3): nuværende-generations hash er self-describing og verificerbar,
  // og ALLE ældre generationer skal stadig kunne verificeres + markeres til opgradering.
  const pf = _newPasswordFields(clientHash);
  _ok('stretch: hash har formatet pbkdf2$<iter>$<h>', pf.passwordHash.indexOf(PW_ALGO + '$' + PW_ITERATIONS + '$') === 0, pf.passwordHash);
  _ok('stretch: korrekt password verificeres', _verifyHash(clientHash, pf.pwSalt, pf.passwordHash));
  _ok('stretch: forkert password afvises', !_verifyHash(sha256('forkert'), pf.pwSalt, pf.passwordHash));
  _ok('stretch: nuværende hash kræver ikke rehash', !_needsRehash(pf.passwordHash));

  // Legacy-kompatibilitet: gamle saltede (ét-HMAC) og usaltede hashes.
  const legacySalted = _saltedHash(clientHash, salt1);
  _ok('legacy saltet: verificeres stadig', _verifyHash(clientHash, salt1, legacySalted));
  _ok('legacy saltet: markeres til opgradering', _needsRehash(legacySalted));
  _ok('legacy usaltet: verificeres stadig', _verifyHash(clientHash, '', clientHash));
  _ok('legacy usaltet: markeres til opgradering', _needsRehash(clientHash));

  // Konstant-tids sammenligning.
  _ok('constTimeEq: ens strenge', _constTimeEq('abc', 'abc'));
  _ok('constTimeEq: forskellig længde afvises', !_constTimeEq('abc', 'abcd'));
  _ok('constTimeEq: samme længde, forskelligt indhold afvises', !_constTimeEq('abc', 'abd'));

  // App-token: konstant-tids-sammenligning skal acceptere korrekt og afvise alt andet.
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_APP_TOKEN) || APP_TOKEN_DEFAULT;
  _ok('apptoken: korrekt token accepteres', _appTokenOk({ appToken: expected }));
  _ok('apptoken: forkert token afvises', !_appTokenOk({ appToken: 'forkert' }));
  _ok('apptoken: tom token afvises', !_appTokenOk({}));
  _ok('apptoken: token med forkert længde afvises', !_appTokenOk({ appToken: expected + 'x' }));

  // CPR-kryptering: roundtrip skal give plaintext igen; ciphertext ≠ plaintext;
  // to krypteringer af samme værdi skal afvige (random nonce).
  _runWithTempCprKey(function() {
    const cpr = '0101901234';
    const ct = _encryptCpr(cpr);
    _eq('cpr: roundtrip dekrypterer til original', _decryptCpr(ct), cpr);
    _ok('cpr: ciphertext afslører ikke plaintext', ct.indexOf(cpr) === -1, 'plaintext læselig i ciphertext');
    _ok('cpr: samme plaintext → forskellig ciphertext (nonce)', _encryptCpr(cpr) !== _encryptCpr(cpr),
        'to krypteringer var identiske — nonce genbruges?');
    // v2: autentificeret format (encrypt-then-MAC).
    _ok('cpr: nyt format er v2-præfikset', ct.indexOf('v2:') === 0, 'forventede "v2:"-prefix');
    // Manipulation skal afvises af integritetstjekket i stedet for at dekryptere til vrøvl.
    const decoded = Utilities.base64Decode(ct.substring('v2:'.length));
    decoded[decoded.length - 1] = decoded[decoded.length - 1] ^ 0x01; // flip en bit i tag'en
    const tampered = 'v2:' + Utilities.base64Encode(decoded);
    let rejected = false;
    try { _decryptCpr(tampered); } catch (e) { rejected = true; }
    _ok('cpr: manipuleret ciphertext afvises (INT-CTXT)', rejected, 'tamper blev IKKE opdaget');
  });

  // _withLock: reentrant (ingen deadlock ved indre kald) og returnerer fn's værdi.
  const lockVal = _withLock(function() {
    _eq('lås: depth=1 i ydre sektion', _LOCK_DEPTH, 1);
    const inner = _withLock(function() {
      _eq('lås: depth=2 i indre (reentrant) sektion', _LOCK_DEPTH, 2);
      return 'indre';
    });
    _eq('lås: indre returværdi propageres', inner, 'indre');
    return 42;
  });
  _eq('lås: ydre returværdi propageres', lockVal, 42);
  _eq('lås: depth nulstilles efter frigivelse', _LOCK_DEPTH, 0);

  return _report('UNIT');
}

/** Kører fn med en midlertidig CPR-nøgle og gendanner den oprindelige bagefter. */
function _runWithTempCprKey(fn) {
  const props = PropertiesService.getScriptProperties();
  const original = props.getProperty(PROP_MASTER_CPR_KEY);
  try {
    props.setProperty(PROP_MASTER_CPR_KEY, _secureRandomBase64(32));
    fn();
  } finally {
    if (original === null) props.deleteProperty(PROP_MASTER_CPR_KEY);
    else props.setProperty(PROP_MASTER_CPR_KEY, original);
  }
}

// ─── INTEGRATION (mod et separat test-band) ────────────────────────────────────
//
// Sættes op én gang: opret et engangs-band via operatør-UI'et, og sæt Script
// Property TEST_BAND_ID = dets bandId. Testene skriver/sletter KUN i det band.
// Uden TEST_BAND_ID springes suiten over (så CI/produktion ikke rører data).

function runIntegrationTests() {
  _TEST_RESULTS = [];
  const testBand = PropertiesService.getScriptProperties().getProperty('TEST_BAND_ID');
  if (!testBand) {
    Logger.log('──────── INTEGRATION sprunget over (sæt Script Property TEST_BAND_ID for at køre) ────────');
    return { total: 0, passed: 0, failed: 0, skipped: true };
  }
  CURRENT_BAND_ID = testBand;

  // Atomar id-generering: to på hinanden følgende inserts må ALDRIG få samme id.
  // (Ægte samtidighed kan ikke fremtvinges i én eksekvering, men vi verificerer
  //  at _insertWithId + _nextId giver monotont voksende, unikke id'er.)
  const id1 = _insertWithId('Members', 'm', function(id) {
    return { id: id, name: 'TEST_A', category: 'Musiker', email: '', role: 'member', createdAt: new Date() };
  });
  const id2 = _insertWithId('Members', 'm', function(id) {
    return { id: id, name: 'TEST_B', category: 'Musiker', email: '', role: 'member', createdAt: new Date() };
  });
  _ok('integration: _insertWithId giver unikke id', id1 !== id2, 'id1=' + id1 + ' id2=' + id2);

  // Oprydning — efterlad test-bandet rent.
  _deleteRowById('Members', id1);
  _deleteRowById('Members', id2);
  _ok('integration: testrækker ryddet op', !_findMemberById(id1) && !_findMemberById(id2), 'oprydning fejlede');

  // ── Auth-gates: rollen skal håndhæves server-side ──
  // Disse beviser at en menig musiker ikke kan udføre admin-handlinger.
  const adminPw = 'IT-admin-pw-9', memberPw = 'IT-member-pw-9';
  const adminEmail = _itCreateMember(testBand, 'admin', 'admin', adminPw);
  const memberEmail = _itCreateMember(testBand, 'member', 'member', memberPw);
  try {
    _ok('gate: korrekt password verificeres', !!_verifyAuth(adminEmail, sha256(adminPw)));
    _ok('gate: forkert password afvises', !_verifyAuth(adminEmail, sha256('helt-forkert')));

    let adminPassed = false;
    try { _requireAdmin(adminEmail, sha256(adminPw)); adminPassed = true; } catch (e) {}
    _ok('gate: _requireAdmin tillader admin', adminPassed);

    let memberBlocked = false;
    try { _requireAdmin(memberEmail, sha256(memberPw)); } catch (e) { memberBlocked = true; }
    _ok('gate: _requireAdmin afviser menigt medlem', memberBlocked);

    // En faktisk admin-only action skal også afvise et medlem.
    let actionBlocked = false;
    try { actGetMembers({ email: memberEmail, passwordHash: sha256(memberPw) }); } catch (e) { actionBlocked = true; }
    _ok('gate: actGetMembers afviser medlem', actionBlocked);
  } finally {
    _itDeleteMember(testBand, 'admin');
    _itDeleteMember(testBand, 'member');
  }

  // ── Tenant-isolation: ét gyldigt password må IKKE give adgang til et fremmed band ──
  // Kræver et ANDET test-band (Script Property TEST_BAND_ID_2). Springes ellers over.
  const band2 = PropertiesService.getScriptProperties().getProperty('TEST_BAND_ID_2');
  if (band2 && band2 !== testBand) {
    const isoPw = 'IT-iso-pw-9';
    CURRENT_BAND_ID = testBand;
    const isoEmail = _itCreateMember(testBand, 'iso', 'member', isoPw);
    try {
      // Login i eget band → opretter et gyldigt SSO-identitetskort.
      _ok('isolation: bruger kan logge ind i sit eget band', !!_verifyAuth(isoEmail, sha256(isoPw)));
      // SAMME gyldige password mod band 2, hvor brugeren IKKE er medlem → skal afvises.
      CURRENT_BAND_ID = band2;
      _ok('isolation: gyldigt SSO-password giver IKKE adgang til fremmed band',
          !_verifyAuth(isoEmail, sha256(isoPw)),
          'SSO lækkede adgang til et band brugeren ikke er medlem af!');
    } finally {
      CURRENT_BAND_ID = testBand;
      _itDeleteMember(testBand, 'iso');
    }
  } else {
    Logger.log('  (isolation-test sprunget over — sæt TEST_BAND_ID_2 til et ANDET test-band)');
  }

  return _report('INTEGRATION');
}

// ─── Integrationstest-helpers (opretter/sletter engangsbrugere idempotent) ────

function _itEmail(role) { return '__it_' + role + '@example.invalid'; }

/** Opret en testbruger med kendt password i det aktuelle band. Idempotent. */
function _itCreateMember(bandId, label, role, plainPw) {
  CURRENT_BAND_ID = bandId;
  _itDeleteMember(bandId, label);                 // ryd evt. rest fra tidligere kørsel
  const email = _itEmail(label);
  const pf = _newPasswordFields(sha256(plainPw));
  _insertWithId('Members', 'm', function(id) {
    return {
      id: id, name: 'IT ' + label, category: 'Musiker', instrument: '', phone: '',
      email: email, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: false, role: role, createdAt: new Date()
    };
  });
  return email;
}

/** Slet testbrugeren OG dens SSO-identitetskort, så intet hænger ved. */
function _itDeleteMember(bandId, label) {
  CURRENT_BAND_ID = bandId;
  const email = _itEmail(label);
  const m = _findMemberByEmail(email);
  if (m) _deleteRowById('Members', m.id);
  try { PropertiesService.getScriptProperties().deleteProperty(_identityKey(email)); } catch (e) {}
}
