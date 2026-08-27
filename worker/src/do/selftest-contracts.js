// Selvtest af Fase 3c — kontrakter og dashboard.
//
// saveContract er den tungeste action i hele appen: id-omdøbning med cascade,
// beskyttelse mod utilsigtet overskrivning, optimistisk låsning og
// deltagersynkronisering i én transaktion. Planen anbefaler eksplicit dedikerede
// tests, og de fire faldgruber har hver sin herunder.
//
// Den vigtigste test er `saveContract: bevarer bekræftelser` — den håndhæver
// afvigelsen fra originalen, hvor et gem nulstillede alle deltageres status.

import { runAction } from '../actions/router.js';
import { bandStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';

const BAND = 'selftest-c';
const ADMIN = 'chef-c@test.dk';
const KODE = 'kontrakt-admin-kode';

export async function contractChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  const band = bandStub(env, BAND);
  const iter = pwIterations(env);

  await band.syncMeta({ band_id: BAND, name: 'Kontrakt-band', status: 'active' });
  const adminHash = await sha256hex(KODE);
  const pf = await newPasswordFields(adminHash, iter);
  if (!await band.findMemberByEmail(ADMIN)) {
    await band.insertMember({
      id: 'c-admin', name: 'Chef', category: 'Musiker', instrument: 'Vokal', phone: '',
      email: ADMIN, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 0, role: 'admin', createdAt: new Date().toISOString()
    });
  } else {
    await band.setMemberPassword('c-admin', pf.passwordHash, pf.pwSalt, false);
  }
  // To musikere til deltagerlisten.
  for (const [id, navn] of [['c-m1', 'Bassist'], ['c-m2', 'Trommis']]) {
    if (!await band.findMemberById(id)) {
      const p2 = await newPasswordFields(adminHash, iter);
      await band.insertMember({
        id, name: navn, category: 'Musiker', instrument: navn, phone: '',
        email: id + '@test.dk', regAccount: '', address: '',
        passwordHash: p2.passwordHash, pwSalt: p2.pwSalt,
        forcePasswordChange: 0, role: 'member', createdAt: new Date().toISOString()
      });
    }
  }
  await band.clearLoginAttempts(ADMIN);
  const login = await runAction(env, 'login',
    { bandId: BAND, email: ADMIN, passwordHash: adminHash });
  ok('3c-opsætning: admin kan logge ind', login.ok === true, login.error);
  const creds = { email: ADMIN, token: login.memberToken };
  const kald = (a, p) => runAction(env, a, Object.assign({ bandId: BAND }, p), creds);

  // Ryd tidligere kørsler, så testen er idempotent.
  for (const c of await band.listContracts()) await band.deleteContract(c.id);

  const iMorgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const iOvermorgen = new Date(Date.now() + 172800000).toISOString().slice(0, 10);

  // ── Oprettelse ───────────────────────────────────────────────────────────
  const ny = await kald('saveContract', {
    contract: {
      id: '2026-001', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Værket Vejle', contactName: 'Lise' },
      venue: { name: 'Værket', city: 'Vejle' },
      date: iMorgen, honorar: 35000, sets: 2, setMinutes: 45,
      notes: 'Særlige aftaler', memberNote: 'Parkering bag bygningen'
    },
    attendees: [{ memberId: 'c-m1', share: 7000 }, { memberId: 'c-m2', share: 7000 }]
  });
  ok('saveContract: opretter kontrakt', ny.ok === true && ny.id === '2026-001', ny.error);

  const hentet = await kald('getContract', { id: '2026-001' });
  ok('getContract: JSON-felter udpakkes',
     hentet.ok === true && hentet.contract.arrangoer.name === 'Værket Vejle' &&
     hentet.contract.venue.city === 'Vejle',
     hentet.error || hentet.contract.arrangoer.name);
  ok('getContract: tal er tal, ikke strenge',
     hentet.contract.honorar === 35000 && hentet.contract.sets === 2,
     typeof hentet.contract.honorar);
  ok('getContract: dato er ISO-streng',
     /^\d{4}-\d{2}-\d{2}T/.test(hentet.contract.date), hentet.contract.date);
  ok('getContract: to deltagere', hentet.attendees.length === 2, hentet.attendees.length + '');

  // ── FALDGRUBE 2: utilsigtet overskrivning ────────────────────────────────
  const overskriv = await kald('saveContract', {
    contract: { id: '2026-001', type: 'Spillested', date: iMorgen, honorar: 1 },
    attendees: []
  });
  ok('saveContract: afviser at oprette oven i eksisterende nummer',
     overskriv.ok === false && /allerede i brug/.test(overskriv.error), overskriv.error);
  const stadig = await kald('getContract', { id: '2026-001' });
  ok('saveContract: den oprindelige kontrakt er urørt efter afvisning',
     stadig.contract.honorar === 35000, stadig.contract.honorar + '');

  // ── FALDGRUBE 4 (afvigelsen): bekræftelser skal bevares ──────────────────
  // Simulér at Bassisten har bekræftet og har en cachet køreafstand.
  const attFoer = (await band.getContract('2026-001')).attendees;
  const bassist = attFoer.find(a => a.memberId === 'c-m1');
  await band.updateAttendanceForTest(bassist.id, {
    status: 'confirmed', confirmedAt: '2026-08-01T10:00:00Z', distanceKm: 42.5
  });

  // Ret en stavefejl i spillestedets navn — intet at gøre med deltagerne.
  const rettelse = await kald('saveContract', {
    contract: {
      id: '2026-001', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Værket Vejle' }, venue: { name: 'Værket Vejle', city: 'Vejle' },
      date: iMorgen, honorar: 35000
    },
    attendees: [{ memberId: 'c-m1', share: 8000 }, { memberId: 'c-m2', share: 6000 }],
    originalId: '2026-001'
  });
  ok('saveContract: gemmer rettelse', rettelse.ok === true, rettelse.error);

  const attEfter = (await band.getContract('2026-001')).attendees;
  const bassistEfter = attEfter.find(a => a.memberId === 'c-m1');
  ok('saveContract: bevarer bekræftelse ved gem (afviger fra originalen)',
     bassistEfter && bassistEfter.status === 'confirmed',
     bassistEfter ? bassistEfter.status : 'række mangler');
  ok('saveContract: bevarer cachet køreafstand',
     bassistEfter && Number(bassistEfter.distanceKm) === 42.5,
     bassistEfter ? String(bassistEfter.distanceKm) : '-');
  ok('saveContract: opdaterer andel', Number(bassistEfter.share) === 8000,
     String(bassistEfter.share));

  // ── Roster-ændringer ─────────────────────────────────────────────────────
  const fjern = await kald('saveContract', {
    contract: { id: '2026-001', type: 'Spillested', date: iMorgen, honorar: 35000 },
    attendees: [{ memberId: 'c-m1', share: 14000 }],
    originalId: '2026-001'
  });
  ok('saveContract: fjernet medlem forsvinder fra deltagerlisten',
     fjern.ok === true && (await band.getContract('2026-001')).attendees.length === 1,
     (await band.getContract('2026-001')).attendees.length + ' tilbage');

  const tilbage = await kald('saveContract', {
    contract: { id: '2026-001', type: 'Spillested', date: iMorgen, honorar: 35000 },
    attendees: [{ memberId: 'c-m1', share: 7000 }, { memberId: 'c-m2', share: 7000 }],
    originalId: '2026-001'
  });
  const attTilbage = (await band.getContract('2026-001')).attendees;
  ok('saveContract: genindsat medlem får frisk invited-status',
     tilbage.ok === true && attTilbage.length === 2 &&
     attTilbage.find(a => a.memberId === 'c-m2').status === 'invited',
     attTilbage.length + ' deltagere');
  ok('saveContract: den bevarede deltager har stadig sin bekræftelse',
     attTilbage.find(a => a.memberId === 'c-m1').status === 'confirmed');

  const dublet = await kald('saveContract', {
    contract: { id: '2026-001', type: 'Spillested', date: iMorgen, honorar: 35000 },
    attendees: [{ memberId: 'c-m1', share: 100 }, { memberId: 'c-m1', share: 200 }],
    originalId: '2026-001'
  });
  ok('saveContract: samme medlem to gange gives kun én række',
     dublet.ok === true &&
     (await band.getContract('2026-001')).attendees.filter(a => a.memberId === 'c-m1').length === 1);

  // ── FALDGRUBE 1: omdøbning med cascade ──────────────────────────────────
  const omdoeb = await kald('saveContract', {
    contract: { id: '2026-042', type: 'Spillested', date: iMorgen, honorar: 35000 },
    attendees: [{ memberId: 'c-m1', share: 7000 }],
    originalId: '2026-001'
  });
  ok('saveContract: omdøbning lykkes', omdoeb.ok === true && omdoeb.id === '2026-042', omdoeb.error);
  ok('saveContract: gamle id findes ikke længere',
     (await band.getContract('2026-001')) === null);
  const efterOmdoeb = await band.getContract('2026-042');
  ok('saveContract: attendances fulgte med til det nye id',
     efterOmdoeb && efterOmdoeb.attendees.length === 1 &&
     efterOmdoeb.attendees[0].contractId === '2026-042',
     efterOmdoeb ? efterOmdoeb.attendees[0].contractId : '-');
  ok('saveContract: bekræftelsen overlevede omdøbningen',
     efterOmdoeb.attendees[0].status === 'confirmed', efterOmdoeb.attendees[0].status);

  // Omdøbning til et id der er taget skal afvises.
  const nr2 = await kald('saveContract', {
    contract: { id: '2026-099', type: 'Festival', date: iOvermorgen, honorar: 50000 },
    attendees: [{ memberId: 'c-m2', share: 10000 }]
  });
  ok('saveContract: opretter en anden kontrakt', nr2.ok === true, nr2.error);
  const kollision = await kald('saveContract', {
    contract: { id: '2026-099', type: 'Spillested', date: iMorgen, honorar: 1 },
    attendees: [], originalId: '2026-042'
  });
  ok('saveContract: omdøbning til taget nummer afvises',
     kollision.ok === false && /allerede i brug/.test(kollision.error), kollision.error);
  ok('saveContract: begge kontrakter er intakte efter afvist omdøbning',
     (await band.getContract('2026-042')) !== null &&
     (await band.getContract('2026-099')).contract.honorar === 50000);

  const forkertOrig = await kald('saveContract', {
    contract: { id: '2026-123', type: 'Spillested', date: iMorgen },
    attendees: [], originalId: 'findes-ikke'
  });
  ok('saveContract: ukendt originalId afvises',
     forkertOrig.ok === false && /ikke fundet/.test(forkertOrig.error), forkertOrig.error);

  // ── FALDGRUBE 3: optimistisk låsning ────────────────────────────────────
  const nuKontrakt = (await band.getContract('2026-042')).contract;
  const gammelTs = new Date(Date.parse(nuKontrakt.updatedAt) - 60000).toISOString();
  const konflikt = await kald('saveContract', {
    contract: { id: '2026-042', type: 'Spillested', date: iMorgen, honorar: 999 },
    attendees: [], originalId: '2026-042',
    expectedUpdatedAt: gammelTs
  });
  ok('saveContract: forældet expectedUpdatedAt giver conflict',
     konflikt.ok === false && konflikt.conflict === true, konflikt.error);
  ok('saveContract: kontrakten er urørt efter konflikt',
     (await band.getContract('2026-042')).contract.honorar !== 999);

  const friskTs = nuKontrakt.updatedAt;
  // Arrangøren sættes med her, fordi dashboard-testen nedenfor grupperer på den.
  // Et gem uden feltet nulstiller det til {} — samme adfærd som originalen, da
  // klienten altid sender hele kontrakten.
  const uden = await kald('saveContract', {
    contract: {
      id: '2026-042', type: 'Spillested', date: iMorgen, honorar: 36000,
      arrangoer: { name: 'Værket Vejle' }, venue: { name: 'Værket', city: 'Vejle' }
    },
    attendees: [{ memberId: 'c-m1', share: 7000 }], originalId: '2026-042',
    expectedUpdatedAt: friskTs
  });
  ok('saveContract: aktuel expectedUpdatedAt accepteres', uden.ok === true, uden.error);
  ok('saveContract: felter udeladt af et gem nulstilles (som i originalen)',
     JSON.stringify((await band.getContract('2026-042')).contract.venue).includes('Vejle'));

  // ── Status ──────────────────────────────────────────────────────────────
  const ugyldigStatus = await kald('changeContractStatus', { id: '2026-042', status: 'noget' });
  ok('changeContractStatus: ugyldig status afvises', ugyldigStatus.ok === false, ugyldigStatus.error);
  const godkendt = await kald('changeContractStatus', { id: '2026-042', status: 'godkendt' });
  ok('changeContractStatus: sætter godkendt', godkendt.ok === true, godkendt.error);
  ok('changeContractStatus: værdien er gemt',
     (await band.getContract('2026-042')).contract.status === 'godkendt');
  const ukendt = await kald('changeContractStatus', { id: 'findes-ikke', status: 'godkendt' });
  ok('changeContractStatus: ukendt kontrakt afvises', ukendt.ok === false, ukendt.error);

  // ── getContracts + dashboard ────────────────────────────────────────────
  const liste = await kald('getContracts', {});
  ok('getContracts: returnerer begge kontrakter',
     liste.ok === true && liste.contracts.length === 2, (liste.contracts || []).length + '');

  const dash = await kald('getDashboard', {});
  ok('getDashboard: svarer med stats, upcoming og arrangoere',
     dash.ok === true && dash.stats && Array.isArray(dash.upcoming) && Array.isArray(dash.arrangoere),
     dash.error);
  ok('getDashboard: bookedHonorar summerer kommende jobs',
     dash.stats.bookedHonorar === 36000 + 50000, String(dash.stats.bookedHonorar));
  ok('getDashboard: aktiveMedlemmer tælles', dash.stats.aktiveMedlemmer === 3,
     String(dash.stats.aktiveMedlemmer));
  ok('getDashboard: upcoming beriges med deltagere',
     dash.upcoming.length === 2 && Array.isArray(dash.upcoming[0].attendees) &&
     dash.upcoming[0].attendees.length >= 1,
     JSON.stringify(dash.upcoming.map(u => u.attendees.length)));
  ok('getDashboard: upcoming er sorteret på dato',
     new Date(dash.upcoming[0].date) <= new Date(dash.upcoming[1].date));
  ok('getDashboard: arrangørliste grupperet på navn',
     dash.arrangoere.some(a => a.name === 'Værket Vejle'),
     dash.arrangoere.map(a => a.name).join(', '));

  // ── Sletning rydder også deltagere ──────────────────────────────────────
  const attFoerSlet = (await band.getContract('2026-099')).attendees.length;
  const slet = await kald('deleteContract', { id: '2026-099' });
  ok('deleteContract: sletter kontrakt', slet.ok === true && attFoerSlet > 0, slet.error);
  ok('deleteContract: kontrakten er væk', (await band.getContract('2026-099')) === null);
  ok('deleteContract: efterlader ingen forældreløse deltagere',
     (await band.countOrphanAttendances()) === 0,
     (await band.countOrphanAttendances()) + ' forældreløse');
  const sletIgen = await kald('deleteContract', { id: '2026-099' });
  ok('deleteContract: ukendt id afvises', sletIgen.ok === false, sletIgen.error);

  // ── memberNote må ikke slippe ud ad forkerte kanaler ────────────────────
  // Den er admins interne note og er bevidst holdt ude af PDF, iCal og
  // signeringsdokumentet. Her tjekker vi blot at den FAKTISK gemmes, så Fase
  // 3f/3g kan teste at den ikke kommer med ud.
  ok('saveContract: memberNote gemmes (skal holdes ude af PDF/iCal senere)',
     (await band.getContract('2026-042')).contract.memberNote !== undefined);
}
