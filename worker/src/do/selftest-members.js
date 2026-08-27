// Selvtest af Fase 3b — medlemmer, startkoder, SSO og GDPR-eksport.
//
// De to vigtigste tests her er ikke CRUD, men:
//   1. at to nye medlemmer får FORSKELLIGE startkoder (den delte seedPassword
//      var den mest umiddelbare sikkerhedssvaghed i originalen), og
//   2. at et kodeskift i band A også gælder i band B — SSO-fejlen jeg indførte
//      i Fase 3a ved kun at verificere mod bandets egen række.

import { runAction } from '../actions/router.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { genTempPassword } from '../actions/members.js';

const A = 'selftest-m-a';
const B = 'selftest-m-b';
const ADMIN = 'chef@test.dk';
const DELT = 'delt@test.dk';       // musiker i BEGGE bands
const KODE = 'admin-kode-der-er-lang';

export async function memberChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  const iter = pwIterations(env);
  const bandA = bandStub(env, A);
  const bandB = bandStub(env, B);
  const master = masterStub(env);

  // ── Startkoder skal være unikke ───────────────────────────────────────────
  const koder = new Set();
  for (let i = 0; i < 20; i++) koder.add(genTempPassword());
  ok('startkode: 20 kald giver 20 forskellige koder', koder.size === 20, koder.size + ' unikke');
  const en = genTempPassword();
  ok('startkode: 14 tegn', en.length === 14, en.length + ' tegn');
  ok('startkode: undgår tegn der forveksles (0/O/1/l/I)',
     !/[0O1lI]/.test([...koder].join('')), 'tjekket over 20 koder');

  // ── Sæt en admin op i band A ─────────────────────────────────────────────
  await bandA.syncMeta({ band_id: A, name: 'Band A', status: 'active' });
  await bandB.syncMeta({ band_id: B, name: 'Band B', status: 'active' });
  await master.createBand(A, 'Band A');
  await master.createBand(B, 'Band B');

  const adminHash = await sha256hex(KODE);
  if (!await bandA.findMemberByEmail(ADMIN)) {
    const pf = await newPasswordFields(adminHash, iter);
    await bandA.insertMember({
      id: 'a1', name: 'Chef', category: 'Musiker', instrument: '', phone: '',
      email: ADMIN, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 0, role: 'admin', createdAt: new Date().toISOString()
    });
  } else {
    const pf = await newPasswordFields(adminHash, iter);
    await bandA.setMemberPassword('a1', pf.passwordHash, pf.pwSalt, false);
  }
  await bandA.clearLoginAttempts(ADMIN);

  const kaldA = (action, p, creds) => runAction(env, action, Object.assign({ bandId: A }, p), creds);
  const kaldB = (action, p, creds) => runAction(env, action, Object.assign({ bandId: B }, p), creds);

  const adminLogin = await kaldA('login', { email: ADMIN, passwordHash: adminHash });
  ok('3b-opsætning: admin kan logge ind', adminLogin.ok === true, adminLogin.error);
  const adminCreds = { email: ADMIN, token: adminLogin.memberToken };

  // ── Gates: en almindelig bruger må ikke røre medlemslisten ────────────────
  const uden = await kaldA('getMembers', {}, null);
  ok('gate: getMembers afvises uden session', uden.ok === false, uden.error);

  // ── Opret to medlemmer ───────────────────────────────────────────────────
  const navne = ['Ny Musiker Et', 'Ny Musiker To'];
  const emails = ['ny1@test.dk', 'ny2@test.dk'];
  const oprettede = [];
  for (let i = 0; i < 2; i++) {
    // Ryd op fra tidligere kørsler, så testen er idempotent.
    const eks = await bandA.findMemberByEmail(emails[i]);
    if (eks) await bandA.deleteMember(eks.id);
    const r = await kaldA('saveMember',
      { member: { name: navne[i], email: emails[i], instrument: 'Bas' } }, adminCreds);
    oprettede.push(r);
  }
  ok('saveMember: opretter medlem og returnerer startkode',
     oprettede[0].ok === true && typeof oprettede[0].seedPassword === 'string' &&
     oprettede[0].seedPassword.length === 14, oprettede[0].error);

  // KERNEN i ændringen: to medlemmer må IKKE dele startkode.
  ok('saveMember: to nye medlemmer får FORSKELLIGE startkoder',
     oprettede[0].seedPassword !== oprettede[1].seedPassword,
     'forskellige: ' + (oprettede[0].seedPassword !== oprettede[1].seedPassword));

  // Og koden skal faktisk virke som login.
  await bandA.clearLoginAttempts(emails[0]);
  const nyLogin = await kaldA('login',
    { email: emails[0], passwordHash: await sha256hex(oprettede[0].seedPassword) });
  ok('saveMember: startkoden virker som login', nyLogin.ok === true, nyLogin.error);
  ok('saveMember: nyt medlem tvinges til kodeskift', nyLogin.forcePasswordChange === true);

  // Den ANDENS kode må ikke virke på den første konto.
  await bandA.clearLoginAttempts(emails[0]);
  const krydsKode = await kaldA('login',
    { email: emails[0], passwordHash: await sha256hex(oprettede[1].seedPassword) });
  ok('saveMember: medlem 2\'s kode virker IKKE på medlem 1', krydsKode.ok === false);
  await bandA.clearLoginAttempts(emails[0]);

  // ── Dublet-email afvises ─────────────────────────────────────────────────
  const dublet = await kaldA('saveMember',
    { member: { name: 'Kopi', email: emails[0] } }, adminCreds);
  ok('saveMember: dublet-email afvises',
     dublet.ok === false && /allerede i brug/.test(dublet.error), dublet.error);

  const ugyldig = await kaldA('saveMember', { member: { name: 'X', email: 'ikke-en-email' } }, adminCreds);
  ok('saveMember: ugyldig email afvises', ugyldig.ok === false, ugyldig.error);

  // ── getMembers lækker ikke hemmeligheder ─────────────────────────────────
  const liste = await kaldA('getMembers', {}, adminCreds);
  ok('getMembers: returnerer medlemmer', liste.ok === true && liste.members.length >= 3,
     (liste.members || []).length + ' medlemmer');
  ok('getMembers: ingen hash eller salt i svaret',
     !/passwordHash|pwSalt|password_hash|pw_salt/i.test(JSON.stringify(liste)));

  // ── memberUpdateProfile: whitelisten skal holde ──────────────────────────
  const medlemCreds = { email: emails[0], token: nyLogin.memberToken };
  const profil = await kaldA('memberUpdateProfile',
    { name: 'Rettet Navn', phone: '12345678', role: 'admin', email: 'kapret@test.dk' },
    medlemCreds);
  ok('memberUpdateProfile: egne felter opdateres', profil.ok === true, profil.error);
  const efter = await bandA.findMemberByEmail(emails[0]);
  ok('memberUpdateProfile: navn ændret', efter && efter.name === 'Rettet Navn', efter && efter.name);
  ok('memberUpdateProfile: role kan IKKE ændres ad denne vej',
     efter && efter.role === 'member', efter && efter.role);
  ok('memberUpdateProfile: email kan IKKE ændres ad denne vej',
     efter && efter.email === emails[0], efter && efter.email);

  // ── resetPassword ────────────────────────────────────────────────────────
  const reset = await kaldA('resetPassword', { id: oprettede[0].id }, adminCreds);
  ok('resetPassword: giver ny kode', reset.ok === true && reset.seedPassword.length === 14, reset.error);
  ok('resetPassword: ny kode er forskellig fra den oprindelige',
     reset.seedPassword !== oprettede[0].seedPassword);
  await bandA.clearLoginAttempts(emails[0]);
  const gammelKode = await kaldA('login',
    { email: emails[0], passwordHash: await sha256hex(oprettede[0].seedPassword) });
  ok('resetPassword: den gamle kode virker ikke længere', gammelKode.ok === false);
  await bandA.clearLoginAttempts(emails[0]);
  const nyEfterReset = await kaldA('login',
    { email: emails[0], passwordHash: await sha256hex(reset.seedPassword) });
  ok('resetPassword: den nye kode virker', nyEfterReset.ok === true, nyEfterReset.error);

  // ── SSO: kodeskift i band A skal gælde i band B ──────────────────────────
  // Det er fejlen fra Fase 3a. Samme e-mail oprettes i begge bands.
  for (const [stub, bid] of [[bandA, A], [bandB, B]]) {
    const eks = await stub.findMemberByEmail(DELT);
    if (eks) await stub.deleteMember(eks.id);
  }
  const iA = await kaldA('saveMember', { member: { name: 'Delt Musiker', email: DELT } }, adminCreds);
  ok('SSO: medlem oprettet i band A', iA.ok === true, iA.error);

  // Opret admin i band B, så vi kan kalde saveMember der.
  if (!await bandB.findMemberByEmail(ADMIN)) {
    const pf = await newPasswordFields(adminHash, iter);
    await bandB.insertMember({
      id: 'b1', name: 'Chef', category: 'Musiker', instrument: '', phone: '',
      email: ADMIN, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 0, role: 'admin', createdAt: new Date().toISOString()
    });
  }
  await bandB.clearLoginAttempts(ADMIN);
  const adminB = await kaldB('login', { email: ADMIN, passwordHash: adminHash });
  const adminCredsB = { email: ADMIN, token: adminB.memberToken };

  const iB = await kaldB('saveMember', { member: { name: 'Delt Musiker', email: DELT } }, adminCredsB);
  ok('SSO: samme e-mail i band B genbruger eksisterende konto',
     iB.ok === true && iB.eksisterendeBruger === true && iB.seedPassword === undefined,
     iB.besked || iB.error);

  // Log ind i A med startkoden fra A, skift kode, og verificér i B.
  await bandA.clearLoginAttempts(DELT);
  const deltLogin = await kaldA('login',
    { email: DELT, passwordHash: await sha256hex(iA.seedPassword) });
  ok('SSO: kan logge ind i band A', deltLogin.ok === true, deltLogin.error);

  const nyDelt = await sha256hex('helt-ny-delt-kode-1234');
  const skift = await kaldA('changePassword', {
    email: DELT,
    oldHash: await sha256hex(iA.seedPassword),
    newHash: nyDelt
  });
  ok('SSO: kodeskift i band A lykkes', skift.ok === true, skift.error);

  await bandB.clearLoginAttempts(DELT);
  const iBMedNy = await kaldB('login', { email: DELT, passwordHash: nyDelt });
  ok('SSO: den NYE kode virker også i band B', iBMedNy.ok === true, iBMedNy.error);

  await bandB.clearLoginAttempts(DELT);
  const iBMedGammel = await kaldB('login',
    { email: DELT, passwordHash: await sha256hex(iA.seedPassword) });
  ok('SSO: den GAMLE kode virker ikke længere i band B', iBMedGammel.ok === false);
  await bandB.clearLoginAttempts(DELT);

  // ── GDPR-eksport ─────────────────────────────────────────────────────────
  const deltIA = await bandA.findMemberByEmail(DELT);
  await bandA.trackLogin(deltIA.id, DELT, 'test-browser');
  const deltCreds = { email: DELT, token: iBMedNy.memberToken };
  await bandA.clearLoginAttempts(DELT);
  const nyDeltLogin = await kaldA('login', { email: DELT, passwordHash: nyDelt });
  const eksport = await kaldA('exportMyData', {}, { email: DELT, token: nyDeltLogin.memberToken });
  ok('exportMyData: svarer med profil', eksport.ok === true && eksport.profile.email === DELT,
     eksport.error);
  ok('exportMyData: indeholder login-historik',
     Array.isArray(eksport.loginHistory) && eksport.loginHistory.length >= 1,
     (eksport.loginHistory || []).length + ' poster');
  ok('exportMyData: ingen hash, salt eller andres data',
     !/passwordHash|pwSalt|password_hash|pw_salt/i.test(JSON.stringify(eksport)) &&
     !JSON.stringify(eksport).includes(emails[0]));

  // ── deleteMember ─────────────────────────────────────────────────────────
  const selvMord = await kaldA('deleteMember', { id: 'a1' }, adminCreds);
  ok('deleteMember: admin kan ikke slette sig selv',
     selvMord.ok === false && /dig selv/.test(selvMord.error), selvMord.error);

  const slet = await kaldA('deleteMember', { id: oprettede[1].id }, adminCreds);
  ok('deleteMember: sletter medlem', slet.ok === true, slet.error);
  ok('deleteMember: medlemmet er væk', (await bandA.findMemberByEmail(emails[1])) === null);

  const igen = await kaldA('deleteMember', { id: oprettede[1].id }, adminCreds);
  ok('deleteMember: ukendt id afvises', igen.ok === false, igen.error);

  // Gate: et almindeligt medlem må ikke kunne slette nogen.
  await bandA.clearLoginAttempts(emails[0]);
  const medlemLogin = await kaldA('login',
    { email: emails[0], passwordHash: await sha256hex(reset.seedPassword) });
  const slettForsoeg = await kaldA('deleteMember', { id: 'a1' },
    { email: emails[0], token: medlemLogin.memberToken });
  ok('gate: almindeligt medlem kan ikke slette medlemmer',
     slettForsoeg.ok === false && /administrator/.test(slettForsoeg.error), slettForsoeg.error);
  const listeForsoeg = await kaldA('getMembers', {},
    { email: emails[0], token: medlemLogin.memberToken });
  ok('gate: almindeligt medlem kan ikke se medlemslisten',
     listeForsoeg.ok === false, listeForsoeg.error);
}
