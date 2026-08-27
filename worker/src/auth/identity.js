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
 * Registrerer at en e-mail hører til et band, og seeder identitetskortet hvis
 * det ikke findes.
 *
 * Overskriver ALDRIG en eksisterende identitets password: musikeren har allerede
 * et password der virker i sine andre bands, og det skal fortsat virke her.
 * Returnerer om identiteten fandtes i forvejen, så kalderen kan sige det rigtige
 * til admin — "koden er X" er forkert, hvis personen beholder sin gamle.
 */
export async function registerIdentity(env, email, bandId, pf) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, error: 'email mangler' };
  const master = masterStub(env);
  const eksisterende = await master.getIdentity(e);
  if (!eksisterende && pf) {
    await master.putIdentity(e, pf.passwordHash, pf.pwSalt);
  }
  await master.addIdentityBand(e, bandId);
  return { ok: true, havdeIdentitetFoer: !!eksisterende, identitet: eksisterende };
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
