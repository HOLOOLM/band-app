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

  // Kaldt med FRONTENDENS parameternavn, ikke implementeringens.
  //
  // bandHealth og backupBand læste kun `targetBandId`, mens operatør-panelet
  // sender `bandId` (09-boot.js:286 og :929). Bandlisten svarede derfor
  // "Kunne ikke hente status" for hvert eneste band. Testene fangede intet,
  // fordi de kaldte med targetBandId — det navn implementeringen selv bruger.
  const helbred = await kald('bandHealth', { bandId: A }, opCreds);
  ok('bandHealth: virker med frontendens parameternavn (bandId)',
     helbred.ok === true && helbred.health && helbred.health.bandId === A,
     helbred.error || ('bandId: ' + (helbred.health || {}).bandId));

  const helbred2 = await kald('bandHealth', { targetBandId: A }, opCreds);
  ok('bandHealth: virker stadig med targetBandId', helbred2.ok === true,
     helbred2.error);

  // ── Import fra prototypen ────────────────────────────────────────────────
  // Eget band. Kørte importen mod A, ville prototypens `m1` overskrive den
  // admin registerTenant lige har oprettet dér — netop den kollision værnet
  // nedenfor findes for. Testen skal afprøve importen, ikke demonstrere den.
  const IMP = 'selftest-import';
  try { await bandStub(env, IMP).wipe(); } catch (e) {}
  await master.deleteBand(IMP, 'selftest', 'oprydning');
  const nyImp = await kald('registerTenant', { bandId: IMP, bandName: 'Import-band' }, opCreds);
  ok('import: tomt band oprettet til importen', nyImp.ok === true, nyImp.error);

  const PROTO = {
    Members: [
      { id: 'm1', name: 'Jesper', email: 'JESPER@Dmdt.dk', role: 'admin',
        phone: '60 24 60 60', cpr: '010190-1234', passwordHash: 'gammel-hash' },
      { id: 'm2', name: 'Henning', email: 'henning@dmdt.dk', role: 'member' }
    ],
    Contracts: [
      { id: 'c12', type: 'Spillested', status: 'godkendt', date: '2026-06-13T00:00:00.000Z',
        honorar: 35000, venue: '{"name":"Vaerket"}', arrangoer: '{"name":"Vaerket Vejle"}' }
    ],
    Attendances: [
      { id: 'a7_0', contractId: 'c12', memberId: 'm1', share: 17500, status: 'confirmed' }
    ],
    Invoices: [
      { id: 'inv5', contractId: 'c12', invoiceNr: '2026-004', date: '2026-06-20',
        amount: 35000, status: 'betalt', driveFileId: 'gammelDrive1' }
    ],
    DistanceCache: [
      { key: 'oksboel|vejle', origin: 'Oksboel', destination: 'Vejle', km: 92 }
    ]
  };

  const imp = await kald('importBandData', { bandId: IMP, data: PROTO }, opCreds);
  ok('import: skriver alle fem tabeller', imp.ok === true &&
     imp.importeret.members === 2 && imp.importeret.contracts === 1 &&
     imp.importeret.attendances === 1 && imp.importeret.invoices === 1 &&
     imp.importeret.distanceCache === 1,
     imp.error || JSON.stringify(imp.importeret));

  ok('import: udleverer en startkode pr. medlem',
     Array.isArray(imp.startkoder) && imp.startkoder.length === 2 &&
     imp.startkoder.every(k => k.startkode && k.startkode.length >= 12),
     (imp.startkoder || []).length + ' koder');

  // Prototypens hash er en anden generation og må ALDRIG overleve importen.
  const impBand = bandStub(env, IMP);
  const m1 = await impBand.findMemberById('m1');
  ok('import: prototypens gamle hash er væk',
     m1 && m1.passwordHash !== 'gammel-hash' && /^pbkdf2\$/.test(String(m1.passwordHash)),
     m1 ? String(m1.passwordHash).slice(0, 12) : 'medlem mangler');
  ok('import: tvinger kodeskift ved første login',
     m1 && Number(m1.forcePasswordChange) === 1);
  ok('import: e-mail normaliseres til små bogstaver',
     m1 && m1.email === 'jesper@dmdt.dk', m1 ? m1.email : '-');

  // CPR pr. medlem findes ikke i den nye model og må ikke smugles ind.
  ok('import: CPR fra prototypen skrives INGEN steder',
     !JSON.stringify(await impBand.exportAll()).includes('010190'));

  // Tællerne skal forbi de importerede id-numre, ellers uddeler næste
  // kontraktoprettelse c1..c12 igen og overskriver importerede rækker.
  ok('import: løfter tællerne forbi importerede id-numre',
     imp.taellere && imp.taellere.contract >= 12 && imp.taellere.invoice >= 5,
     JSON.stringify(imp.taellere));

  const nyKontrakt = await impBand.saveContract(
    { type: 'Spillested', date: '2026-09-01', honorar: 1000 }, []);
  ok('import: næste nye kontrakt kolliderer ikke med en importeret',
     nyKontrakt.ok === true && nyKontrakt.id !== 'c12',
     nyKontrakt.id || nyKontrakt.error);

  // Samme fil igen må ikke duplikere. Kræver overskriv: true, fordi bandet nu
  // HAR medlemmer — og det er netop scenariet flaget findes til: en import der
  // fejlede halvvejs skal kunne køres om.
  const imp2 = await kald('importBandData',
    { bandId: IMP, data: PROTO, overskriv: true }, opCreds);
  const efter = await impBand.exportAll();
  ok('import: er idempotent — samme fil to gange giver ikke dubletter',
     imp2.ok === true &&
     efter.contracts.filter(c => c.id === 'c12').length === 1 &&
     efter.invoices.filter(i => i.id === 'inv5').length === 1,
     efter.contracts.length + ' kontrakter, ' + efter.invoices.length + ' fakturaer');

  // Fakturanummeret udledes af rækkerne, så et importeret 2026-004 skal
  // reserveres og ikke uddeles igen.
  const nyFaktura = await impBand.createInvoice(nyKontrakt.id);
  ok('import: nyt fakturanummer genbruger ikke et importeret',
     nyFaktura.ok === true && nyFaktura.invoice.invoiceNr !== '2026-004',
     nyFaktura.ok ? nyFaktura.invoice.invoiceNr : nyFaktura.error);

  // Værnet: A har allerede en admin på m1. En import dertil ville overskrive
  // vedkommende, og det skal kræve et bevidst valg.
  const vaernet = await kald('importBandData', { bandId: A, data: PROTO }, opCreds);
  ok('import: afviser et band der allerede har medlemmer',
     vaernet.ok === false && /allerede/.test(String(vaernet.error || '')),
     vaernet.error);

  // ── Operatøren udpeger en administrator ─────────────────────────────────
  //
  // Præcis scenariet actionen findes til: IMP blev oprettet med Jesper på
  // pladsholderen jesper@dmdt.dk. Rollen skal kunne flyttes til den rigtige
  // konto UDEN at nogen logger ind som pladsholderen.
  const medlemsListe = await kald('operatorListMembers', { bandId: IMP }, opCreds);
  ok('operatorListMembers: viser bandets medlemmer med rolle',
     medlemsListe.ok === true && medlemsListe.members.length === 2 &&
     medlemsListe.members.some(m => m.email === 'jesper@dmdt.dk' && m.role === 'admin'),
     JSON.stringify((medlemsListe.members || []).map(m => m.email + ':' + m.role)));
  // Operatøren skal kunne udpege en admin, ikke læse bandets persondata.
  // m1 har telefon 60 24 60 60 i fikstureringen, så fraværet er et rigtigt bevis.
  ok('operatorListMembers: lækker ikke telefon, adresse eller kontonummer',
     !JSON.stringify(medlemsListe).includes('60 24 60 60'));

  const forfrem = await kald('operatorSetMemberRole',
    { bandId: IMP, memberId: 'm2', role: 'admin' }, opCreds);
  ok('operatorSetMemberRole: udpeger et medlem som administrator',
     forfrem.ok === true, forfrem.error);
  ok('operatorSetMemberRole: rollen er faktisk skrevet',
     (await impBand.findMemberById('m2')).role === 'admin');

  const fjern = await kald('operatorSetMemberRole',
    { bandId: IMP, memberEmail: 'jesper@dmdt.dk', role: 'member' }, opCreds);
  ok('operatorSetMemberRole: fjerner rollen fra pladsholderen (også via e-mail)',
     fjern.ok === true && (await impBand.findMemberById('m1')).role === 'member',
     fjern.error);

  // Blindgyden: uden administrator kan bandet ikke administreres af NOGEN, og
  // kun denne action kunne rette op på det.
  const sidsteAdmin = await kald('operatorSetMemberRole',
    { bandId: IMP, memberId: 'm2', role: 'member' }, opCreds);
  ok('operatorSetMemberRole: nægter at fjerne den sidste administrator',
     sidsteAdmin.ok === false && /uden administrator/i.test(String(sidsteAdmin.error || '')),
     sidsteAdmin.error);
  ok('operatorSetMemberRole: bandet har stadig en administrator',
     (await impBand.findMemberById('m2')).role === 'admin');

  const ukendtRolle = await kald('operatorSetMemberRole',
    { bandId: IMP, memberId: 'm2', role: 'superbruger' }, opCreds);
  ok('operatorSetMemberRole: afviser en ukendt rolle', ukendtRolle.ok === false,
     ukendtRolle.error);

  // Gaten på de to actions ligger længere nede, hvor band-admin-legitimationen
  // (kaldA) er dannet — den findes først på det tidspunkt.

  const backupFe = await kald('backupBand', { bandId: A }, opCreds);
  ok('backupBand: virker med frontendens parameternavn (bandId)',
     backupFe.ok === true && backupFe.bandId === A, backupFe.error);

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

  // Tjekkene herunder læser med OPERATØR-PANELETS feltnavne, ikke med DO'ens
  // egne. Tjekkene ovenfor er grønne på `medlemmer` og har derfor aldrig
  // opdaget at 09-boot.js:298 læser `members` — kortet skrev `undefined
  // medlemmer`, og hvert opsætnings-badge viste "mangler" for alle bands.
  // Et grønt tjek beviser kun det det faktisk kigger på.
  const hp = health.health;
  ok('bandHealth: leverer panelets `members` (ikke kun `medlemmer`)',
     typeof hp.members === 'number' && hp.members === hp.medlemmer,
     JSON.stringify({ members: hp.members, medlemmer: hp.medlemmer }));
  ok('bandHealth: leverer panelets `nextGig`',
     typeof hp.nextGig === 'string' && hp.nextGig === hp.naesteGig,
     JSON.stringify({ nextGig: hp.nextGig, naesteGig: hp.naesteGig }));
  ok('bandHealth: leverer opsætnings-flagene panelet tegner badges ud fra',
     typeof hp.hasLogo === 'boolean' && typeof hp.hasRider === 'boolean' &&
     typeof hp.hasBank === 'boolean' && typeof hp.hasCpr === 'boolean',
     JSON.stringify({ hasLogo: hp.hasLogo, hasRider: hp.hasRider,
                      hasBank: hp.hasBank, hasCpr: hp.hasCpr }));
  // Rider-asset'et blev slettet lige ovenfor (:411), og bandet har ingen
  // riderText. hasRider skal derfor være FALSK — og præcis lige så falsk som
  // getRider er fejlende. Kobles de to ikke sammen, kan badge'et og den
  // faktiske rider skride fra hinanden uden at nogen opdager det.
  ok('bandHealth: hasRider følger getRider — begge nej når der ingen rider er',
     hp.hasRider === false && (await kaldA('getRider', {})).ok === false,
     'hasRider=' + hp.hasRider);
  // hasBank er sand her, fordi bankKto blev sat ved faktureringstjekket (:351).
  ok('bandHealth: hasBank er sand når bankKto er udfyldt',
     hp.hasBank === true, 'bankKto blev sat til 1465171 ved :351');
  ok('bandHealth: leverer `warnings` som panelet læser advarsler fra',
     !!hp.warnings && hp.warnings.noAdmin === false &&
     typeof hp.warnings.orphanAttendances === 'number' &&
     typeof hp.warnings.overdueInvoices === 'number',
     JSON.stringify(hp.warnings));

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

  // ── Rolleændring er operatørens, ikke bandets ───────────────────────────
  // En band-admin må ikke kunne forfremme nogen — heller ikke i sit eget band.
  // Kunne de det, ville "admin" være en rolle der kan sprede sig selv.
  const admForsoeg = await kaldA('operatorSetMemberRole',
    { bandId: A, memberId: 'm1', role: 'admin' });
  ok('operatorSetMemberRole: en band-admin kan IKKE ændre roller',
     admForsoeg.ok === false, admForsoeg.error);
  const admListe = await kaldA('operatorListMembers', { bandId: A });
  ok('operatorListMembers: kræver operatør-adgang',
     admListe.ok === false, admListe.error);

  // ── Kun operatøren må slette et band ────────────────────────────────────
  //
  // `adminDeleteBand` (scope: 'band', auth: 'admin') lod bandets EGEN admin
  // slette alt permanent — database, fakturaarkiv, faktureringsoplysninger —
  // med en prompt() som eneste værn. Fjernet 30/8.
  //
  // De to tjek dækker hver sin vej tilbage: at navnet genopstår i
  // action-tabellen, og at deleteTenant får en svagere gate.
  const gammeltNavn = await kaldA('adminDeleteBand', { confirm: A });
  ok('adminDeleteBand: findes ikke længere',
     gammeltNavn.ok === false && /ukendt handling/i.test(gammeltNavn.error),
     gammeltNavn.error);
  const adminForsoeg = await kaldA('deleteTenant', { targetBandId: A, confirm: A });
  ok('deleteTenant: en band-admin kan IKKE slette et band',
     adminForsoeg.ok === false, adminForsoeg.error);
  ok('deleteTenant: bandet står stadig i registret efter admins forsøg',
     (await master.getBand(A)) !== null);

  // ── Point-in-time recovery ──────────────────────────────────────────────
  // Rapporteres uanset udfald: er PITR ikke tilgængelig lokalt, skal det stå
  // i resultatet frem for at gendannelsen ser utestet ud uden forklaring.
  // Metoderne findes lokalt, men lagringen bag dem gør ikke. Derfor prøves
  // der med et rigtigt (læsende) kald frem for at tjekke om funktionen
  // eksisterer — det skel kostede en fejlet testkørsel at opdage.
  const pitrProbe = await bandStub(env, B).pitrProbe();
  ok('pitr: tilgængelighed afgøres med et rigtigt kald, ikke et metode-tjek',
     typeof pitrProbe.ok === 'boolean',
     pitrProbe.ok ? 'virker' : 'virker IKKE her: ' + pitrProbe.error);

  // ── Ugentlig sikkerhedskopi ─────────────────────────────────────────────
  // Tages FØR B slettes nedenfor, så vi bagefter kan bevise at kopien
  // overlever sletningen. Det er hele grunden til at den ikke ligger under
  // bandets egen mappe.
  const bkKoer = await kald('runBackupNow', { bandId: B }, opCreds);
  ok('runBackupNow: tager en kopi af bandet',
     bkKoer.ok === true && bkKoer.kopieret.length === 1 &&
     bkKoer.kopieret[0].bytes > 0,
     bkKoer.error || JSON.stringify(bkKoer.kopieret));

  const bkListe = await kald('listBandBackups', { bandId: B }, opCreds);
  ok('listBandBackups: viser kopien med dato',
     bkListe.ok === true && bkListe.backups.length >= 1 &&
     /^\d{4}-\d{2}-\d{2}$/.test(bkListe.backups[0].dato),
     bkListe.error || JSON.stringify((bkListe.backups || []).map(b => b.dato)));
  ok('listBandBackups: oplyser opbevaringstiden',
     bkListe.opbevaringUger === 8, String(bkListe.opbevaringUger));

  const bkHent = await kald('getBandBackup', { key: bkListe.backups[0].key }, opCreds);
  const bkData = bkHent.ok ? JSON.parse(bkHent.indhold) : null;
  ok('getBandBackup: indholdet er bandets faktiske data',
     bkHent.ok === true && bkData && bkData._band === B &&
     Array.isArray(bkData.data.members),
     bkHent.error);
  // CPR ligger krypteret i MASTER, ikke i bandets objekt, og må derfor ikke
  // kunne dukke op i en kopi der beskrives som CPR-fri.
  ok('getBandBackup: kopien indeholder ikke CPR',
     bkHent.ok === true && !bkHent.indhold.includes('010190'));

  // Nøglen valideres, ikke bare bruges. Uden dette tjek kunne en manipuleret
  // nøgle hente en faktura-PDF — et dokument MED CPR — gennem en rute der
  // lover det modsatte.
  //
  // Filen lægges FØRST. Uden den ville tjekket også bestå hvis nøglen bare
  // ikke fandtes — altså bestå af den uinteressante grund, og bevise
  // ingenting om værnet.
  const snydNoegle = B + '/fakturaer/2026/Faktura-2026-001-inv1.pdf';
  await env.ARCHIVE.put(snydNoegle, 'CPR 010190-1234 i en faktura');
  ok('backup: forudsætningen holder — filen ligger der faktisk',
     (await env.ARCHIVE.get(snydNoegle)) !== null);
  const bkSnyd = await kald('getBandBackup', { key: snydNoegle }, opCreds);
  ok('getBandBackup: nægter en nøgle uden for backup-området, selv når filen findes',
     bkSnyd.ok === false && !JSON.stringify(bkSnyd).includes('010190'),
     bkSnyd.error);

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

  // ── Kopien skal overleve sletningen ─────────────────────────────────────
  //
  // Dette er hele begrundelsen for at kopierne ligger under `_backups/` og
  // ikke under `<bandId>/`. Lå de sidstnævnte sted, ville deleteBandArchive
  // netop have ryddet dem — og en backup der forsvinder sammen med
  // originalen, er ingen backup.
  //
  // Fakturaarkivet SKAL derimod være væk: det indeholder CPR.
  const efterSletListe = await kald('listBandBackups', { bandId: B }, opCreds);
  ok('backup: kopien overlever at bandet slettes',
     efterSletListe.ok === true && efterSletListe.backups.length >= 1,
     efterSletListe.error || (efterSletListe.backups || []).length + ' kopier');
  const genskab = await kald('getBandBackup',
    { key: (efterSletListe.backups || [{}])[0].key }, opCreds);
  ok('backup: data kan stadig læses ud af kopien efter sletningen',
     genskab.ok === true && JSON.parse(genskab.indhold).data.members.length > 0,
     genskab.error);

  // Oprydningen fjerner gamle kopier på tværs af ALLE bands — også slettede,
  // som aldrig får kørt deres egen gren. Plantet med en dato uden for vinduet.
  const gammelNoegle = '_backups/' + B + '/2020-01-01.json';
  await env.ARCHIVE.put(gammelNoegle, JSON.stringify({ _band: B, data: {} }));
  const { pruneBackups } = await import('../services/backup.js');
  const ryddet = await pruneBackups(env);
  ok('backup: oprydningen sletter kopier ældre end otte uger',
     ryddet.slettet >= 1 && (await env.ARCHIVE.get(gammelNoegle)) === null,
     JSON.stringify(ryddet));
  ok('backup: oprydningen beholder de nye',
     (await kald('listBandBackups', { bandId: B }, opCreds)).backups.length >= 1);

  // ── Point-in-time recovery: den fulde rundtur ───────────────────────────
  //
  // Det her er det tjek der betyder noget. Alt andet om PITR kan man læse sig
  // til i Cloudflares dokumentation; dette beviser at DENNE app kan bruge det.
  //
  // Eget band, fordi gendannelsen ruller HELE objektet tilbage. Kørte den mod
  // A eller B, ville alle tidligere tjeks data forsvinde under dem.
  const P = 'selftest-pitr';
  try { await bandStub(env, P).wipe(); } catch (e) {}
  await master.deleteBand(P, 'selftest', 'oprydning');
  await kald('registerTenant', { bandId: P, bandName: 'PITR-band' }, opCreds);
  const pBand = bandStub(env, P);

  // En kontrakt UANSET om rundturen kan køres. Uden den ville tjekket
  // "rører IKKE bandet når den fejler" sammenligne 0 med 0 og bestå selv
  // hvis bandet blev tømt.
  await pBand.saveContract(
    { type: 'Spillested', date: '2026-04-01', honorar: 500, venue: '{"name":"BASIS"}' }, []);

  const pProbe = await pBand.pitrProbe();
  if (!pProbe.ok) {
    // IKKE et grønt tjek der lyver. Rundturen er ikke kørt, og det står der.
    ok('pitr: rundturen er IKKE bevist i denne kørsel', true,
       'oversprunget — ' + pProbe.error + '. Kør mod produktion.');
  } else {
    const foer = await pBand.saveContract(
      { type: 'Spillested', date: '2026-05-01', honorar: 1000, venue: '{"name":"FOER"}' }, []);
    ok('pitr: udgangspunkt oprettet', foer.ok === true, foer.error);

    // Bogmærket tages HER — mellem de to kontrakter. Et tidsbaseret opslag
    // ville være et kapløb i en test der kører på millisekunder.
    const punkt = await pBand.nuvaerendeBogmaerke();
    ok('pitr: kan hente et bogmærke for nuet',
       punkt.ok === true && typeof punkt.bogmaerke === 'string' && punkt.bogmaerke.length > 0,
       punkt.bogmaerke ? String(punkt.bogmaerke).slice(0, 16) + '…' : 'intet');

    const efter = await pBand.saveContract(
      { type: 'Spillested', date: '2026-06-01', honorar: 2000, venue: '{"name":"EFTER"}' }, []);
    ok('pitr: ændringen efter bogmærket er skrevet', efter.ok === true, efter.error);
    ok('pitr: bandet har nu to kontrakter',
       (await pBand.exportAll()).contracts.length === 2);

    // Gendan til punktet mellem de to.
    const plan = await pBand.planlaegGendannelse(punkt.bogmaerke);
    ok('pitr: gendannelsen kan planlægges og giver et fortryd-bogmærke',
       plan.ok === true && typeof plan.fortrydBogmaerke === 'string' &&
       plan.fortrydBogmaerke.length > 0,
       plan.error || String(plan.fortrydBogmaerke).slice(0, 16) + '…');

    // Genstart KUN hvis planen lykkedes. Gjorde vi det ubetinget, ville en
    // fejlet plan alligevel dræbe objektet — og resten af selvtesten med sig.
    // Det kostede en kørsel at opdage: 373 tjek i stedet for 502.
    if (plan.ok) { try { await pBand.genstartNu(); } catch (e) {} }

    const efterGendan = await pBand.exportAll();
    ok('pitr: GENDANNELSEN VIRKER — ændringen efter bogmærket er rullet væk',
       efterGendan.contracts.length === 1 &&
       String(efterGendan.contracts[0].venue).includes('FOER'),
       efterGendan.contracts.length + ' kontrakter: ' +
       efterGendan.contracts.map(c => c.venue).join(', '));

    // Og den vej tilbage. Uden dette ville gendannelsen være enkeltrettet, og
    // et fejlgreb i tidspunktet ville koste alt siden.
    const fortryd = plan.ok
      ? await pBand.planlaegGendannelse(plan.fortrydBogmaerke)
      : { ok: false, error: 'planen fejlede' };
    ok('pitr: fortrydelsen kan planlægges', fortryd.ok === true, fortryd.error);
    if (fortryd.ok) { try { await pBand.genstartNu(); } catch (e) {} }

    const efterFortryd = await pBand.exportAll();
    ok('pitr: FORTRYDELSEN VIRKER — begge kontrakter er tilbage',
       efterFortryd.contracts.length === 2,
       efterFortryd.contracts.length + ' kontrakter');
  }

  // ── Gaten og bekræftelsen på operatør-actionerne ────────────────────────
  const udenConfirm = await kald('restoreBandToTime',
    { bandId: P, tidspunkt: new Date().toISOString() }, opCreds);
  ok('restoreBandToTime: kræver bekræftelse med band-id',
     udenConfirm.ok === false && /confirm/i.test(String(udenConfirm.error || '')),
     udenConfirm.error);

  const udenTidspunkt = await kald('restoreBandToTime',
    { bandId: P, confirm: P }, opCreds);
  ok('restoreBandToTime: kræver et tidspunkt',
     udenTidspunkt.ok === false, udenTidspunkt.error);

  // Med BEGGE felter udfyldt, men uden fungerende PITR: skal fejle rent og
  // IKKE genstarte objektet. Gjorde den det, ville et klik i produktion kunne
  // dræbe et band uden at gendanne noget — det værste af begge verdener.
  const foerForsoeg = (await pBand.exportAll()).contracts.length;
  const utilgaengelig = await kald('restoreBandToTime',
    { bandId: P, confirm: P, tidspunkt: new Date(Date.now() - 3600000).toISOString() }, opCreds);
  if (!pProbe.ok) {
    ok('restoreBandToTime: fejler rent når PITR ikke er tilgængelig',
       utilgaengelig.ok === false && /ikke tilgængelig/i.test(String(utilgaengelig.error || '')),
       utilgaengelig.error);
    ok('restoreBandToTime: rører IKKE bandet når den fejler',
       (await pBand.exportAll()).contracts.length === foerForsoeg,
       foerForsoeg + ' kontrakter før og efter');
  }

  const tilstand = await kald('bandRestoreState', { bandId: P }, opCreds);
  ok('bandRestoreState: rapporterer om PITR er tilgængelig',
     tilstand.ok === true && typeof tilstand.pitr === 'boolean',
     'pitr=' + tilstand.pitr);

  const intetAtFortryde = await kald('undoBandRestore', { bandId: P }, opCreds);
  ok('undoBandRestore: siger fra når der intet er at fortryde',
     intetAtFortryde.ok === false, intetAtFortryde.error);

  const admGendan = await kaldA('restoreBandToTime',
    { bandId: A, confirm: A, tidspunkt: new Date().toISOString() });
  ok('restoreBandToTime: en band-admin kan IKKE gendanne',
     admGendan.ok === false, admGendan.error);
}
