// Selvtest af Fase 3d — jobs og køreafstand.
//
// Den vigtigste test her er `getJobs: læsestien SKRIVER IKKE`. Det er hele
// formålet med gruppen: _ensureDistance (Code.gs:516) beregnede og skrev midt i
// en jobliste, så en læsning tog skrivelåsen. Testen beviser det ved at
// sammenligne databasens ændringstæller før og efter et kald — en påstand om
// "vi skriver ikke" er ellers kun en hensigt.
//
// Sidecaren findes ikke endnu (Fase 4), så Maps-opslag kan ikke lykkes. Det er
// med vilje testet som en FORVENTET tilstand: en manglende afstand skal give en
// tom kolonne og en brugbar fejlbesked, aldrig en væltet jobliste.

import { runAction } from '../actions/router.js';
import { bandStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { wantsReturnHome, normalizeAddr, venueAddress, readCachedDistance } from '../lib/distance.js';

const BAND = 'selftest-d';
const ADMIN = 'chef-d@test.dk';
const MEDLEM = 'musiker-d@test.dk';
const KODE = 'job-test-kode-lang';
const HJEM = 'Frejasvej 65, 6840 Oksbøl';

export async function jobChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  const band = bandStub(env, BAND);
  const iter = pwIterations(env);
  const hash = await sha256hex(KODE);

  await band.syncMeta({ band_id: BAND, name: 'Job-band', status: 'active' });
  for (const [id, email, role] of [['d-a', ADMIN, 'admin'], ['d-m', MEDLEM, 'member']]) {
    const pf = await newPasswordFields(hash, iter);
    if (!await band.findMemberById(id)) {
      await band.insertMember({
        id, name: role === 'admin' ? 'Chef' : 'Musiker', category: 'Musiker',
        instrument: 'Bas', phone: '', email, regAccount: '',
        address: role === 'member' ? HJEM : '',
        passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
        forcePasswordChange: 0, role, createdAt: new Date().toISOString()
      });
    } else {
      await band.setMemberPassword(id, pf.passwordHash, pf.pwSalt, false);
      await band.updateMember(id, { address: role === 'member' ? HJEM : '' });
    }
    await band.clearLoginAttempts(email);
  }

  const adminLogin = await runAction(env, 'login', { bandId: BAND, email: ADMIN, passwordHash: hash });
  const medlemLogin = await runAction(env, 'login', { bandId: BAND, email: MEDLEM, passwordHash: hash });
  ok('3d-opsætning: begge logins virker',
     adminLogin.ok === true && medlemLogin.ok === true,
     adminLogin.error || medlemLogin.error);
  const adminCreds = { email: ADMIN, token: adminLogin.memberToken };
  const medlemCreds = { email: MEDLEM, token: medlemLogin.memberToken };
  const kald = (a, p, c) => runAction(env, a, Object.assign({ bandId: BAND }, p), c);

  // ── Hjælpefunktioner: tur/retur-standard og adresseudtræk ────────────────
  ok('wantsReturnHome: tomt felt betyder JA (tur/retur er standard)',
     wantsReturnHome({ returnHome: '' }) === true &&
     wantsReturnHome({ returnHome: null }) === true &&
     wantsReturnHome({}) === true);
  ok('wantsReturnHome: eksplicit fra respekteres',
     wantsReturnHome({ returnHome: 'false' }) === false &&
     wantsReturnHome({ returnHome: 0 }) === false &&
     wantsReturnHome({ returnHome: false }) === false);
  ok('wantsReturnHome: eksplicit til respekteres',
     wantsReturnHome({ returnHome: 1 }) === true &&
     wantsReturnHome({ returnHome: 'true' }) === true);

  ok('venueAddress: sammensætter adresse, postnr og by',
     venueAddress({ venue: JSON.stringify({ address: 'Havnegade 6', postnr: '7100', city: 'Vejle' }) })
       === 'Havnegade 6, 7100 Vejle');
  ok('venueAddress: tåler korrupt JSON', venueAddress({ venue: '{ ikke json' }) === '');
  ok('venueAddress: tom venue giver tom streng', venueAddress({ venue: '{}' }) === '');
  ok('normalizeAddr: mellemrum og versaler ignoreres',
     normalizeAddr('  Frejasvej   65 ') === normalizeAddr('frejasvej 65'));

  // ── Cache-læsning: hit kræver samme origin OG samme tur/retur ───────────
  const grund = { startAddress: '', distanceKm: 100, distanceOrigin: HJEM, distanceRoundTrip: 1 };
  ok('readCachedDistance: hit ved samme origin og tur/retur',
     readCachedDistance(grund, HJEM).km === 100);
  ok('readCachedDistance: miss når origin er en anden',
     readCachedDistance(grund, 'Anden Vej 1').km === '');
  ok('readCachedDistance: miss når tur/retur-valget er skiftet',
     readCachedDistance(Object.assign({}, grund, { returnHome: 'false' }), HJEM).km === '');

  // ── Opret et godkendt job og et udkast ──────────────────────────────────
  for (const c of await band.listContracts()) await band.deleteContract(c.id);
  const iMorgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  await kald('saveContract', {
    contract: {
      id: 'JOB-1', type: 'Spillested', status: 'godkendt',
      arrangoer: { name: 'Værket' },
      venue: { name: 'Værket', address: 'Havnegade 6', postnr: '7100', city: 'Vejle' },
      date: iMorgen, honorar: 35000,
      memberNote: 'Parkering bag bygningen', notes: 'Særlige aftaler',
      paymentTerms: 'Kontant efter optræden'
    },
    attendees: [{ memberId: 'd-m', share: 7000 }]
  }, adminCreds);

  await kald('saveContract', {
    contract: {
      id: 'JOB-UDKAST', type: 'Spillested', status: 'udkast',
      venue: { name: 'Hemmelig', city: 'Aarhus' }, date: iMorgen, honorar: 1000
    },
    attendees: [{ memberId: 'd-m', share: 500 }]
  }, adminCreds);

  // ── getJobs ─────────────────────────────────────────────────────────────
  const jobs = await kald('getJobs', {}, medlemCreds);
  ok('getJobs: svarer med medlemmets jobs', jobs.ok === true, jobs.error);
  ok('getJobs: viser KUN godkendte kontrakter — ikke udkast',
     jobs.jobs.length === 1 && jobs.jobs[0].contractId === 'JOB-1',
     jobs.jobs.map(j => j.contractId).join(', '));
  ok('getJobs: memberNote er kun et flag i listen, ikke teksten',
     jobs.jobs[0].hasMemberNote === true &&
     !JSON.stringify(jobs.jobs).includes('Parkering bag bygningen'));
  ok('getJobs: honorar for hele kontrakten lækkes ikke i listen',
     !JSON.stringify(jobs.jobs).includes('35000'));
  ok('getJobs: medlemmets egen andel er med', jobs.jobs[0].share === 7000);
  ok('getJobs: tur/retur er som standard slået til', jobs.jobs[0].returnHome === true);
  ok('getJobs: afstand er tom når intet er beregnet', jobs.jobs[0].distanceKm === '',
     JSON.stringify(jobs.jobs[0].distanceKm));

  // ── KERNEN: læsestien må ikke skrive ────────────────────────────────────
  const foer = await band.writeCounter();
  await kald('getJobs', {}, medlemCreds);
  await kald('getJob', { attendanceId: jobs.jobs[0].attendanceId }, medlemCreds);
  await kald('getJobs', {}, medlemCreds);
  const efter = await band.writeCounter();
  ok('getJobs/getJob: læsestien SKRIVER IKKE (afviger fra _ensureDistance)',
     efter === foer, 'ændringer før ' + foer + ', efter ' + efter);

  // ── getJob: hvad medlemmet må se ────────────────────────────────────────
  const detalje = await kald('getJob', { attendanceId: jobs.jobs[0].attendanceId }, medlemCreds);
  ok('getJob: svarer med jobdetalje', detalje.ok === true, detalje.error);
  const jsonDetalje = JSON.stringify(detalje);
  ok('getJob: honorar for hele kontrakten er fjernet',
     detalje.job.contract.honorar === undefined && !jsonDetalje.includes('35000'));
  ok('getJob: arrangørens oplysninger er fjernet',
     detalje.job.contract.arrangoer === undefined);
  ok('getJob: betalingsbetingelser er fjernet',
     detalje.job.contract.paymentTerms === undefined &&
     !jsonDetalje.includes('Kontant efter optræden'));
  ok('getJob: memberNote ER med i detaljen (den er til medlemmet)',
     detalje.job.contract.memberNote === 'Parkering bag bygningen');
  ok('getJob: besætning er med', Array.isArray(detalje.job.besaetning) &&
     detalje.job.besaetning.length === 1, (detalje.job.besaetning || []).length + '');
  ok('getJob: hjemmeadresse med til UI\'et', detalje.job.homeAddress === HJEM);

  // ── Ejerskab: et andet medlems job må ikke kunne hentes ─────────────────
  await kald('saveContract', {
    contract: {
      id: 'JOB-2', type: 'Spillested', status: 'godkendt',
      venue: { name: 'Andet', city: 'Odense' }, date: iMorgen, honorar: 20000
    },
    attendees: [{ memberId: 'd-a', share: 20000 }]
  }, adminCreds);
  const andresAtt = (await band.getContract('JOB-2')).attendees[0];
  const fremmed = await kald('getJob', { attendanceId: andresAtt.id }, medlemCreds);
  ok('getJob: et andet medlems job kan ikke hentes',
     fremmed.ok === false && /ikke fundet/.test(fremmed.error), fremmed.error);
  const fremmedSkriv = await kald('updateJobStartAddress',
    { attendanceId: andresAtt.id, startAddress: 'Kapret Vej 1' }, medlemCreds);
  ok('updateJobStartAddress: kan ikke ændre et andet medlems job',
     fremmedSkriv.ok === false, fremmedSkriv.error);

  // ── Startadresse og tur/retur ───────────────────────────────────────────
  const attId = jobs.jobs[0].attendanceId;
  await band.setAttendanceDistance(attId, 120, HJEM, true);
  const medCache = await kald('getJobs', {}, medlemCreds);
  ok('getJobs: viser cachet afstand når origin og valg matcher',
     medCache.jobs[0].distanceKm === 120, String(medCache.jobs[0].distanceKm));

  const nyStart = await kald('updateJobStartAddress',
    { attendanceId: attId, startAddress: 'Rådhuspladsen 1, 1550 København' }, medlemCreds);
  ok('updateJobStartAddress: gemmer adressen', nyStart.ok === true, nyStart.error);
  const efterStart = await kald('getJobs', {}, medlemCreds);
  ok('updateJobStartAddress: tømmer afstandscachen',
     efterStart.jobs[0].distanceKm === '' &&
     efterStart.jobs[0].startAddress === 'Rådhuspladsen 1, 1550 København',
     String(efterStart.jobs[0].distanceKm));

  await band.setAttendanceDistance(attId, 260, 'Rådhuspladsen 1, 1550 København', true);
  const fra = await kald('updateJobReturnHome', { attendanceId: attId, returnHome: 'false' }, medlemCreds);
  ok('updateJobReturnHome: slår tur/retur fra', fra.ok === true && fra.returnHome === false, fra.error);
  const efterRT = await kald('getJobs', {}, medlemCreds);
  ok('updateJobReturnHome: tømmer cachen så tallet ikke modsiger hakket',
     efterRT.jobs[0].distanceKm === '' && efterRT.jobs[0].returnHome === false,
     String(efterRT.jobs[0].distanceKm));

  // ── updateMyAddress rydder kun de jobs der brugte hjemmeadressen ────────
  // JOB-1 har nu en egen startadresse, så den skal være upåvirket.
  await band.setAttendanceDistance(attId, 300, 'Rådhuspladsen 1, 1550 København', false);
  const adr = await kald('updateMyAddress', { address: 'Ny Vej 7, 8000 Aarhus' }, medlemCreds);
  ok('updateMyAddress: gemmer adressen', adr.ok === true && adr.address === 'Ny Vej 7, 8000 Aarhus',
     adr.error);
  const efterAdr = await band.getMyJob(attId, 'd-m');
  ok('updateMyAddress: job med EGEN startadresse beholder sin afstand',
     Number(efterAdr.attendance.distanceKm) === 300, String(efterAdr.attendance.distanceKm));

  // Og omvendt: et job UDEN egen startadresse skal ryddes.
  await band.setAttendanceStartAddress(attId, 'd-m', '');
  await band.setAttendanceDistance(attId, 300, 'Ny Vej 7, 8000 Aarhus', false);
  const adr2 = await kald('updateMyAddress', { address: 'Tredje Vej 9, 5000 Odense' }, medlemCreds);
  const efterAdr2 = await band.getMyJob(attId, 'd-m');
  ok('updateMyAddress: job UDEN egen startadresse får afstanden ryddet',
     adr2.ok === true && (efterAdr2.attendance.distanceKm === null ||
                          efterAdr2.attendance.distanceKm === ''),
     String(efterAdr2.attendance.distanceKm));

  // ── recalcJobDistance uden sidecar ──────────────────────────────────────
  // Sidecaren findes ikke endnu. Det skal give en brugbar besked, ikke et crash.
  const recalc = await kald('recalcJobDistance', { attendanceId: attId }, medlemCreds);
  ok('recalcJobDistance: fejler pænt når sidecaren ikke er sat op',
     recalc.ok === false && typeof recalc.error === 'string' && recalc.error.length > 0,
     recalc.error);
  ok('recalcJobDistance: joblisten virker stadig bagefter',
     (await kald('getJobs', {}, medlemCreds)).ok === true);

  // Manglende adresse skal fanges før sidecaren overhovedet kaldes.
  await band.updateMember('d-m', { address: '' });
  await band.setAttendanceStartAddress(attId, 'd-m', '');
  const login2 = await runAction(env, 'login', { bandId: BAND, email: MEDLEM, passwordHash: hash });
  const utenAdr = await kald('recalcJobDistance', { attendanceId: attId },
    { email: MEDLEM, token: login2.memberToken });
  ok('recalcJobDistance: beder om adresse når ingen er sat',
     utenAdr.ok === false && /adresse/i.test(utenAdr.error), utenAdr.error);
  await band.updateMember('d-m', { address: HJEM });

  const ukendtJob = await kald('recalcJobDistance', { attendanceId: 'findes-ikke' }, medlemCreds);
  ok('recalcJobDistance: ukendt job afvises', ukendtJob.ok === false, ukendtJob.error);

  // ── Afstandscachen er pr. band ─────────────────────────────────────────
  await band.putDistanceCache('a|b', 'a', 'b', 42);
  ok('afstandscache: gemmer og læser', (await band.getDistanceCache('a|b')) === 42);
  const andetBand = bandStub(env, BAND + '-andet');
  ok('isolation: afstandscachen deles IKKE mellem bands',
     (await andetBand.getDistanceCache('a|b')) === null);
}
