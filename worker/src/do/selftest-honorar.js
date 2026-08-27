// Selvtest af Fase 3e — honorar og fakturaer.
//
// De to vigtigste tests:
//   1. at et slettet fakturanummer IKKE genbruges. Soft-delete findes
//      udelukkende for at holde nummeret reserveret, og to fakturaer med samme
//      nummer i bogføringen er en reel fejl.
//   2. at skemamigreringen til v2 faktisk kørte, og at invoice_nr nu er TEXT.
//      Et heltalsindeks ville sortere "2026-10" før "2026-9".

import { runAction } from '../actions/router.js';
import { bandStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { BAND_SCHEMA_VERSION } from './schema.js';

const BAND = 'selftest-e';
const ADMIN = 'chef-e@test.dk';
const MEDLEM = 'musiker-e@test.dk';
const KODE = 'honorar-test-kode';
const HJEM = 'Frejasvej 65, 6840 Oksbøl';

export async function honorarChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  const band = bandStub(env, BAND);
  const iter = pwIterations(env);
  const hash = await sha256hex(KODE);

  // ── Migreringen til v2 ───────────────────────────────────────────────────
  const st = await band.status();
  ok('skema: løftet til nyeste version', st.schemaVersion === BAND_SCHEMA_VERSION,
     'version ' + st.schemaVersion + ' af ' + BAND_SCHEMA_VERSION);
  const kol = await band.debugColumnTypes('invoices');
  ok('skema v2: invoice_nr er TEXT, ikke INTEGER', kol.invoice_nr === 'TEXT',
     'invoice_nr er ' + kol.invoice_nr);

  await band.syncMeta({ band_id: BAND, name: 'Honorar-band', status: 'active' });
  for (const [id, email, role, adr] of [
    ['e-a', ADMIN, 'admin', ''], ['e-m', MEDLEM, 'member', HJEM]
  ]) {
    const pf = await newPasswordFields(hash, iter);
    if (!await band.findMemberById(id)) {
      await band.insertMember({
        id, name: role === 'admin' ? 'Chef' : 'Musiker', category: 'Musiker',
        instrument: 'Bas', phone: '', email, regAccount: '', address: adr,
        passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
        forcePasswordChange: 0, role, createdAt: new Date().toISOString()
      });
    } else {
      await band.setMemberPassword(id, pf.passwordHash, pf.pwSalt, false);
      await band.updateMember(id, { address: adr });
    }
    await band.clearLoginAttempts(email);
  }
  const aLogin = await runAction(env, 'login', { bandId: BAND, email: ADMIN, passwordHash: hash });
  const mLogin = await runAction(env, 'login', { bandId: BAND, email: MEDLEM, passwordHash: hash });
  ok('3e-opsætning: logins virker', aLogin.ok && mLogin.ok, aLogin.error || mLogin.error);
  const aCreds = { email: ADMIN, token: aLogin.memberToken };
  const mCreds = { email: MEDLEM, token: mLogin.memberToken };
  const kald = (a, p, c) => runAction(env, a, Object.assign({ bandId: BAND }, p), c);

  // ── Tre kontrakter i to år ───────────────────────────────────────────────
  for (const c of await band.listContracts()) await band.deleteContract(c.id);
  for (const i of await band.listInvoices()) await band.hardDeleteInvoiceForTest(i.id);
  await band.hardDeleteAllInvoicesForTest();

  const jobs = [
    ['H-1', '2026-03-15', 30000, 6000, 'Værket', 'Vejle'],
    ['H-2', '2026-06-20', 40000, 8000, 'Train', 'Aarhus'],
    ['H-3', '2025-11-10', 20000, 4000, 'Gimle', 'Roskilde']
  ];
  for (const [id, dato, honorar, share, navn, by] of jobs) {
    await kald('saveContract', {
      contract: {
        id, type: 'Spillested', status: 'godkendt',
        arrangoer: { name: navn + ' Arr' },
        venue: { name: navn, address: 'Gade 1', postnr: '1000', city: by },
        date: dato, honorar
      },
      attendees: [{ memberId: 'e-m', share }]
    }, aCreds);
  }

  // ── getMyHonorar ─────────────────────────────────────────────────────────
  const alle = await kald('getMyHonorar', {}, mCreds);
  ok('getMyHonorar: svarer med rækker', alle.ok === true && alle.rows.length === 3,
     (alle.rows || []).length + ' rækker');
  ok('getMyHonorar: summerer andele', alle.total === 6000 + 8000 + 4000, String(alle.total));
  ok('getMyHonorar: rækker sorteret på dato',
     new Date(alle.rows[0].date) <= new Date(alle.rows[1].date) &&
     new Date(alle.rows[1].date) <= new Date(alle.rows[2].date));
  ok('getMyHonorar: besætning med pr. række',
     Array.isArray(alle.rows[0].besaetning) && alle.rows[0].besaetning.length >= 1,
     JSON.stringify(alle.rows[0].besaetning));
  ok('getMyHonorar: kontraktens samlede honorar lækkes IKKE',
     !JSON.stringify(alle).includes('40000') && !JSON.stringify(alle).includes('30000'));

  // Datoafgrænsning.
  const kun2026 = await kald('getMyHonorar', { fra: '2026-01-01', til: '2026-12-31' }, mCreds);
  ok('getMyHonorar: fra/til afgrænser perioden',
     kun2026.rows.length === 2 && kun2026.total === 14000,
     kun2026.rows.length + ' rækker, total ' + kun2026.total);
  const kunEt = await kald('getMyHonorar', { fra: '2026-06-01', til: '2026-06-30' }, mCreds);
  ok('getMyHonorar: snæver periode giver én række',
     kunEt.rows.length === 1 && kunEt.rows[0].share === 8000,
     kunEt.rows.length + '');

  // ── getHonorarAdmin bruger MÅLMEDLEMMETS adresse ────────────────────────
  const somAdmin = await kald('getHonorarAdmin', { memberId: 'e-m' }, aCreds);
  ok('getHonorarAdmin: admin ser medlemmets afregning',
     somAdmin.ok === true && somAdmin.total === 18000 &&
     somAdmin.member.email === MEDLEM, somAdmin.error);
  const ukendtM = await kald('getHonorarAdmin', { memberId: 'findes-ikke' }, aCreds);
  ok('getHonorarAdmin: ukendt medlem afvises', ukendtM.ok === false, ukendtM.error);
  const somMedlem = await kald('getHonorarAdmin', { memberId: 'e-a' }, mCreds);
  ok('gate: medlem kan ikke se andres afregning',
     somMedlem.ok === false && /administrator/.test(somMedlem.error), somMedlem.error);

  // Afstand skal komme fra cachen, og læsestien må ikke skrive.
  const attH1 = (await band.getContract('H-1')).attendees[0];
  await band.setAttendanceDistance(attH1.id, 55.5, HJEM, true);
  const medKm = await kald('getMyHonorar', {}, mCreds);
  const raekkeH1 = medKm.rows.find(r => r.venue.name === 'Værket');
  ok('getMyHonorar: viser cachet afstand', raekkeH1.distanceKm === 55.5,
     String(raekkeH1.distanceKm));
  ok('getMyHonorar: totalKm summerer', medKm.totalKm === 55.5, String(medKm.totalKm));
  const foer = await band.writeCounter();
  await kald('getMyHonorar', {}, mCreds);
  await kald('getHonorarAdmin', { memberId: 'e-m' }, aCreds);
  ok('honorar: læsestien SKRIVER IKKE', (await band.writeCounter()) === foer,
     'ændringer før ' + foer + ', efter ' + (await band.writeCounter()));

  // ── Fakturaer: nummerering ──────────────────────────────────────────────
  const f1 = await kald('createInvoice', { contractId: 'H-1' }, aCreds);
  ok('createInvoice: opretter faktura med årsnummer',
     f1.ok === true && f1.invoice.invoiceNr === '2026-001', f1.invoice && f1.invoice.invoiceNr);
  ok('createInvoice: beløb følger kontraktens honorar', f1.invoice.amount === 30000,
     String(f1.invoice.amount));
  ok('createInvoice: status er udestaaende', f1.invoice.status === 'udestaaende');

  const f2 = await kald('createInvoice', { contractId: 'H-2' }, aCreds);
  ok('createInvoice: næste nummer i samme år', f2.invoice.invoiceNr === '2026-002',
     f2.invoice.invoiceNr);

  const f3 = await kald('createInvoice', { contractId: 'H-3' }, aCreds);
  ok('createInvoice: eget nummerspor pr. år', f3.invoice.invoiceNr === '2025-001',
     f3.invoice.invoiceNr);

  const igen = await kald('createInvoice', { contractId: 'H-1' }, aCreds);
  ok('createInvoice: genbruger eksisterende faktura frem for nyt nummer',
     igen.ok === true && igen.reused === true && igen.invoice.invoiceNr === '2026-001',
     igen.invoice.invoiceNr + ', reused=' + igen.reused);

  const ukendtK = await kald('createInvoice', { contractId: 'findes-ikke' }, aCreds);
  ok('createInvoice: ukendt kontrakt afvises', ukendtK.ok === false, ukendtK.error);

  // ── KERNEN: et slettet nummer må ikke genbruges ─────────────────────────
  const slet = await kald('deleteInvoice', { id: f2.invoice.id }, aCreds);
  ok('deleteInvoice: sletter fakturaen', slet.ok === true, slet.error);

  const efterSlet = await kald('getInvoices', {}, aCreds);
  ok('deleteInvoice: slettet faktura skjules i listen',
     !efterSlet.invoices.some(i => i.id === f2.invoice.id),
     efterSlet.invoices.map(i => i.invoiceNr).join(', '));

  const f4 = await kald('createInvoice', { contractId: 'H-2' }, aCreds);
  ok('deleteInvoice: nummeret på en slettet faktura GENBRUGES IKKE',
     f4.invoice.invoiceNr === '2026-003',
     'fik ' + f4.invoice.invoiceNr + ' (2026-002 er slettet og skal forblive reserveret)');

  // ── Status og betalingsdato ─────────────────────────────────────────────
  const betalt = await kald('updateInvoiceStatus', { id: f1.invoice.id, status: 'betalt' }, aCreds);
  ok('updateInvoiceStatus: markerer betalt', betalt.ok === true, betalt.error);
  const efterBetalt = await band.getInvoice(f1.invoice.id);
  ok('updateInvoiceStatus: paidAt sættes ved betalt',
     !!efterBetalt.paidAt, String(efterBetalt.paidAt));

  await kald('updateInvoiceStatus', { id: f1.invoice.id, status: 'udestaaende' }, aCreds);
  const efterFortryd = await band.getInvoice(f1.invoice.id);
  ok('updateInvoiceStatus: paidAt ryddes ved udestaaende igen',
     !efterFortryd.paidAt, JSON.stringify(efterFortryd.paidAt));

  const ugyldigStatus = await kald('updateInvoiceStatus',
    { id: f1.invoice.id, status: 'noget-andet' }, aCreds);
  ok('updateInvoiceStatus: ugyldig status afvises', ugyldigStatus.ok === false,
     ugyldigStatus.error);
  const ukendtF = await kald('updateInvoiceStatus', { id: 'findes-ikke', status: 'betalt' }, aCreds);
  ok('updateInvoiceStatus: ukendt faktura afvises', ukendtF.ok === false, ukendtF.error);

  // ── getInvoices beriges med kontraktdata ────────────────────────────────
  const liste = await kald('getInvoices', {}, aCreds);
  ok('getInvoices: beriger med arrangør og spillested',
     liste.ok === true && liste.invoices.length >= 3 &&
     liste.invoices.every(i => i.arrangoer !== undefined && i.venue !== undefined),
     liste.invoices.length + ' fakturaer');
  const enF = liste.invoices.find(i => i.invoiceNr === '2026-001');
  ok('getInvoices: arrangørnavn udpakket', enF && enF.arrangoer && enF.arrangoer.name === 'Værket Arr',
     enF && enF.arrangoer && enF.arrangoer.name);
  ok('getInvoices: CPR findes ikke nogen steder i svaret',
     !/cpr/i.test(JSON.stringify(liste)));

  // ── Gates ───────────────────────────────────────────────────────────────
  const medlemFaktura = await kald('createInvoice', { contractId: 'H-1' }, mCreds);
  ok('gate: medlem kan ikke oprette fakturaer', medlemFaktura.ok === false,
     medlemFaktura.error);
  const medlemListe = await kald('getInvoices', {}, mCreds);
  ok('gate: medlem kan ikke se fakturalisten', medlemListe.ok === false, medlemListe.error);
  const egenAfregning = await kald('getMyHonorar', {}, mCreds);
  ok('gate: medlem KAN se sin egen afregning', egenAfregning.ok === true);
}
