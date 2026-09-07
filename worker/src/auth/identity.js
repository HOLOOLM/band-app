// SSO på tværs af bands.
//
// Den samme musiker (samme e-mail) kan spille i flere bands og skal kunne bruge
// ét password alle steder. Spørgsmålet er hvor det password er kilden til
// sandhed, og her afviger vi bevidst fra Apps Script-originalen.
//
// ORIGINALEN (Code.gs:1336): identitetskortet i Script Properties er kilden til
// sandhed, og bandets egen passwordHash er "kun en (evt. forældet) skygge".
// Hvert login læste altså identitetskortet.
//
// HER: bandets egen række er kilden til sandhed, og et password-skift SKRIVES UD
// til alle de bands identiteten hører til.
//
// Hvorfor vendt om: et Durable Object er enkelttrådet. Læste hvert login
// identiteten i MasterDO, ville master blive et globalt serialiseringspunkt for
// samtlige bands — præcis den flaskehals _withLock er i dag, blot flyttet et lag
// ned. Se arkitekturreglen i planens Fase 1.
//
// Byttehandlen: login (hyppigt) rører kun ét objekt, mens kodeskift (sjældent)
// koster N parallelle skrivninger. N er antallet af bands DEN ENE musiker er med
// i — 1-3 i praksis, ikke antallet af bands i systemet.
//
// Delvis fejl: rammer én bands skrivning ikke igennem, har det band stadig den
// gamle hash. Derfor skrives den kanoniske hash til master FØRST, så der findes
// en holdbar optegnelse over hvad passwordet SKULLE være. Næste kodeskift eller
// en admin-nulstilling reparerer det, og Fase 3j's bandHealth får et tjek der
// finder bands ude af sync.

import { masterStub, bandStub } from '../lib/addressing.js';

/**
 * Skriver et nyt password ud til alle bands identiteten hører til.
 *
 * `undtagenBandId` springer det band over, kalderen allerede har skrevet til, så
 * vi ikke skriver samme række to gange.
 *
 * Kalderen skal IKKE fejle på et delvist resultat: brugerens eget kodeskift er
 * allerede gennemført i det band de sidder i, og at fejle her ville efterlade
 * dem i tvivl om, om koden blev skiftet.
 */
export async function syncPasswordAcrossBands(env, email, pf, undtagenBandId) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, error: 'email mangler' };

  const master = masterStub(env);

  // Kanonisk optegnelse først — den er reparationsgrundlaget hvis en
  // band-skrivning fejler nedenfor.
  await master.putIdentity(e, pf.passwordHash, pf.pwSalt);

  // Alle bands, ikke kun de crossBand-aktiverede: et password gælder overalt
  // hvor personen har en konto, uanset om bandet har betalt for tværgående
  // visning af jobs.
  const alle = await master.bandsForIdentity(e, false);
  const maal = alle.filter(b => b !== undtagenBandId);

  const svar = await Promise.allSettled(maal.map(async bandId => {
    const stub = bandStub(env, bandId);
    const m = await stub.findMemberByEmail(e);
    if (!m) return { bandId, sprunget: true };   // ikke medlem der (længere)
    await stub.setMemberPassword(m.id, pf.passwordHash, pf.pwSalt, false);
    return { bandId };
  }));

  const fejlede = [];
  svar.forEach((r, i) => { if (r.status === 'rejected') fejlede.push(maal[i]); });
  if (fejlede.length) {
    console.warn('Password-sync fejlede for bands: ' + fejlede.join(', ') +
                 '. Master har den kanoniske hash; reparér med en nulstilling.');
  }
  return { ok: true, opdaterede: maal.length - fejlede.length, fejlede };
}

/**
 * Registrerer at en e-mail hører til et band.
 *
 * Overskriver ALDRIG en eksisterende identitets password: musikeren har allerede
 * et password der virker i sine andre bands, og det skal fortsat virke her.
 * Returnerer om identiteten fandtes i forvejen, så kalderen kan sige det rigtige
 * til admin — "koden er X" er forkert, hvis personen beholder sin gamle.
 *
 * SIKKERHED — hvorfor der IKKE længere seedes et password her:
 *
 * Funktionen skrev før identitetskortet med den midlertidige kode kalderen lige
 * havde genereret, hvis kortet ikke fandtes. Det gjorde en ADMIN-VALGT kode
 * kanonisk for personen på tværs af hele systemet, og gav denne overtagelse:
 *
 *   1. Mallory er admin i band X. Hun opretter offer@bandy.dk som medlem hos
 *      sig. Personen findes ikke i systemet endnu, så identitetskortet seedes
 *      med DEN kode Mallory selv fik udleveret i svaret.
 *   2. Måneder senere onboarder band Y personen helt normalt. saveMember ser
 *      `havdeIdentitetFoer = true` og kopierer — helt efter hensigten — den
 *      kanoniske hash ind i band Y, uden tvunget kodeskift.
 *   3. Mallory logger ind i band Y som offeret, med den kode hun selv kender.
 *
 * Angrebet overlever både en band-lokal nulstilling og et bandbundet token,
 * fordi der aldrig nulstilles eller skiftes band undervejs. Invarianten der
 * lukker det er:
 *
 *     En admin-genereret midlertidig kode må ALDRIG blive den kanoniske
 *     identitets-hash.
 *
 * Efter denne ændring skrives `identities`-rækken kun af
 * syncPasswordAcrossBands, som kun kaldes fra changePassword — altså kun når
 * ejeren selv har valgt koden. Det gør samtidig `havdeIdentitetFoer` sandere:
 * feltet betyder nu "personen har selv valgt en adgangskode", og det er præcis
 * den betingelse hvorunder kopieringen i members.js er legitim.
 *
 * `identity_bands` skrives stadig — tilknytningen er uafhængig af password.
 */
export async function registerIdentity(env, email, bandId) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, error: 'email mangler' };
  const master = masterStub(env);
  const eksisterende = await master.getIdentity(e);
  await master.addIdentityBand(e, bandId);
  return { ok: true, havdeIdentitetFoer: !!eksisterende, identitet: eksisterende };
}

/**
 * Hører e-mailen til mindst ét aktivt band?
 *
 * Bruges af routerens `identity`-gate. Den slog før op i `identities`, men den
 * række findes først efter personens FØRSTE selvvalgte kodeskift, nu hvor
 * registerIdentity ikke længere seeder. Tilknytningen er det rigtige spørgsmål
 * alligevel: gaten skal forhindre at en vilkårlig e-mail udløser en fan-out,
 * ikke afgøre om personen har skiftet kode.
 */
export async function identityHasBands(env, email) {
  const master = masterStub(env);
  const bands = await master.bandsForIdentity(String(email || '').toLowerCase().trim(), false);
  return bands.length > 0;
}

/**
 * Fjerner koblingen mellem en e-mail og et band. Kaldes når et medlem slettes.
 * Identiteten selv bliver stående så længe e-mailen hører til andre bands.
 */
export async function removeIdentityBand(env, email, bandId) {
  const master = masterStub(env);
  return master.removeIdentityBand(String(email || '').toLowerCase().trim(), bandId);
}

/**
 * Den kanoniske hash for en e-mail. Bruges KUN til reparation og til de
 * tværgående actions — aldrig på en login-sti.
 */
export async function canonicalPassword(env, email) {
  const master = masterStub(env);
  return master.getIdentity(String(email || '').toLowerCase().trim());
}
