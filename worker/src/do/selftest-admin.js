// Selvtest af Fase 3i, 3j og 3k — settings/assets, operatør/master, kryds-band
// og iCal-feed.
//
// De vigtigste tests:
//   - at et asset over 2 MB chunkes og samles korrekt igen (SQL-rækkeloftet)
//   - at CPR krypteres, aldrig returneres, og at formatet valideres
//   - at et bands flag SPEJLES til band-objektet, så login faktisk blokeres af
//     en suspendering — master alene er ikke nok
//   - at kryds-band kun tæller bands hvor crossBand er slået til
//   - at iCal-feedet fejler LUKKET og ikke lækker memberNote

import { runAction } from '../actions/router.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64, decryptCpr }
  from '../lib/crypto.js';
import { buildIcal } from '../actions/crossband.js';
import { BAND_SCHEMA_VERSION } from './schema.js';

const OP = 'operator@test.dk';
const OPKODE = 'operatoer-kode-meget-lang';
const A = 'selftest-x-a';
const B = 'selftest-x-b';
const MUSIKER = 'kryds@test.dk';

export async function adminChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32),
    CPR_KEY: ydreEnv.CPR_KEY || randomBase64(32)
  });
  const iter = pwIterations(env);
  const master = masterStub(env);
  const kald = (a, p, c) => runAction(env, a, p || {}, c);

  // ── Operatør-login ───────────────────────────────────────────────────────
  const opHash = await sha256hex(OPKODE);
  const opPf = await newPasswordFields(opHash, iter);
  await master.putOperator(OP, opPf.passwordHash, opPf.pwSalt);
  await master.clearOperatorLoginAttempts(OP);

  const forkert = await kald('operatorLogin', { email: OP, passwordHash: await sha256hex('nej') });
  ok('operatorLogin: forkert kode afvises', forkert.ok === false, forkert.error);
  await master.clearOperatorLoginAttempts(OP);

  const opLogin = await kald('operatorLogin', { email: OP, passwordHash: opHash });
  ok('operatorLogin: korrekt kode giver token',
     opLogin.ok === true && typeof opLogin.token === 'string' && opLogin.token.length > 20,
     opLogin.error);
  const opCreds = { operatorToken: opLogin.token };

  const ukendtOp = await kald('operatorLogin',
    { email: 'findes-ikke@test.dk', passwordHash: opHash });
  ok('operatorLogin: ukendt operatør afvises', ukendtOp.ok === false, ukendtOp.error);

  // Lockout FØR password verificeres.
  await master.clearOperatorLoginAttempts(OP);
  let sidste;
  for (let i = 0; i < 5; i++) {
    sidste = await kald('operatorLogin', { email: OP, passwordHash: await sha256hex('gæt' + i) });
  }
  ok('operatorLogin: låser efter 5 forsøg', sidste.ok === false && /låst/.test(sidste.error),
     sidste.error);
  const laastMedKorrekt = await kald('operatorLogin', { email: OP, passwordHash: opHash });
  ok('operatorLogin: korrekt kode afvises mens låst',
     laastMedKorrekt.ok === false && /15 minutter/.test(laastMedKorrekt.error),
     laastMedKorrekt.error);
  await master.clearOperatorLoginAttempts(OP);

  // ── Gates på operatør-actions ────────────────────────────────────────────
  const udenTok = await kald('listTenants', {}, null);
  ok('gate: listTenants kræver operatør-token', udenTok.ok === false, udenTok.error);
  const medlemsTok = await kald('listTenants', {}, { operatorToken: 'mt:noget.andet' });
  ok('gate: et medlems-token virker IKKE som operatør', medlemsTok.ok === false,
     medlemsTok.error);

  // ── registerTenant ───────────────────────────────────────────────────────
  for (const bid of [A, B]) {
    try { await bandStub(env, bid).wipe(); } catch (e) {}
    await master.deleteBand(bid, 'selftest', 'oprydning');
  }
  await master.removeIdentityBand(MUSIKER, A);
  await master.removeIdentityBand(MUSIKER, B);

  const ugyldigtId = await kald('registerTenant',
    { bandId: 'Med STORE Bogstaver', bandName: 'X' }, opCreds);
  ok('registerTenant: ugyldigt band-id afvises', ugyldigtId.ok === false, ugyldigtId.error);
  const reserveret = await kald('registerTenant',
    { bandId: '__operator', bandName: 'X' }, opCreds);
  ok('registerTenant: reserveret id afvises', reserveret.ok === false, reserveret.error);

  const nyA = await kald('registerTenant', {
    bandId: A, bandName: 'Kryds Band A',
    adminEmail: MUSIKER, adminName: 'Kryds Musiker'
  }, opCreds);
  ok('registerTenant: opretter band med admin og startkode',
     nyA.ok === true && typeof nyA.seedPassword === 'string' && nyA.seedPassword.length === 14,
     nyA.error);

  const dublet = await kald('registerTenant', { bandId: A, bandName: 'Igen' }, opCreds);
  ok('registerTenant: dublet band-id afvises', dublet.ok === false, dublet.error);

  // ── Operatøren skal kunne betjene sit eget panel ─────────────────────────
  // Operatøren er ikke medlem af noget band og har ingen medlems-session.
  // adminReadConfig, adminWriteConfig, adminUploadAsset, getFeedUrl og
  // rotateFeedToken var alle gated 'admin' — så operatør-panelets Rediger-knap
  // svarede "Ikke logget ind" på sin egen konfiguration.
  //
  // Ingen test fangede det, fordi selvtesten kaldte dem med en medlems-session,
  // altså med andre rettigheder end panelet faktisk har. Derfor kaldes de her
  // med et RENT operatør-token og intet andet.
  const opLaes = await kald('adminReadConfig', { bandId: A }, opCreds);
  ok('operatør: kan læse et bands konfiguration', opLaes.ok === true, opLaes.error);

  const opSkriv = await kald('adminWriteConfig',
    { bandId: A, changes: { bandTagline: 'sat af operatøren' } }, opCreds);
  ok('operatør: kan rette et bands konfiguration', opSkriv.ok === true, opSkriv.error);

  const opFeed = await kald('getFeedUrl', { bandId: A }, opCreds);
  ok('operatør: kan hente bandets feed-token', opFeed.ok === true, opFeed.error);

  // Modstykket: tilladelsen er udtrykkelig pr. action, ikke en generel nøgle.
  // Uden dette tjek kunne nogen "løse" en fremtidig gate-fejl ved at give
  // operatøren adgang til ALT, og intet ville protestere.
  const opForbudt = await kald('saveContract',
    { bandId: A, contract: { id: 'OP-1', date: '2026-01-01' } }, opCreds);
  ok('operatør: kan IKKE handle som medlem i actions uden operatorOk',
     opForbudt.ok === false && /logget ind/i.test(String(opForbudt.error || '')),
     opForbudt.error);

  // Skabelon-kopiering.
  const bandA = bandStub(env, A);
  await bandA.putSettings({ theme: 'stål', primaryColor: '#E8A867', bandTagline: 'Tribute' },
    ['theme', 'primaryColor', 'bandTagline']);
  const nyB = await kald('registerTenant', {
    bandId: B, bandName: 'Kryds Band B',
    adminEmail: MUSIKER, adminName: 'Kryds Musiker',
    templateBandId: A
  }, opCreds);
  ok('registerTenant: opretter andet band', nyB.ok === true, nyB.error);
  ok('registerTenant: samme e-mail i andet band genbruger kontoen',
     nyB.eksisterendeBruger === true && nyB.seedPassword === undefined,
     JSON.stringify({ e: nyB.eksisterendeBruger, s: !!nyB.seedPassword }));
  const bSet = await bandStub(env, B).getSettings();
  ok('registerTenant: skabelon kopierer branding',
     bSet.theme === 'stål' && bSet.primaryColor === '#E8A867', bSet.theme + '/' + bSet.primaryColor);
  ok('registerTenant: skabelon kopierer IKKE bandnavnet',
     bSet.bandName === 'Kryds Band B', bSet.bandName);

  // ── listTenants ──────────────────────────────────────────────────────────
  const liste = await kald('listTenants', {}, opCreds);
  ok('listTenants: begge bands med', liste.ok === true &&
     liste.tenants.filter(t => [A, B].includes(t.bandId)).length === 2,
     (liste.tenants || []).length + ' bands');

  // ── Flag skal SPEJLES til band-objektet ─────────────────────────────────
  const suspend = await kald('setTenantStatus',
    { targetBandId: A, status: 'suspended' }, opCreds);
  ok('setTenantStatus: sætter suspended', suspend.ok === true, suspend.error);
  const metaEfter = (await bandA.status()).meta;
  ok('setTenantStatus: status er SPEJLET til band-objektet',
     metaEfter.status === 'suspended', metaEfter.status);

  // Og det er spejlingen der faktisk blokerer login.
  await bandA.clearLoginAttempts(MUSIKER);
  const loginSuspenderet = await kald('login',
    { bandId: A, email: MUSIKER, passwordHash: await sha256hex(nyA.seedPassword) });
  ok('setTenantStatus: suspendering blokerer login',
     loginSuspenderet.ok === false && /deaktiveret/.test(loginSuspenderet.error),
     loginSuspenderet.error);

  await kald('setTenantStatus', { targetBandId: A, status: 'active' }, opCreds);
  const ugyldigStatus = await kald('setTenantStatus',
    { targetBandId: A, status: 'noget' }, opCreds);
  ok('setTenantStatus: ugyldig status afvises', ugyldigStatus.ok === false, ugyldigStatus.error);

  const omdoeb = await kald('updateTenant',
    { targetBandId: A, bandName: 'Omdøbt A', crossBand: true }, opCreds);
  ok('updateTenant: omdøber og slår crossBand til', omdoeb.ok === true, omdoeb.error);
  ok('updateTenant: bandnavn synkroniseret til bandets settings',
     (await bandA.getSettings()).bandName === 'Omdøbt A',
     (await bandA.getSettings()).bandName);
  const cfgEfter = await kald('getConfig', { bandId: A });
  ok('updateTenant: crossBand-flaget er spejlet og ses i getConfig',
     cfgEfter.config.crossBand === true, String(cfgEfter.config.crossBand));

  // ── Settings og udseende (3i) ───────────────────────────────────────────
  await bandA.clearLoginAttempts(MUSIKER);
  const adminLogin = await kald('login',
    { bandId: A, email: MUSIKER, passwordHash: await sha256hex(nyA.seedPassword) });
  ok('3i-opsætning: band-admin kan logge ind', adminLogin.ok === true, adminLogin.error);
  const aCreds = { email: MUSIKER, token: adminLogin.memberToken };
  const kaldA = (a, p) => runAction(env, a, Object.assign({ bandId: A }, p), aCreds);

  const daarligFarve = await kaldA('adminSaveAppearance', { primaryColor: 'rød' });
  ok('adminSaveAppearance: ugyldig HEX afvises',
     daarligFarve.ok === false && /hex/i.test(daarligFarve.error), daarligFarve.error);
  const daarligTema = await kaldA('adminSaveAppearance', { theme: 'neon' });
  ok('adminSaveAppearance: ukendt tema afvises', daarligTema.ok === false, daarligTema.error);
  const daarligFont = await kaldA('adminSaveAppearance', { fontUi: 'Comic Sans' });
  ok('adminSaveAppearance: ukendt font afvises', daarligFont.ok === false, daarligFont.error);

  // DMDT's faktiske palette fra brand-presets/dmdt.json.
  const dmdt = {
    theme: 'kul', primaryColor: '#E8A867', primaryColorSoft: '#F0BE8A',
    primaryColorDeep: '#C68642', bgColor: '#08111F', bgColorCard: '#0F213C',
    bgColorRaised: '#16304F', borderColor: '#1F3D5F', textColor: '#F5EDE0',
    textColorDim: '#D9CFBE', textColorMute: '#9A9285',
    fontUi: 'Inter', fontDisplay: 'Instrument Serif'
  };
  const gemUdseende = await kaldA('adminSaveAppearance', dmdt);
  ok('adminSaveAppearance: hele DMDT-paletten accepteres', gemUdseende.ok === true,
     gemUdseende.error);
  const cfgDmdt = await kald('getConfig', { bandId: A });
  ok('adminSaveAppearance: alle 11 farver kommer med i getConfig',
     Object.keys(dmdt).filter(k => k.includes('Color')).every(k => cfgDmdt.config[k] === dmdt[k]),
     cfgDmdt.config.bgColorCard + ' / ' + cfgDmdt.config.textColorMute);

  const tom = await kaldA('adminSaveAppearance', { bgColorCard: '' });
  ok('adminSaveAppearance: tom værdi rydder overstyringen', tom.ok === true, tom.error);

  const ugyldigJson = await kaldA('adminWriteConfig',
    { changes: { riderTemplates: '{ ikke json' } });
  ok('adminWriteConfig: ugyldig riderTemplates-JSON afvises',
     ugyldigJson.ok === false, ugyldigJson.error);
  const ukendtNoegle = await kaldA('adminWriteConfig',
    { changes: { heltNyNoegle: 'x', bandTagline: 'Tribute' } });
  ok('adminWriteConfig: ukendte nøgler filtreres væk',
     ukendtNoegle.ok === true && ukendtNoegle.written === 1, String(ukendtNoegle.written));

  // ── CPR ─────────────────────────────────────────────────────────────────
  const daarligtCpr = await kaldA('adminSaveBillingInfo', { cpr: '123' });
  ok('adminSaveBillingInfo: ugyldigt CPR-format afvises',
     daarligtCpr.ok === false && /CPR/.test(daarligtCpr.error), daarligtCpr.error);

  const gemCpr = await kaldA('adminSaveBillingInfo', {
    cpr: '010190-1234', bankName: 'Sparekassen', bankReg: '9682', bankKto: '1465171'
  });
  ok('adminSaveBillingInfo: gemmer CPR og bank', gemCpr.ok === true && gemCpr.hasCpr === true,
     gemCpr.error);

  const billing = await kaldA('adminGetBillingInfo', {});
  ok('adminGetBillingInfo: bank returneres',
     billing.billing.bankReg === '9682' && billing.billing.bankKto === '1465171');
  ok('adminGetBillingInfo: CPR returneres IKKE — kun et flag',
     billing.billing.hasCpr === true && !JSON.stringify(billing).includes('010190'),
     'hasCpr=' + billing.billing.hasCpr);

  const bandRow = await master.getBand(A);
  ok('CPR: gemt krypteret, ikke i klartekst',
     bandRow.cprEnc && !bandRow.cprEnc.includes('010190') && bandRow.cprEnc.startsWith('v3:'),
     String(bandRow.cprEnc).slice(0, 12) + '…');
  ok('CPR: kan dekrypteres med den rigtige nøgle',
     (await decryptCpr(env, bandRow.cprEnc)) === '010190-1234');

  const cfgUdenCpr = await kald('getConfig', { bandId: A });
  ok('CPR: findes ikke i det offentlige getConfig-svar',
     !JSON.stringify(cfgUdenCpr).includes('010190') && !/cpr/i.test(JSON.stringify(cfgUdenCpr)));

  // ── Assets: chunking over 2 MB-loftet ───────────────────────────────────
  const lilleLogo = btoa('PNG-agtige-bytes-til-test');
  const logoOk = await kaldA('adminUploadAsset',
    { kind: 'logo', contentType: 'image/png', dataBase64: lilleLogo, filename: 'logo.png' });
  ok('adminUploadAsset: lille logo gemmes i én bid',
     logoOk.ok === true && logoOk.chunks === 1, JSON.stringify(logoOk.chunks));
  const cfgLogo = await kald('getConfig', { bandId: A });
  ok('adminUploadAsset: logoet kommer med som data-URL i getConfig',
     String(cfgLogo.config.logoDataUrl).startsWith('data:image/png;base64,'),
     String(cfgLogo.config.logoDataUrl).slice(0, 30));

  // 2,5 MB rider — skal chunkes, da loftet er 2 MB pr. SQL-række.
  const storRider = 'A'.repeat(2500000);
  const riderOk = await kaldA('adminUploadAsset',
    { kind: 'rider', contentType: 'application/pdf', dataBase64: storRider, filename: 'r.pdf' });
  ok('adminUploadAsset: rider over 2 MB deles i flere bidder',
     riderOk.ok === true && riderOk.chunks === 3, String(riderOk.chunks) + ' bidder');

  const rider = await kaldA('getRider', {});
  ok('getRider: bidderne samles korrekt igen',
     rider.ok === true && rider.kind === 'pdf' &&
     rider.dataUrl === 'data:application/pdf;base64,' + storRider,
     rider.ok ? ('længde ' + rider.dataUrl.length) : rider.error);
  const cfgRider = await kald('getConfig', { bandId: A });
  ok('getConfig: hasRiderPdf-flaget sættes, men PDF-en sendes ikke med',
     cfgRider.config.hasRiderPdf === true &&
     JSON.stringify(cfgRider).length < 200000,
     'svarlængde ' + JSON.stringify(cfgRider).length);

  const forStor = await kaldA('adminUploadAsset',
    { kind: 'logo', dataBase64: 'A'.repeat(8000000), filename: 'stor.png' });
  ok('adminUploadAsset: over 5 MB afvises',
     forStor.ok === false && /for stor/i.test(forStor.error), forStor.error);
  const ukendtKind = await kaldA('adminUploadAsset',
    { kind: 'video', dataBase64: lilleLogo });
  ok('adminUploadAsset: ukendt asset-type afvises', ukendtKind.ok === false, ukendtKind.error);

  const sletAsset = await kaldA('adminDeleteAsset', { kind: 'rider' });
  ok('adminDeleteAsset: fjerner asset', sletAsset.ok === true, sletAsset.error);
  ok('adminDeleteAsset: getRider melder at der ingen er',
     (await kaldA('getRider', {})).ok === false);

  // ── bandHealth og migrateAllBands (3j) ──────────────────────────────────
  const health = await kald('bandHealth', { targetBandId: A }, opCreds);
  ok('bandHealth: svarer med tal', health.ok === true &&
     typeof health.health.medlemmer === 'number', health.error);
  ok('bandHealth: rapporterer admins', health.health.admins >= 1, String(health.health.admins));
  ok('bandHealth: rapporterer skemaversion',
     health.health.skemaVersion === BAND_SCHEMA_VERSION,
     health.health.skemaVersion + ' af ' + BAND_SCHEMA_VERSION);
  ok('bandHealth: rapporterer hasCpr uden at afsløre nummeret',
     health.health.hasCpr === true && !JSON.stringify(health).includes('010190'));
  ok('bandHealth: rapporterer EU-jurisdiktion (produktionstjekket)',
     typeof health.health.euJurisdiktion === 'boolean',
     String(health.health.euJurisdiktion));

  const migr = await kald('migrateAllBands', {}, opCreds);
  ok('migrateAllBands: alle bands er på nyeste skema',
     migr.ok === true && migr.ikkeOpdaterede.length === 0 && migr.fejlede.length === 0,
     migr.loeftede.length + ' løftet, ' + migr.ikkeOpdaterede.length + ' bagud');

  const audit = await kald('getAuditLog', { targetBandId: A }, opCreds);
  ok('getAuditLog: operatørens handlinger er logget',
     audit.ok === true && audit.entries.length >= 3,
     (audit.entries || []).length + ' poster');

  const backup = await kald('backupBand', { targetBandId: A }, opCreds);
  ok('backupBand: dumper bandets data', backup.ok === true && backup.data.settings &&
     Array.isArray(backup.data.members), backup.error);
  ok('backupBand: indeholder IKKE password-hashes',
     !/passwordHash|pwSalt|password_hash|pw_salt/i.test(JSON.stringify(backup)));

  // ── Kryds-band (3k) ─────────────────────────────────────────────────────
  // Kun band A har crossBand slået til indtil nu.
  const iMorgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const [bid, cid, navn] of [[A, 'X-A1', 'Værket'], [B, 'X-B1', 'Train']]) {
    const stub = bandStub(env, bid);
    const m = await stub.findMemberByEmail(MUSIKER);
    await stub.clearLoginAttempts(MUSIKER);
    const lg = await runAction(env, 'login',
      { bandId: bid, email: MUSIKER, passwordHash: await sha256hex(nyA.seedPassword) });
    await runAction(env, 'saveContract', {
      bandId: bid,
      contract: {
        id: cid, type: 'Spillested', status: 'godkendt',
        venue: { name: navn, city: 'Vejle' }, date: iMorgen, honorar: 10000,
        memberNote: 'HEMMELIG-NOTE-' + bid
      },
      attendees: [{ memberId: m.id, share: 5000 }]
    }, { email: MUSIKER, token: lg.memberToken });
  }

  await bandA.clearLoginAttempts(MUSIKER);
  const krydsLogin = await runAction(env, 'login',
    { bandId: A, email: MUSIKER, passwordHash: await sha256hex(nyA.seedPassword) });
  const krydsCreds = { email: MUSIKER, token: krydsLogin.memberToken };

  const kunEt = await kald('getAllJobs', {}, krydsCreds);
  ok('getAllJobs: tæller KUN bands hvor crossBand er slået til',
     kunEt.ok === true && kunEt.bandCount === 1 && kunEt.jobs.length === 1,
     kunEt.bandCount + ' bands, ' + (kunEt.jobs || []).length + ' jobs');

  await kald('updateTenant', { targetBandId: B, crossBand: true }, opCreds);
  const begge = await kald('getAllJobs', {}, krydsCreds);
  ok('getAllJobs: begge bands med når flaget slås til',
     begge.bandCount === 2 && begge.jobs.length === 2,
     begge.bandCount + ' bands, ' + begge.jobs.length + ' jobs');
  ok('getAllJobs: hvert job er mærket med sit band',
     begge.jobs.every(j => j.bandId && j.bandName && j.bandColor),
     begge.jobs.map(j => j.bandId).join(', '));
  ok('getAllJobs: jobs sorteret på dato på tværs af bands',
     new Date(begge.jobs[0].date) <= new Date(begge.jobs[1].date));

  const honorarKryds = await kald('getAllHonorar', {}, krydsCreds);
  ok('getAllHonorar: summerer på tværs af bands',
     honorarKryds.ok === true && honorarKryds.total === 10000,
     String(honorarKryds.total));

  const udenIdentitet = await kald('getAllJobs', {},
    { email: 'ingen-identitet@test.dk', token: krydsLogin.memberToken });
  ok('gate: ukendt identitet kan ikke udløse fan-out', udenIdentitet.ok === false,
     udenIdentitet.error);

  // ── iCal-feed ───────────────────────────────────────────────────────────
  const feed = await kaldA('getFeedUrl', {});
  ok('getFeedUrl: giver et token', feed.ok === true && feed.token.length > 20, feed.error);

  const ics = await buildIcal(env, A, feed.token);
  ok('iCal: indeholder kalenderhoved og en gig',
     ics.includes('BEGIN:VCALENDAR') && ics.includes('BEGIN:VEVENT') &&
     ics.includes('SUMMARY:Værket'), ics.slice(0, 60));
  ok('iCal: memberNote lækkes IKKE i feedet',
     !ics.includes('HEMMELIG-NOTE'), 'feedet er ' + ics.length + ' tegn');

  const forkertToken = await buildIcal(env, A, 'forkert-token-her');
  ok('iCal: forkert token giver TOMT feed, ikke en fejl',
     forkertToken.includes('BEGIN:VCALENDAR') && !forkertToken.includes('BEGIN:VEVENT'),
     forkertToken.replace(/\r\n/g, ' | '));
  const utenToken = await buildIcal(env, A, '');
  ok('iCal: manglende token giver tomt feed', !utenToken.includes('BEGIN:VEVENT'));
  const ukendtBand = await buildIcal(env, 'findes-ikke-band', feed.token);
  ok('iCal: ukendt band giver tomt feed', !ukendtBand.includes('BEGIN:VEVENT'));

  const nytToken = await kaldA('rotateFeedToken', {});
  ok('rotateFeedToken: giver et nyt token',
     nytToken.ok === true && nytToken.token !== feed.token, nytToken.error);
  const gammeltEfterRotation = await buildIcal(env, A, feed.token);
  ok('rotateFeedToken: det gamle token virker ikke længere',
     !gammeltEfterRotation.includes('BEGIN:VEVENT'));
  ok('rotateFeedToken: det nye token virker',
     (await buildIcal(env, A, nytToken.token)).includes('BEGIN:VEVENT'));

  // ── deleteTenant kræver bekræftelse ─────────────────────────────────────
  const utenConfirm = await kald('deleteTenant', { targetBandId: B }, opCreds);
  ok('deleteTenant: kræver bekræftelse med band-id',
     utenConfirm.ok === false && /confirm/i.test(utenConfirm.error), utenConfirm.error);
  const forkertConfirm = await kald('deleteTenant',
    { targetBandId: B, confirm: 'noget-andet' }, opCreds);
  ok('deleteTenant: forkert bekræftelse afvises', forkertConfirm.ok === false);

  const slettet = await kald('deleteTenant', { targetBandId: B, confirm: B }, opCreds);
  ok('deleteTenant: sletter bandet', slettet.ok === true, slettet.error);
  ok('deleteTenant: bandet er væk fra registret', (await master.getBand(B)) === null);
  const efterSlet = await bandStub(env, B).status();
  ok('deleteTenant: objektets data er ryddet',
     efterSlet.counts.members === 0 && efterSlet.counts.contracts === 0,
     JSON.stringify(efterSlet.counts));
}
