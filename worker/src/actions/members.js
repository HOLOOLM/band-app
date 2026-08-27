// Fase 3b — medlemmer.
//
// Den væsentlige ændring mod originalen: hvert medlem får sin EGEN tilfældige
// startkode i stedet for bandets delte `seedPassword`.
//
// Den delte kode havde tre problemer på én gang: den var den samme for alle
// indtil hver havde skiftet, den udløb aldrig, og den kunne gættes ud fra
// bandnavnet (`dmdt2026`). Rate-limit hjælper ikke mod det sidste — man skal
// kun gætte én gang.
//
// Mønsteret findes allerede i jeres egen kode for bookere
// (_genBookerTempPassword, Code.gs:1263). Vi løfter det blot et niveau op.
//
// Svarfeltet heder fortsat `seedPassword`, fordi 06-members.js:129 og
// 09-boot.js:729 læser netop det navn. Frontenden ændres altså ikke — den viser
// bare en anden streng end før.

import { sha256hex, newPasswordFields, pwIterations, randomBytes } from '../lib/crypto.js';
import { publicMember } from '../auth/verify.js';
import { registerIdentity, syncPasswordAcrossBands, removeIdentityBand } from '../auth/identity.js';
import { userError } from '../lib/errors.js';

/**
 * Tilfældig startkode. Samme form som _genBookerTempPassword: alfanumerisk og
 * uden tegn der er svære at diktere over telefonen eller forsvinder i en SMS.
 *
 * Udelader bevidst 0/O og 1/l/I — koden bliver læst højt eller skrevet af, og en
 * forveksling koster en supporthenvendelse.
 */
const ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function genTempPassword(laengde = 14) {
  const bytes = randomBytes(laengde * 2);
  let ud = '';
  for (let i = 0; i < bytes.length && ud.length < laengde; i++) {
    // Afvis værdier i den ufuldstændige sidste blok, så fordelingen bliver
    // uniform. Et simpelt modulo ville gøre de første tegn i alfabetet en smule
    // mere sandsynlige.
    const graense = 256 - (256 % ALFABET.length);
    if (bytes[i] >= graense) continue;
    ud += ALFABET[bytes[i] % ALFABET.length];
  }
  // Ekstremt usandsynligt, men hvis for mange bytes blev afvist, så suppler.
  while (ud.length < laengde) {
    const b = randomBytes(1)[0];
    const graense = 256 - (256 % ALFABET.length);
    if (b < graense) ud += ALFABET[b % ALFABET.length];
  }
  return ud;
}

/** getMembers — admin. Uden hemmeligheder; publicMember er en whitelist. */
export async function getMembers(ctx) {
  const rows = await ctx.band.listMembers();
  return { ok: true, members: rows.map(publicMember) };
}

/**
 * saveMember — admin. Opretter eller opdaterer.
 *
 * Ved oprettelse returneres startkoden ÉN gang, i feltet `seedPassword`, så
 * admin-UI'et kan vise den. Den gemmes aldrig i klartekst.
 */
export async function saveMember(ctx) {
  const { env, band, bandId, p } = ctx;
  const data = p.member || {};
  const email = String(data.email || '').toLowerCase().trim();

  if (!data.id) {
    // ── Nyt medlem ────────────────────────────────────────────────────────
    if (!email) return { ok: false, error: 'Email kræves' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Ugyldig email' };
    if (await band.findMemberByEmail(email)) {
      return { ok: false, error: 'Email er allerede i brug af et andet medlem.' };
    }

    const tempPassword = genTempPassword();
    const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
    const id = 'm' + await band.nextCounter('member');

    await band.insertMember({
      id,
      name: data.name || '',
      category: data.category || 'Musiker',
      instrument: data.instrument || '',
      phone: data.phone || '',
      email,
      regAccount: data.regAccount || '',
      address: data.address || '',
      passwordHash: pf.passwordHash,
      pwSalt: pf.pwSalt,
      forcePasswordChange: 1,
      role: data.role || 'member',
      createdAt: new Date().toISOString()
    });

    const reg = await registerIdentity(env, email, bandId, pf);

    // Spiller musikeren allerede i et andet band, har de et password der virker.
    // Det skal fortsat virke her, så vi overskriver det ikke — men så er den
    // startkode vi lige lavede IRRELEVANT, og admin må ikke få den udleveret som
    // om den gjaldt. Originalen kunne ikke skelne, fordi koden var delt.
    if (reg.havdeIdentitetFoer) {
      await band.setMemberPassword(id, reg.identitet.passwordHash, reg.identitet.pwSalt, false);
      return {
        ok: true, id,
        eksisterendeBruger: true,
        besked: 'Medlemmet har allerede en konto i et andet band og bruger sin eksisterende adgangskode.'
      };
    }

    return { ok: true, id, seedPassword: tempPassword };
  }

  // ── Opdatering ──────────────────────────────────────────────────────────
  const patch = {};
  for (const k of ['name', 'category', 'instrument', 'phone', 'regAccount', 'address', 'role']) {
    if (data[k] !== undefined) patch[k] = String(data[k]);
  }

  if (data.email !== undefined) {
    if (!email) return { ok: false, error: 'Email kræves' };
    const eksisterende = await band.findMemberByEmail(email);
    if (eksisterende && String(eksisterende.id) !== String(data.id)) {
      return { ok: false, error: 'Email er allerede i brug af et andet medlem.' };
    }
    patch.email = email;
  }

  if (!Object.keys(patch).length) return { ok: false, error: 'Ingen felter at opdatere' };
  const r = await band.updateMember(data.id, patch);
  if (!r.ok) return { ok: false, error: 'Medlemmet findes ikke' };
  if (patch.email) await registerIdentity(env, patch.email, bandId, null);
  return { ok: true, id: data.id };
}

/**
 * deleteMember — admin. Man kan ikke slette sig selv; ellers kunne den sidste
 * admin fjerne sin egen adgang og efterlade bandet uden administrator.
 */
export async function deleteMember(ctx) {
  const { env, band, bandId, member, p } = ctx;
  const id = String(p.id || '');
  if (!id) return { ok: false, error: 'Mangler id' };
  if (String(member.id) === id) return { ok: false, error: 'Du kan ikke slette dig selv.' };

  // E-mailen skal læses FØR sletningen, ellers er den væk når vi skal rydde op
  // i identiteten.
  const target = await band.findMemberById(id);
  const r = await band.deleteMember(id);
  if (!r.ok) return { ok: false, error: 'Medlemmet findes ikke' };

  // Fjern koblingen i master, så kryds-band-opslag ikke fortsætter med at
  // spørge et band personen ikke er i længere. Fejler det, er medlemmet stadig
  // slettet — koblingen er en pegepind, ikke data i sig selv.
  if (target && target.email) {
    try {
      await removeIdentityBand(env, target.email, bandId);
    } catch (e) {
      console.warn('Kunne ikke rydde identitetskobling for ' + bandId + ': ' +
                   (e && e.message || e));
    }
  }
  return { ok: true };
}

/**
 * resetPassword — admin. Giver medlemmet en ny tilfældig kode og tvinger skift.
 *
 * Nulstillingen skrives ud til alle musikerens bands, fordi passwordet er delt
 * på tværs. Det betyder — som i originalen (Code.gs:1809) — at en band-admin
 * også nulstiller adgangen i de andre bands musikeren spiller i. Det er bevaret
 * adfærd, men værd at vide.
 */
export async function resetPassword(ctx) {
  const { env, band, bandId, p } = ctx;
  const id = String(p.id || '');
  if (!id) return { ok: false, error: 'Mangler id' };

  const target = await band.findMemberById(id);
  if (!target) return { ok: false, error: 'Medlemmet findes ikke' };

  const tempPassword = genTempPassword();
  const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
  const r = await band.setMemberPassword(id, pf.passwordHash, pf.pwSalt, true);
  if (!r.ok) return { ok: false, error: 'Kunne ikke nulstille' };

  // Fejler dette delvist, er koden stadig skiftet i dette band. Vi fejler derfor
  // ikke handlingen — admin har fået en kode der virker her.
  const sync = await syncPasswordAcrossBands(env, target.email, pf, bandId);

  return {
    ok: true,
    seedPassword: tempPassword,
    andreBands: sync.opdaterede || 0
  };
}

/**
 * memberUpdateProfile — medlemmet retter sine egne data.
 *
 * Whitelisten er bevidst kort. `role`, `email`, `regAccount` og alt
 * password-relateret kan ALDRIG ændres ad denne vej: en musiker må ikke kunne
 * gøre sig selv til admin eller overtage en anden e-mail.
 */
export async function memberUpdateProfile(ctx) {
  const { band, member, p } = ctx;
  const patch = {};
  for (const k of ['name', 'phone', 'instrument', 'address']) {
    if (p[k] !== undefined) patch[k] = String(p[k]);
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Ingen felter at opdatere' };
  await band.updateMember(member.id, patch);
  return { ok: true, member: publicMember(Object.assign({}, member, patch)) };
}

/**
 * exportMyData — GDPR art. 15/20. Medlemmet henter ALLE egne persondata.
 *
 * Kun den indloggedes egne data. Bemærk at `memberNote` på kontrakter bevidst
 * ikke er med: den er admins interne note om jobbet, ikke medlemmets persondata,
 * og den er også holdt ude af PDF og iCal.
 */
export async function exportMyData(ctx) {
  const { band, member } = ctx;
  const data = await band.exportMemberData(member.id, member.email);
  const settings = await band.getSettings();
  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    band: settings.bandName || ctx.bandId,
    profile: {
      id: member.id, name: member.name, email: member.email, phone: member.phone,
      category: member.category, instrument: member.instrument,
      address: member.address || '', regAccount: member.regAccount || '',
      role: member.role, createdAt: member.createdAt
    },
    jobs: data.jobs,
    loginHistory: data.loginHistory
  };
}
