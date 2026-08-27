// Selvtest af datalaget. Kører kun når SELFTEST-varen er "on", hvilket den
// udelukkende er i lokal udvikling. Varen sættes bevidst IKKE i wrangler.toml,
// men på kommandolinjen: wrangler dev --var SELFTEST:on — så den ikke kan
// følge med et deploy ved et uheld.
//
// Det vigtigste her er ikke at tabellerne findes, men at ISOLATIONEN holder:
// - at band_id ikke findes som kolonne på nogen band-tabel, og
// - at en skrivning i band A er usynlig fra band B.
// Det er de to påstande hele arkitekturvalget hviler på, så de skal kunne
// efterprøves med ét kald frem for at være noget vi tror på.

import { bandStub, masterStub, fanOut, jurisdictionActive } from '../lib/addressing.js';
import { authChecks } from './selftest-auth.js';
import { actionChecks } from './selftest-actions.js';
import { memberChecks } from './selftest-members.js';
import { contractChecks } from './selftest-contracts.js';
import { jobChecks } from './selftest-jobs.js';

const BAND_TABLES = ['members', 'contracts', 'attendances', 'invoices',
                     'bookings', 'settings', 'login_log', 'sessions',
                     'assets', 'distance_cache', 'counters'];

export async function selftest(env) {
  const checks = [];
  const advarsler = [];
  const ok = (navn, bestået, detalje) => checks.push({ navn, bestået: !!bestået, detalje });

  try {
    // ── Crypto, password-hashing og tokens (Fase 3a) ──────────────────────
    await authChecks(ok);

    // ── Auth-actions gennem routeren, inkl. gates (Fase 3a) ───────────────
    await actionChecks(env, ok, advarsler);

    // ── Medlemmer, startkoder, SSO og GDPR (Fase 3b) ──────────────────────
    await memberChecks(env, ok);

    // ── Kontrakter og dashboard (Fase 3c) ─────────────────────────────────
    await contractChecks(env, ok);

    // ── Jobs og køreafstand (Fase 3d) ─────────────────────────────────────
    await jobChecks(env, ok);

    // ── Skema løftes ved første adgang ────────────────────────────────────
    const master = masterStub(env);
    const mStatus = await master.status();
    ok('master: skema løftet', mStatus.schemaVersion >= 1, 'version ' + mStatus.schemaVersion);

    const a = bandStub(env, 'selftest-a');
    const b = bandStub(env, 'selftest-b');
    const aStatus = await a.status();
    ok('band A: skema løftet', aStatus.schemaVersion >= 1, 'version ' + aStatus.schemaVersion);

    // ── ISOLATION 1: band_id findes ikke som kolonne ──────────────────────
    // Hvis denne fejler, er vi tilbage i en model hvor en glemt WHERE-betingelse
    // kan lække data mellem bands.
    const kolonner = await a.debugColumns(BAND_TABLES);
    const medBandId = Object.entries(kolonner)
      .filter(([, cols]) => cols.includes('band_id'))
      .map(([t]) => t);
    ok('isolation: ingen band_id-kolonne på band-tabeller',
       medBandId.length === 0,
       medBandId.length ? 'FANDT band_id i: ' + medBandId.join(', ')
                        : BAND_TABLES.length + ' tabeller tjekket');

    const manglende = BAND_TABLES.filter(t => !kolonner[t] || !kolonner[t].length);
    ok('alle band-tabeller oprettet', manglende.length === 0,
       manglende.length ? 'mangler: ' + manglende.join(', ') : BAND_TABLES.length + ' tabeller');

    // ── ISOLATION 2: skrivning i A er usynlig fra B ───────────────────────
    await a.putSettings({ bandName: 'Band A hemmelighed' });
    await b.putSettings({ bandName: 'Band B' });
    const aSet = await a.getSettings();
    const bSet = await b.getSettings();
    ok('isolation: A ser sin egen værdi', aSet.bandName === 'Band A hemmelighed', aSet.bandName);
    ok('isolation: B ser IKKE A\'s værdi',
       bSet.bandName === 'Band B',
       'B læste: ' + bSet.bandName);

    // ── Settings-whitelist ───────────────────────────────────────────────
    await a.putSettings({ bandName: 'A2', ondsindetNoegle: 'x' }, ['bandName']);
    const efter = await a.getSettings();
    ok('settings: whitelist afviser ukendt nøgle',
       efter.bandName === 'A2' && efter.ondsindetNoegle === undefined,
       'ondsindetNoegle = ' + efter.ondsindetNoegle);

    // ── Sessioner: gemmes, læses, udløber, fornyes kun sent ──────────────
    await a.putSession('sid-test', { kind: 'member', subject: 'm1', token: 'mt:abc', pwFp: 'fp1' }, 8 * 3600);
    const sess = await a.getSession('sid-test');
    ok('session: gemt og læst', sess && sess.token === 'mt:abc', sess && sess.kind);

    const fraB = await b.getSession('sid-test');
    ok('isolation: A\'s session findes ikke i B', fraB === null,
       fraB ? 'LÆKKEDE' : 'afvist som forventet');

    const t1 = await a.touchSession('sid-test', 8 * 3600, 3600);
    ok('session: fornyes IKKE når der er lang tid tilbage',
       t1.ok && t1.renewed === false, 'renewed=' + t1.renewed);
    const t2 = await a.touchSession('sid-test', 8 * 3600, 999999);
    ok('session: fornyes når tiden er ved at løbe ud',
       t2.ok && t2.renewed === true, 'renewed=' + t2.renewed);

    await a.putSession('sid-udloebet', { kind: 'member', subject: 'm1', token: 't' }, -10);
    ok('session: udløbet session afvises', (await a.getSession('sid-udloebet')) === null);

    await a.killSessionsFor('m1');
    ok('session: password-skift dræber alle sessioner for subjektet',
       (await a.getSession('sid-test')) === null);

    // ── Tællere ──────────────────────────────────────────────────────────
    const n1 = await a.nextCounter('invoiceNr');
    const n2 = await a.nextCounter('invoiceNr');
    ok('tæller: stiger monotont', n2 === n1 + 1, n1 + ' → ' + n2);

    // Uafhængighed skal måles som en DELTA, ikke mod en forventet startværdi:
    // selvtesten kan køre flere gange mod samme lokale database, så tællerne
    // er ikke nul ved indgangen.
    const bFør = await b.nextCounter('invoiceNr');
    await a.nextCounter('invoiceNr');
    await a.nextCounter('invoiceNr');
    const bEfter = await b.nextCounter('invoiceNr');
    ok('isolation: B\'s tæller rykker sig ikke når A\'s tælles op',
       bEfter === bFør + 1,
       'B: ' + bFør + ' → ' + bEfter + ' mens A blev tællet op to gange');

    // ── Master: tenant-register og kryds-band ────────────────────────────
    await master.createBand('selftest-a', 'Selvtest A');
    await master.createBand('selftest-b', 'Selvtest B');
    const dublet = await master.createBand('selftest-a', 'Igen');
    ok('master: afviser dublet band-id', dublet.ok === false, dublet.error);

    await master.updateBand('selftest-a', { crossBand: 1 });
    await master.updateBand('selftest-b', { crossBand: 1 });
    await master.putIdentity('jho@example.com', 'hash', 'salt');
    await master.addIdentityBand('jho@example.com', 'selftest-a');
    await master.addIdentityBand('jho@example.com', 'selftest-b');
    const bands = await master.bandsForIdentity('jho@example.com');
    ok('master: identitet peger på begge bands', bands.length === 2, bands.join(', '));

    const fan = await fanOut(env, bands, stub => stub.getSettings());
    const navne = fan.results.map(r => r.value.bandName).sort();
    ok('kryds-band: fan-out henter fra begge, hver med sin egen værdi',
       fan.failed.length === 0 && navne.length === 2 && navne[0] !== navne[1],
       navne.join(' | '));

    // ── Operatørlisten må ikke fanne ud ──────────────────────────────────
    await master.reportStats('selftest-a', 5, 2);
    const liste = await master.listBands();
    const aRow = liste.find(r => r.bandId === 'selftest-a');
    ok('operatørliste: statistik læses fra master, ikke fra N objekter',
       aRow && aRow.statMembers === 5 && aRow.statUpcoming === 2,
       aRow ? aRow.statMembers + ' medlemmer, ' + aRow.statUpcoming + ' kommende' : 'række mangler');

    // ── Audit ────────────────────────────────────────────────────────────
    await master.audit('selftest', 'test-handling', 'selftest-a', 'detalje');
    const log = await master.getAuditLog(10, 'selftest-a');
    ok('audit: skrevet og læst pr. band', log.length >= 1 && log[0].action === 'test-handling',
       log.length + ' poster');

    // ── Placering ────────────────────────────────────────────────────────
    // Miniflare understøtter ikke jurisdiktioner lokalt, så dette kan aldrig
    // bestå her. Det er en ADVARSEL, ikke en fejl — men jurisdiktionen SKAL
    // verificeres i produktion, hvor CPR-dataen ligger. Det hører i operatørens
    // bandHealth-handling, som kører med rigtige bindinger.
    if (!jurisdictionActive(env)) {
      advarsler.push('EU-jurisdiktion er ikke aktiv i dette miljø. Forventet lokalt ' +
        '(miniflare understøtter det ikke), men SKAL verificeres i produktion via ' +
        'bandHealth — appen gemmer CPR-numre.');
    } else {
      ok('placering: EU-jurisdiktion aktiv', true, 'jurisdiction(eu)');
    }

  } catch (e) {
    ok('selvtest gennemført uden undtagelser', false, String(e && e.stack || e));
  }

  const fejlede = checks.filter(c => !c.bestået);
  return {
    ok: fejlede.length === 0,
    bestået: checks.length - fejlede.length,
    fejlede: fejlede.length,
    advarsler,
    checks
  };
}
