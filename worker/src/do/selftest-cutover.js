// Selvtest af omskiftningsflaget.
//
// Det vigtigste tjek i hele suiten set fra bandets stol: at STANDARDEN ikke
// flytter nogen. Bandenes rigtige data ligger i Apps Scripts Google Sheet, og
// et utilsigtet skift ville vise dem en tom app — ikke ødelagt, men tom, og det
// er umuligt at skelne fra "alt er tabt" når man sidder som bandleder søndag
// aften.
//
// Testen dækker også at flaget fejler MOD SHEETS ved en tastefejl. En ukendt
// værdi skal ramme den sti hvor dataen faktisk ligger.

import { usesDurableObjects, backendDescription } from '../backend.js';

export function cutoverChecks(ok) {
  const f = (v, band) => usesDurableObjects({ BACKEND: v }, band);

  // ── Standarden må ikke flytte nogen ─────────────────────────────────────
  ok('omskiftning: STANDARD (uden BACKEND sat) holder alle på Apps Script',
     usesDurableObjects({}, 'dmdt') === false &&
     usesDurableObjects({}, 'hvad-som-helst') === false);
  ok('omskiftning: "sheets" holder alle på Apps Script',
     f('sheets', 'dmdt') === false && f('sheets', 'test-a') === false);
  ok('omskiftning: beskrivelsen siger tydeligt hvad der er i brug',
     backendDescription({}).includes('Apps Script') &&
     backendDescription({ BACKEND: 'do' }).includes('Durable Objects'),
     backendDescription({}));

  // ── Fejl MOD Sheets, ikke mod DO ────────────────────────────────────────
  ok('omskiftning: tastefejl i flaget holder alle på Apps Script',
     f('DO', 'dmdt') === false &&           // versaler
     f('durable', 'dmdt') === false &&
     f('do-', 'dmdt') === false &&
     f('', 'dmdt') === false &&
     f('  ', 'dmdt') === false);
  ok('omskiftning: "do:" uden bands flytter ingen',
     f('do:', 'dmdt') === false && f('do:', '') === false);

  // ── Skift pr. band ──────────────────────────────────────────────────────
  ok('omskiftning: "do:dmdt" flytter KUN dmdt',
     f('do:dmdt', 'dmdt') === true &&
     f('do:dmdt', 'andet-band') === false);
  ok('omskiftning: flere bands kan nævnes',
     f('do:dmdt,test-a', 'dmdt') === true &&
     f('do:dmdt,test-a', 'test-a') === true &&
     f('do:dmdt,test-a', 'test-b') === false);
  ok('omskiftning: mellemrum i listen tolereres',
     f('do: dmdt , test-a ', 'dmdt') === true &&
     f('do: dmdt , test-a ', 'test-a') === true);
  ok('omskiftning: delvist navnematch tæller IKKE',
     f('do:dmdt', 'dmdt-2') === false &&
     f('do:dmdt-2', 'dmdt') === false);

  // ── Alle på én gang ─────────────────────────────────────────────────────
  ok('omskiftning: "do" flytter alle bands',
     f('do', 'dmdt') === true && f('do', 'et-helt-nyt-band') === true);
  ok('omskiftning: mellemrum omkring "do" tolereres',
     f('  do  ', 'dmdt') === true);

  // ── Tomt bandId ─────────────────────────────────────────────────────────
  // Operatør- og booker-actions har intet bandId. De hører til det nye lag så
  // snart NOGEN er skiftet — ellers ville operatøren administrere ét system og
  // bandene ligge i et andet.
  ok('omskiftning: tomt bandId matcher ikke en band-liste',
     f('do:dmdt', '') === false);
}

/**
 * Bootstrap af den første operatør.
 *
 * Uden den er systemet uigennemtrængeligt — alle operatør-handlinger kræver et
 * token, og et token kræver en operatør. Testen kræver at den bliver INERT
 * efter første brug, så et glemt BOOTSTRAP_TOKEN ikke er en bagdør.
 */
export async function bootstrapChecks(env, ok) {
  const { bootstrapOperator, operatorChangePassword } = await import('../actions/operator.js');
  const { masterStub } = await import('../lib/addressing.js');
  const { sha256hex, randomBase64 } = await import('../lib/crypto.js');
  const { runAction } = await import('../actions/router.js');

  // Eget master-objekt til denne test, så vi kan møde en TOM operators-tabel.
  // Det rigtige master har allerede operatører fra de øvrige tests.
  const e2 = Object.assign({}, env, {
    MASTER_SECRET: env.MASTER_SECRET || randomBase64(32)
  });
  const master = masterStub(e2);
  const st = await master.status();

  if (Number(st.operators) > 0) {
    // Systemet har allerede en operatør — så er det netop den tilstand hvor
    // bootstrap SKAL være lukket. Det er det vigtigste tjek.
    const forsoeg = await bootstrapOperator(e2, 'ny-bagdoer@test.dk', 'et-langt-password-123');
    ok('bootstrap: er INERT når der allerede findes en operatør',
       forsoeg.ok === false && /allerede en operatør/.test(forsoeg.error), forsoeg.error);
  } else {
    const foerste = await bootstrapOperator(e2, 'foerste@test.dk', 'et-langt-password-123');
    ok('bootstrap: opretter den første operatør', foerste.ok === true, foerste.error);
    const igen = await bootstrapOperator(e2, 'nummer-to@test.dk', 'et-langt-password-123');
    ok('bootstrap: er INERT efter første brug', igen.ok === false, igen.error);
  }

  const kortKode = await bootstrapOperator(e2, 'x@test.dk', 'kort');
  ok('bootstrap: afviser kort adgangskode (eller er lukket)',
     kortKode.ok === false, kortKode.error);
  const daarligMail = await bootstrapOperator(e2, 'ikke-en-mail', 'et-langt-password-123');
  ok('bootstrap: afviser ugyldig e-mail (eller er lukket)',
     daarligMail.ok === false, daarligMail.error);

  // ── operatorChangePassword ─────────────────────────────────────────────
  const gammel = 'skift-mig-kode-lang';
  const ny = 'helt-ny-operatoer-kode';
  const { newPasswordFields, pwIterations } = await import('../lib/crypto.js');
  const pf = await newPasswordFields(await sha256hex(gammel), pwIterations(e2));
  await master.putOperator('skift@test.dk', pf.passwordHash, pf.pwSalt);
  await master.clearOperatorLoginAttempts('skift@test.dk');

  const lg = await runAction(e2, 'operatorLogin',
    { email: 'skift@test.dk', passwordHash: await sha256hex(gammel) });
  ok('operatorChangePassword: opsætning — login virker', lg.ok === true, lg.error);
  const creds = { operatorToken: lg.token };

  const forkertGammel = await runAction(e2, 'operatorChangePassword',
    { oldHash: await sha256hex('forkert'), newHash: await sha256hex(ny) }, creds);
  ok('operatorChangePassword: forkert gammel kode afvises',
     forkertGammel.ok === false && /gamle adgangskode/.test(forkertGammel.error),
     forkertGammel.error);

  const kortNy = await runAction(e2, 'operatorChangePassword',
    { oldHash: await sha256hex(gammel), newHash: 'kort' }, creds);
  ok('operatorChangePassword: ny kode skal være en 64-tegns sha256',
     kortNy.ok === false, kortNy.error);

  const skiftet = await runAction(e2, 'operatorChangePassword',
    { oldHash: await sha256hex(gammel), newHash: await sha256hex(ny) }, creds);
  ok('operatorChangePassword: skifter koden', skiftet.ok === true, skiftet.error);

  await master.clearOperatorLoginAttempts('skift@test.dk');
  const medGammel = await runAction(e2, 'operatorLogin',
    { email: 'skift@test.dk', passwordHash: await sha256hex(gammel) });
  ok('operatorChangePassword: den gamle kode virker ikke længere',
     medGammel.ok === false, medGammel.error);
  await master.clearOperatorLoginAttempts('skift@test.dk');
  const medNy = await runAction(e2, 'operatorLogin',
    { email: 'skift@test.dk', passwordHash: await sha256hex(ny) });
  ok('operatorChangePassword: den nye kode virker', medNy.ok === true, medNy.error);

  const udenTok = await runAction(e2, 'operatorChangePassword',
    { oldHash: 'x', newHash: 'y' }, null);
  ok('gate: operatorChangePassword kræver operatør-token', udenTok.ok === false, udenTok.error);
}
