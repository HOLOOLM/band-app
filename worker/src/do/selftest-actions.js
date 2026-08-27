// Selvtest af Fase 3a-actionsene gennem routeren.
//
// Testene går gennem runAction frem for at kalde action-funktionerne direkte,
// så gaten testes sammen med logikken. Det er netop kombinationen der er værd
// at teste: en korrekt action bag en manglende gate er stadig et hul.

import { runAction } from '../actions/router.js';
import { validateActionTable, ACTIONS } from '../actions/index.js';
import { bandStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { PUBLIC_CONFIG_KEYS, NEVER_PUBLIC_KEYS, SETTINGS_DEFAULTS } from '../lib/settings-defaults.js';

const BAND = 'selftest-actions';
const EMAIL = 'medlem@test.dk';
const ADMIN = 'admin@test.dk';
const KODE = 'et-rigtigt-langt-password';

export async function actionChecks(ydreEnv, ok, advarsler) {
  // Tokens kræver MASTER_SECRET. Lokalt er den ikke sat (den lever som
  // wrangler-secret i produktion), så testen kører med sin egen — ellers ville
  // hele Fase 3a være utestbar uden at have produktionshemmeligheder på disken.
  //
  // At den mangler er dog værd at vide, for uden den kan ingen logge ind. Den
  // rapporteres derfor som advarsel frem for at blive tiet ihjel.
  if (!ydreEnv.MASTER_SECRET) {
    advarsler.push('MASTER_SECRET er ikke sat i dette miljø. Forventet lokalt — men ' +
      'login virker IKKE i produktion før den er uploadet med `wrangler secret put ' +
      'MASTER_SECRET`. Selvtesten bruger en midlertidig nøgle.');
  }
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  // ── Action-tabellen skal være velformet ───────────────────────────────────
  const tabelFejl = validateActionTable();
  ok('action-tabel: alle scope/auth-værdier er gyldige', tabelFejl.length === 0,
     tabelFejl.length ? tabelFejl.join('; ') : Object.keys(ACTIONS).length + ' actions');

  // ── Sæt et band op med to medlemmer ──────────────────────────────────────
  const band = bandStub(env, BAND);
  const iter = pwIterations(env);
  const clientHash = await sha256hex(KODE);

  await band.putSettings({
    bandName: 'Selvtest Band', bandShortName: 'SELV',
    seedPassword: 'HEMMELIGT-SEED', bankReg: '1234', bankKto: '5678',
    logoFileId: 'drive-id-der-ikke-maa-laekke'
  }, ['bandName', 'bandShortName', 'seedPassword', 'bankReg', 'bankKto', 'logoFileId']);
  await band.syncMeta({ band_id: BAND, name: 'Selvtest Band', status: 'active' });

  for (const [id, email, role] of [['m1', EMAIL, 'member'], ['m2', ADMIN, 'admin']]) {
    const pf = await newPasswordFields(clientHash, iter);
    await band.updateMember(id, {});             // no-op, sikrer at #ready har kørt
    const findes = await band.findMemberByEmail(email);
    if (!findes) {
      await band.insertMember({
        id, name: 'Test ' + role, category: 'Musiker', instrument: '', phone: '',
        email, regAccount: '', address: '',
        passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
        forcePasswordChange: 1, role, createdAt: new Date().toISOString()
      });
    } else {
      await band.setMemberPassword(id, pf.passwordHash, pf.pwSalt, true);
    }
  }
  await band.clearLoginAttempts(EMAIL);

  const kald = (action, p, creds) => runAction(env, action, Object.assign({ bandId: BAND }, p), creds);

  // ── getConfig: offentlig, men må ikke lække hemmeligheder ────────────────
  const cfg = await kald('getConfig', {});
  ok('getConfig: svarer uden auth', cfg.ok === true);
  ok('getConfig: indeholder bandnavn', cfg.config && cfg.config.bandName === 'Selvtest Band',
     cfg.config && cfg.config.bandName);

  const laekket = NEVER_PUBLIC_KEYS.filter(k => cfg.config && cfg.config[k] !== undefined);
  ok('getConfig: lækker INGEN hemmelige nøgler', laekket.length === 0,
     laekket.length ? 'LÆKKEDE: ' + laekket.join(', ') : NEVER_PUBLIC_KEYS.length + ' nøgler tjekket');

  const seedIRaw = JSON.stringify(cfg).includes('HEMMELIGT-SEED');
  ok('getConfig: seedPassword findes ikke nogen steder i svaret', !seedIRaw);
  ok('getConfig: logoFileId findes ikke i svaret',
     !JSON.stringify(cfg).includes('drive-id-der-ikke-maa-laekke'));
  ok('getConfig: defaults udfylder manglende nøgler',
     cfg.config.theme === SETTINGS_DEFAULTS.theme, cfg.config.theme);

  // ── login ────────────────────────────────────────────────────────────────
  const bad = await kald('login', { email: EMAIL, passwordHash: await sha256hex('forkert') });
  ok('login: forkert kode afvises med forsøg-tæller',
     bad.ok === false && /forsøg tilbage/.test(bad.error), bad.error);

  const good = await kald('login', { email: EMAIL, passwordHash: clientHash });
  ok('login: korrekt kode lykkes', good.ok === true, good.error);
  ok('login: returnerer medlem, rolle og token',
     good.member && good.member.id === 'm1' && good.role === 'member' &&
     String(good.memberToken || '').startsWith('mt:'));
  ok('login: forcePasswordChange videregives', good.forcePasswordChange === true);
  // Bevidst JSON.stringify(good) og ikke good.member: hash eller salt må ikke
  // optræde NOGEN steder i svaret, heller ikke uden for member-objektet.
  ok('login: svaret indeholder IKKE hash eller salt',
     !/passwordHash|pwSalt/i.test(JSON.stringify(good || {})));

  // Rate-limit: tælleren skal være nulstillet efter et lykket login.
  const st = await band.loginAttemptState(EMAIL, 5, 900);
  ok('login: forsøg-tælleren nulstilles ved succes', st.attempts === 0, 'attempts=' + st.attempts);

  // ── Lockout efter 5 forsøg ───────────────────────────────────────────────
  const laas = 'laas@test.dk';
  const pfL = await newPasswordFields(clientHash, iter);
  if (!await band.findMemberByEmail(laas)) {
    await band.insertMember({
      id: 'm3', name: 'Laas', category: 'Musiker', instrument: '', phone: '',
      email: laas, regAccount: '', address: '',
      passwordHash: pfL.passwordHash, pwSalt: pfL.pwSalt,
      forcePasswordChange: 0, role: 'member', createdAt: new Date().toISOString()
    });
  }
  await band.clearLoginAttempts(laas);
  let sidste;
  for (let i = 0; i < 5; i++) {
    sidste = await kald('login', { email: laas, passwordHash: await sha256imod(i) });
  }
  ok('login: låser efter 5 fejlede forsøg',
     sidste.ok === false && /låst/.test(sidste.error), sidste.error);
  const efterLaas = await kald('login', { email: laas, passwordHash: clientHash });
  ok('login: KORREKT kode afvises også mens kontoen er låst',
     efterLaas.ok === false && /15 minutter/.test(efterLaas.error), efterLaas.error);
  await band.clearLoginAttempts(laas);

  // ── refreshSession ───────────────────────────────────────────────────────
  const tok = good.memberToken;
  const rs = await kald('refreshSession', { email: EMAIL, passwordHash: tok });
  ok('refreshSession: gyldigt token fornyes', rs.ok === true && String(rs.memberToken).startsWith('mt:'));
  const rsBad = await kald('refreshSession', { email: EMAIL, passwordHash: 'mt:vrøvl.vrøvl' });
  ok('refreshSession: ugyldigt token afvises',
     rsBad.ok === false && rsBad.error === 'Session udløbet', rsBad.error);

  // Et udløbet token må IKKE tælle mod lockout — ellers kan et helt band låse
  // sig selv ude ved at genindlæse samtidig (Code.gs:1649).
  await band.clearLoginAttempts(EMAIL);
  for (let i = 0; i < 6; i++) await kald('refreshSession', { email: EMAIL, passwordHash: 'mt:d.d' });
  const stEfter = await band.loginAttemptState(EMAIL, 5, 900);
  ok('refreshSession: fejl tæller IKKE mod login-lockout',
     stEfter.attempts === 0 && !stEfter.locked, 'attempts=' + stEfter.attempts);

  // ── trackLogin: gaten skal virke ─────────────────────────────────────────
  const tlUden = await kald('trackLogin', { ua: 'test' }, null);
  ok('trackLogin: afvises uden session', tlUden.ok === false && /Ikke logget ind/.test(tlUden.error),
     tlUden.error);
  const tlMed = await kald('trackLogin', { ua: 'test-agent' }, { email: EMAIL, token: tok });
  ok('trackLogin: lykkes med gyldig session', tlMed.ok === true, tlMed.error);
  const tlFalsk = await kald('trackLogin', { ua: 'x' }, { email: EMAIL, token: 'mt:falsk.falsk' });
  ok('trackLogin: afvises med forfalsket token', tlFalsk.ok === false);

  // ── changePassword ───────────────────────────────────────────────────────
  const nyKode = await sha256hex('en-helt-ny-kode-der-er-lang');
  const cpForkert = await kald('changePassword',
    { email: EMAIL, oldHash: await sha256hex('ikke-den-rigtige'), newHash: nyKode });
  ok('changePassword: forkert gammel kode afvises',
     cpForkert.ok === false && /gamle adgangskode/.test(cpForkert.error), cpForkert.error);

  const cpKort = await kald('changePassword', { email: EMAIL, oldHash: clientHash, newHash: 'kort' });
  ok('changePassword: ny kode skal være en 64-tegns sha256',
     cpKort.ok === false && /Ugyldig ny/.test(cpKort.error), cpKort.error);

  const cpSamme = await kald('changePassword',
    { email: EMAIL, oldHash: clientHash, newHash: clientHash });
  ok('changePassword: ny kode må ikke være den gamle', cpSamme.ok === false, cpSamme.error);

  const cp = await kald('changePassword', { email: EMAIL, oldHash: clientHash, newHash: nyKode });
  ok('changePassword: lykkes og udsteder nyt token',
     cp.ok === true && String(cp.memberToken).startsWith('mt:'), cp.error);

  // Det GAMLE token skal være dødt: fingeraftrykket peger på det gamle password.
  const gammeltTok = await kald('refreshSession', { email: EMAIL, passwordHash: tok });
  ok('changePassword: gamle tokens er ugyldige bagefter',
     gammeltTok.ok === false, 'svar: ' + JSON.stringify(gammeltTok).slice(0, 60));
  const nytTok = await kald('refreshSession', { email: EMAIL, passwordHash: cp.memberToken });
  ok('changePassword: det nye token virker', nytTok.ok === true, nytTok.error);

  // Den gamle kode må ikke længere kunne bruges, den nye skal kunne.
  await band.clearLoginAttempts(EMAIL);
  const gammelKode = await kald('login', { email: EMAIL, passwordHash: clientHash });
  ok('changePassword: gammel kode virker ikke længere', gammelKode.ok === false);
  await band.clearLoginAttempts(EMAIL);
  const nyLogin = await kald('login', { email: EMAIL, passwordHash: nyKode });
  ok('changePassword: ny kode virker', nyLogin.ok === true, nyLogin.error);
  ok('changePassword: forcePasswordChange ryddet', nyLogin.forcePasswordChange === false);

  // ── Suspenderet band blokerer login ──────────────────────────────────────
  await band.syncMeta({ status: 'suspended' });
  await band.clearLoginAttempts(EMAIL);
  const susp = await kald('login', { email: EMAIL, passwordHash: nyKode });
  ok('login: suspenderet band blokerer login',
     susp.ok === false && /deaktiveret/.test(susp.error), susp.error);
  await band.syncMeta({ status: 'active' });

  // ── Ukendt action og manglende bandId ────────────────────────────────────
  const ukendt = await runAction(env, 'derFindesIkke', { bandId: BAND });
  ok('router: ukendt action afvises', ukendt.ok === false && /Ukendt handling/.test(ukendt.error));
  const udenBand = await runAction(env, 'getConfig', {});
  ok('router: manglende bandId afvises', udenBand.ok === false && /bandId/.test(udenBand.error),
     udenBand.error);

  // ── Isolation gennem routeren ────────────────────────────────────────────
  // Samme session-credentials mod et ANDET band må ikke give adgang.
  const andet = await runAction(env, 'trackLogin',
    { bandId: 'selftest-actions-andet', ua: 'x' }, { email: EMAIL, token: cp.memberToken });
  ok('isolation: gyldig session i band A giver ikke adgang til band B',
     andet.ok === false && /Ikke logget ind/.test(andet.error), andet.error);
}

// Hjælper: fem forskellige forkerte hashes, så hvert forsøg er unikt.
async function sha256imod(i) {
  return sha256hex('forkert-' + i);
}
