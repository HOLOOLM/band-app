// Fase 3j — operatør og master.
//
// Operatøren styrer ALLE bands og er systemets mest privilegerede login. Derfor:
//   - rate-limit FØR password verificeres, så et låst login ikke kan
//     brute-forces videre
//   - alle handlinger auditeres i master
//   - bandets flag SKAL spejles til band-objektet efter en ændring, ellers ville
//     den varme sti skulle læse master (se arkitekturreglen i planens Fase 1)

import { sha256hex, verifyHash, needsRehash, newPasswordFields, pwIterations }
  from '../lib/crypto.js';
import { issueToken } from '../lib/tokens.js';
import { masterStub, bandStub, jurisdictionActive } from '../lib/addressing.js';
import { SETTINGS_DEFAULTS, ALL_SETTINGS_KEYS } from '../lib/settings-defaults.js';
import { BAND_SCHEMA_VERSION } from '../do/schema.js';
import { genTempPassword } from './members.js';
import { registerIdentity } from '../auth/identity.js';
import { sendMail } from '../services/mail.js';

const OPERATOR_TOKEN_TTL_SEC = 8 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SEC = 15 * 60;

/**
 * operatorLogin. Læser fra masters operators-tabel.
 *
 * Rate-limit ligger i master, keyet på e-mail. Det er det ene sted hvor et
 * master-opslag på en login-sti er acceptabelt: operatør-login sker sjældent og
 * er ikke en varm sti.
 */
export async function operatorLogin(ctx) {
  const { env, p } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  const master = masterStub(env);

  const st = await master.operatorLoginState(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
  if (st.locked) {
    return { ok: false, error: 'For mange mislykkede forsøg. Prøv igen om 15 minutter.' };
  }

  const op = await master.getOperator(email);
  if (!op) {
    await master.penalizeOperatorLogin(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
    return { ok: false, error: 'Forkert email eller adgangskode' };
  }

  const pwOk = await verifyHash(String(p.passwordHash || ''), op.pwSalt, op.passwordHash);
  if (!pwOk) {
    const nu = await master.penalizeOperatorLogin(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
    return {
      ok: false,
      error: nu.locked
        ? 'For mange mislykkede forsøg. Operatør-login er låst i 15 minutter.'
        : 'Forkert email eller adgangskode'
    };
  }

  // Opgradér hashen hvis iterationstallet er hævet siden den blev lavet.
  const maal = pwIterations(env);
  if (needsRehash(op.passwordHash, maal)) {
    const pf = await newPasswordFields(String(p.passwordHash), maal);
    await master.putOperator(email, pf.passwordHash, pf.pwSalt);
  }

  await master.clearOperatorLoginAttempts(email);
  await master.audit(email, 'operatoer-login', '', '');
  return { ok: true, token: await issueToken(env, 'operator', { email }, OPERATOR_TOKEN_TTL_SEC) };
}

/**
 * bootstrapOperator — opretter den FØRSTE operatør.
 *
 * Uden denne er systemet uigennemtrængeligt: alle operatør-handlinger kræver et
 * operatør-token, og et token kræver en operatør. Apps Script løste det med
 * setOperator_RUN_ME() i editoren; her findes ingen editor.
 *
 * To lag beskytter den:
 *   1. BOOTSTRAP_TOKEN-hemmeligheden. Er den ikke sat, findes endpointet ikke.
 *   2. Den virker KUN når operators-tabellen er TOM. Efter første brug er den
 *      inert, uanset om hemmeligheden bliver liggende — så et glemt token er
 *      ikke en åben bagdør.
 *
 * Vil man skifte operatør-kode bagefter, bruges operatorChangePassword, som
 * kræver at man er logget ind.
 */
export async function bootstrapOperator(env, email, password, clientHash) {
  const master = masterStub(env);
  const st = await master.status();
  if (Number(st.operators) > 0) {
    return {
      ok: false,
      error: 'Der findes allerede en operatør. Brug operatorChangePassword i stedet.'
    };
  }
  const e = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'Ugyldig e-mail' };

  // Klienten sender normalt sha256(password) som clientHash. Ved bootstrap er
  // det nemmere at sende adgangskoden direkte fra en terminal, så vi accepterer
  // begge — men kræver en rimelig længde, fordi dette er systemets mest
  // privilegerede konto.
  let hash = String(clientHash || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    const pw = String(password || '');
    if (pw.length < 12) {
      return { ok: false, error: 'Adgangskoden skal være mindst 12 tegn' };
    }
    hash = await sha256hex(pw);
  }

  const pf = await newPasswordFields(hash, pwIterations(env));
  await master.putOperator(e, pf.passwordHash, pf.pwSalt);
  await master.audit(e, 'operatoer-bootstrappet', '', '');
  return { ok: true, email: e };
}

/** Operatøren skifter sin egen adgangskode. Kræver gyldigt operatør-token. */
export async function operatorChangePassword(ctx) {
  const { env, operator, p } = ctx;
  const master = masterStub(env);
  const op = await master.getOperator(operator.email);
  if (!op) return { ok: false, error: 'Operatøren findes ikke' };

  if (!await verifyHash(String(p.oldHash || ''), op.pwSalt, op.passwordHash)) {
    return { ok: false, error: 'Den gamle adgangskode passer ikke.' };
  }
  const ny = String(p.newHash || '');
  if (!/^[0-9a-f]{64}$/.test(ny)) return { ok: false, error: 'Ugyldig ny adgangskode.' };
  if (ny === String(p.oldHash || '')) {
    return { ok: false, error: 'Den nye adgangskode skal være forskellig fra den gamle.' };
  }

  const pf = await newPasswordFields(ny, pwIterations(env));
  await master.putOperator(operator.email, pf.passwordHash, pf.pwSalt);
  await master.audit(operator.email, 'operatoer-kode-skiftet', '', '');
  // Udestående operatør-tokens forbliver gyldige indtil de udløber (8 timer).
  // Det afviger fra medlems-tokens, som dør ved kodeskift via pwFp — operatøren
  // har ingen tilsvarende fingerprint-mekanisme. Værd at vide hvis en kode
  // skiftes fordi den er kompromitteret: skift MASTER_SECRET for at dræbe alle
  // tokens med det samme.
  return { ok: true, bemaerk: 'Udestående operatør-sessioner udløber inden for 8 timer.' };
}

/**
 * adminResetMemberPassword — operatøren nulstiller et medlems kode.
 *
 * Findes ved SIDEN af resetPassword (som en band-admin bruger), fordi
 * operatøren ikke er medlem af bandet og derfor ikke har en admin-session der.
 * Frontenden identificerer medlemmet ved e-mail, ikke id (09-boot.js:1182) —
 * operatøren ser bandets medlemsliste udefra og har ikke id'erne.
 */
export async function adminResetMemberPassword(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.bandId || p.targetBandId || '').trim();
  const email = String(p.memberEmail || p.email || '').toLowerCase().trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  if (!email) return { ok: false, error: 'memberEmail mangler' };

  const band = bandStub(env, bandId);
  const m = await band.findMemberByEmail(email);
  if (!m) return { ok: false, error: 'Ingen bruger med den email' };

  const tempPassword = genTempPassword();
  const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
  const r = await band.setMemberPassword(m.id, pf.passwordHash, pf.pwSalt, true);
  if (!r.ok) return { ok: false, error: 'Kunne ikke nulstille' };

  // Som resetPassword: koden er delt på tværs af musikerens bands, så
  // nulstillingen skrives ud til dem alle.
  const { syncPasswordAcrossBands } = await import('../auth/identity.js');
  await syncPasswordAcrossBands(env, email, pf, bandId);

  await masterStub(env).audit(operator.email, 'kode-nulstillet', bandId, email);
  // Feltnavnet er seedPassword, fordi 09-boot.js:1183 læser netop det.
  return { ok: true, seedPassword: tempPassword };
}

/**
 * operatorListMembers — bandets medlemmer set udefra.
 *
 * Findes fordi operatøren ellers arbejder i blinde: `adminResetMemberPassword`
 * og `operatorSetMemberRole` identificerer folk på e-mail, og operatøren er
 * ikke medlem af bandet og har derfor ingen liste at slå op i.
 *
 * Returnerer KUN det panelet skal bruge — navn, e-mail, rolle. Ikke telefon,
 * adresse eller kontonummer: operatøren skal kunne udpege en administrator,
 * ikke læse bandets persondata.
 */
export async function operatorListMembers(ctx) {
  const { env, p } = ctx;
  const bandId = String(p.bandId || p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };

  const bandRow = await masterStub(env).getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  const alle = await bandStub(env, bandId).listMembers();
  return {
    ok: true,
    members: alle.map(m => ({
      id: m.id, name: m.name, email: m.email, role: m.role
    }))
  };
}

/**
 * operatorSetMemberRole — udpeger eller fjerner en administrator.
 *
 * Baggrunden: et band oprettes med en admin ud fra de oplysninger vi har på
 * det tidspunkt, fx `jesper@dmdt.dk`. Når medlemmerne senere er lagt ind, viser
 * det sig at samme person i virkeligheden hedder `jesper@steensbeck.dk`.
 * Uden denne action skulle pladsholderen logge ind for at forfremme sig selv —
 * altså skulle nogen kende en kode til en konto der ikke burde findes.
 *
 * Bandet kan have flere administratorer; det er ikke en udskiftning men en
 * rolleændring. Fjern pladsholder-medlemmet bagefter fra bandets eget
 * admin-panel (Medlemmer → Slet), hvor sletningen også rydder deltagelser og
 * login-log.
 */
export async function operatorSetMemberRole(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.bandId || p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };

  const rolle = String(p.role || '').trim();
  if (rolle !== 'admin' && rolle !== 'member') {
    return { ok: false, error: 'Rollen skal være "admin" eller "member"' };
  }

  const master = masterStub(env);
  const bandRow = await master.getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  const band = bandStub(env, bandId);
  const alle = await band.listMembers();

  // Panelet sender id; e-mail accepteres også, så action'en kan bruges i hånden.
  const id = String(p.memberId || '').trim();
  const email = String(p.memberEmail || '').toLowerCase().trim();
  const maal = id ? alle.find(m => m.id === id)
             : email ? alle.find(m => String(m.email).toLowerCase() === email)
             : null;
  if (!maal) return { ok: false, error: 'Medlemmet findes ikke i bandet' };

  if (maal.role === rolle) {
    return { ok: true, uaendret: true, member: { id: maal.id, email: maal.email, role: rolle } };
  }

  // Et band uden administrator kan ikke administreres af nogen — hverken
  // medlemmer eller operatøren, som ikke kan gemme kontrakter og honorar.
  // Genoprettelsen ville kræve netop denne action, så tilstanden er en
  // blindgyde vi nægter at gå ind i.
  if (rolle === 'member') {
    const antalAdmins = alle.filter(m => m.role === 'admin').length;
    if (antalAdmins <= 1) {
      return {
        ok: false,
        error: 'Bandet ville stå uden administrator. Udpeg en anden først.'
      };
    }
  }

  const r = await band.updateMember(maal.id, { role: rolle });
  if (!r.ok) return { ok: false, error: 'Kunne ikke ændre rollen' };

  await master.audit(operator.email, 'rolle-aendret', bandId,
    maal.email + ': ' + maal.role + ' → ' + rolle);

  return { ok: true, member: { id: maal.id, email: maal.email, role: rolle } };
}

/**
 * runRetentionNow — kører den natlige oprydning med det samme.
 *
 * Samme arbejde som cron'en, men på forlangende. Nyttigt når man netop har
 * sænket et bands opbevaringspolitik og vil se effekten frem for at vente til
 * 02:00.
 */
export async function runRetentionNow(ctx) {
  const { env, operator } = ctx;
  const { scheduled } = await import('../scheduled.js');
  const r = await scheduled({ scheduledTime: Date.now(), cron: 'manuel' }, env, null);
  await masterStub(env).audit(operator.email, 'oprydning-koert-manuelt', '', '');
  return {
    ok: true,
    // scheduled() logger detaljerne; her returneres nok til at UI'et kan bekræfte.
    bemaerk: 'Oprydningen er kørt. Se wrangler tail for tal pr. band.',
    resultat: r || null
  };
}

/** listTenants — én forespørgsel mod master, uafhængigt af antal bands. */
export async function listTenants(ctx) {
  const rows = await ctx.master.listBands();
  const tenants = rows.map(r => ({
    bandId: r.bandId, name: r.name, status: r.status,
    crossBand: !!Number(r.crossBand), booking: !!Number(r.booking),
    statMembers: Number(r.statMembers) || 0,
    statUpcoming: Number(r.statUpcoming) || 0,
    statSyncedAt: r.statSyncedAt || '',
    createdAt: r.createdAt
  }));
  return { ok: true, tenants };
}

/**
 * registerTenant. Meget enklere end i Apps Script: ingen SpreadsheetApp.create,
 * ingen Drive-mapper, ingen setupSheet. Objektet opretter sit eget skema ved
 * første adgang.
 */
export async function registerTenant(ctx) {
  const { env, p, operator } = ctx;
  // Frontenden sender newBandId — samme navn som Apps Script har brugt hele
  // tiden (actRegisterTenant). bandId er selvtestens navn og accepteres som
  // alias; læses kun newBandId, kan operatøren IKKE oprette et band fra UI'et.
  const bandId = String(p.newBandId || p.bandId || '').trim().toLowerCase();
  const bandName = String(p.bandName || '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(bandId)) {
    return { ok: false, error: 'band-id må kun indeholde små bogstaver, tal og bindestreg (2-40 tegn)' };
  }
  if (!bandName) return { ok: false, error: 'bandName mangler' };
  // __operator og __booker er reserverede route-værdier i frontenden.
  if (bandId.startsWith('__')) return { ok: false, error: 'band-id må ikke starte med __' };

  const master = masterStub(env);
  const r = await master.createBand(bandId, bandName);
  if (!r.ok) return r;

  const band = bandStub(env, bandId);
  await band.init(r.meta);

  // Seed settings fra defaults, så et nyt band har et brugbart udgangspunkt.
  const seed = Object.assign({}, SETTINGS_DEFAULTS, { bandName });
  delete seed.seedPassword;
  await band.putSettings(seed, ALL_SETTINGS_KEYS);

  // Skabelon: kopiér udseende fra et eksisterende band. Kun branding — ikke
  // kontaktinfo, bank, CPR eller assets, som er bandspecifikke.
  if (p.templateBandId) {
    try {
      const tpl = await bandStub(env, String(p.templateBandId).trim()).getSettings();
      const KOPI = ['theme', 'primaryColor', 'primaryColorSoft', 'primaryColorDeep',
                    'bgColor', 'bgColorCard', 'bgColorRaised', 'borderColor',
                    'textColor', 'textColorDim', 'textColorMute',
                    'fontUi', 'fontDisplay', 'riderTemplates', 'bandTagline'];
      const changes = {};
      for (const k of KOPI) if (tpl[k] !== undefined && String(tpl[k]) !== '') changes[k] = tpl[k];
      if (Object.keys(changes).length) await band.putSettings(changes, ALL_SETTINGS_KEYS);
    } catch (e) {
      console.warn('Skabelon-kopiering fejlede (band oprettet uden skabelon): ' + (e && e.message || e));
    }
  }

  // Admin-bruger med sin egen tilfældige startkode.
  let tempPassword = null;
  if (p.adminEmail && p.adminName) {
    const email = String(p.adminEmail).toLowerCase().trim();
    tempPassword = genTempPassword();
    const pf = await newPasswordFields(await sha256hex(tempPassword), pwIterations(env));
    const id = 'm' + await band.nextCounter('member');
    await band.insertMember({
      id, name: String(p.adminName).trim(), category: 'Musiker', instrument: '',
      phone: '', email, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 1, role: 'admin', createdAt: new Date().toISOString()
    });
    const reg = await registerIdentity(env, email, bandId, pf);
    // Har personen allerede en konto andetsteds, gælder deres eksisterende kode.
    if (reg.havdeIdentitetFoer) {
      await band.setMemberPassword(id, reg.identitet.passwordHash, reg.identitet.pwSalt, false);
      tempPassword = null;
    }
  }

  await master.audit(operator.email, 'band-oprettet', bandId,
    bandName + (p.templateBandId ? (' (skabelon: ' + p.templateBandId + ')') : ''));

  // Onboarding-email. Operatør-panelet har et hak til den (09-boot.js sender
  // sendOnboardingEmail + loginUrl), og uden dette blok gjorde hakket ingenting.
  //
  // Fire-and-forget: en mislykket mail må ikke fortryde et oprettet band. Vi
  // rapporterer i stedet om den blev sendt, så operatøren ved om koden skal
  // gives videre manuelt.
  let emailSendt = false;
  if (p.sendOnboardingEmail && p.adminEmail && tempPassword) {
    try {
      const loginUrl = String(p.loginUrl || '').trim();
      await sendMail(env, {
        to: String(p.adminEmail).trim(),
        subject: 'Velkommen til ' + bandName + ' – din band-app',
        text: [
          'Hej' + (p.adminName ? ' ' + String(p.adminName).trim() : '') + ',',
          '',
          'Der er oprettet en band-app til ' + bandName + ', og du er sat op som administrator.',
          '',
          loginUrl ? ('Log ind her:\n' + loginUrl) : ('Band-id: ' + bandId),
          '',
          'Email: ' + String(p.adminEmail).trim(),
          'Midlertidig adgangskode: ' + tempPassword,
          '',
          'Du bliver bedt om at vælge en ny adgangskode første gang du logger ind.',
          '',
          'God fornøjelse!'
        ].join('\n')
      });
      emailSendt = true;
      await master.audit(operator.email, 'onboarding-email-sendt', bandId,
        String(p.adminEmail).trim());
    } catch (e) {
      console.warn('Onboarding-email fejlede (band oprettet alligevel): ' +
                   (e && e.message || e));
    }
  }

  const svar = { ok: true, bandId, name: bandName, emailSent: emailSendt };
  if (tempPassword) svar.seedPassword = tempPassword;
  else if (p.adminEmail) svar.eksisterendeBruger = true;
  return svar;
}

/**
 * updateTenant. Flagene har master som kilde til sandhed, men SKAL spejles til
 * band-objektet — ellers ville hvert getConfig-kald skulle slå op i master, og
 * master ville blive et globalt serialiseringspunkt.
 */
export async function updateTenant(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };

  const master = masterStub(env);
  const eksisterende = await master.getBand(bandId);
  if (!eksisterende) return { ok: false, error: 'Ukendt band: ' + bandId };

  const patch = {};
  const spejl = {};
  if (p.bandName) { patch.name = String(p.bandName); spejl.name = patch.name; }
  const bool = v => (v === true || v === 'true' || v === 1 || v === '1');
  if (p.crossBand !== undefined) { patch.crossBand = bool(p.crossBand) ? 1 : 0; spejl.cross_band = patch.crossBand; }
  if (p.booking !== undefined) { patch.booking = bool(p.booking) ? 1 : 0; spejl.booking = patch.booking; }
  if (p.rootFolderId !== undefined) patch.rootFolderId = String(p.rootFolderId);
  if (!Object.keys(patch).length) return { ok: false, error: 'Ingen felter at opdatere' };

  await master.updateBand(bandId, patch);

  const band = bandStub(env, bandId);
  if (Object.keys(spejl).length) await band.syncMeta(spejl);
  // Bandnavnet skal også med i bandets egne settings, ellers følger branding
  // (sidetitel, login-skærm) ikke omdøbningen.
  if (patch.name) await band.putSettings({ bandName: patch.name }, ALL_SETTINGS_KEYS);

  if (p.crossBand !== undefined) {
    await master.audit(operator.email,
      patch.crossBand ? 'crossband-slaaet-til' : 'crossband-slaaet-fra', bandId, '');
  }
  if (p.booking !== undefined) {
    await master.audit(operator.email,
      patch.booking ? 'booking-slaaet-til' : 'booking-slaaet-fra', bandId, '');
  }
  return { ok: true };
}

/**
 * setTenantStatus. Et suspenderet band kan ikke logges ind i, men dataen er
 * urørt — operatøren kan genaktivere.
 */
export async function setTenantStatus(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.targetBandId || '').trim();
  const status = String(p.status || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
  if (status !== 'active' && status !== 'suspended') {
    return { ok: false, error: 'Ugyldig status (active/suspended)' };
  }
  const master = masterStub(env);
  if (!await master.getBand(bandId)) return { ok: false, error: 'Ukendt band: ' + bandId };

  await master.updateBand(bandId, { status });
  // Spejlingen er det der faktisk blokerer login — login læser status fra
  // band-objektet, ikke fra master.
  await bandStub(env, bandId).syncMeta({ status });
  await master.audit(operator.email,
    status === 'suspended' ? 'band-sat-paa-pause' : 'band-genaktiveret', bandId, '');
  return { ok: true, status };
}

/**
 * bandHealth. Faresignaler operatøren bør reagere på — plus de to
 * produktionstjek der ikke kan laves lokalt.
 */
export async function bandHealth(ctx) {
  const { env, p } = ctx;
  // BEGGE navne accepteres. Operatør-panelet sender `bandId` (09-boot.js:286),
  // mens listens egne knapper sender `targetBandId`. Læste vi kun det ene,
  // svarede bandlisten "Kunne ikke hente status" for hvert eneste band — og
  // fejlen lignede et nedbrud i datalaget frem for et forkert parameternavn.
  const bandId = String(p.targetBandId || p.bandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  const master = masterStub(env);
  const bandRow = await master.getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  const band = bandStub(env, bandId);
  const h = await band.health();

  // Panelets feltnavne. BandDO.health() taler dansk internt (`medlemmer`,
  // `naesteGig`), og selvtesten læser de navne — men 09-boot.js læser engelske.
  // Uden denne oversættelse stod der `undefined medlemmer` på hvert kort, og
  // ALLE opsætnings-badges viste "mangler", fordi hasLogo/hasRider/hasBank
  // aldrig har eksisteret og derfor faldt i else-grenen (09-boot.js:303).
  // Det så ud som om bandet manglede logo og rider; det gjorde det ikke.
  //
  // Revisionen fanger det ikke: audit-actions.mjs sammenligner action-navne og
  // REQUEST-parametre, aldrig svarfelter. Samme fejlklasse, ny retning.
  const s = await band.getSettings();
  const antalAssets = k => Number((h.assets || {})[k] || 0);

  return {
    ok: true,
    health: Object.assign({}, h, {
      members: h.medlemmer,
      nextGig: h.naesteGig,
      hasLogo: antalAssets('logo') > 0,
      // Samme betingelse som getRider (settings.js:205) lykkes under: en
      // uploadet PDF ELLER en rider-tekst. Kræver vi PDF'en, ville et band der
      // bruger tekst-rideren stå som mangelfuldt.
      hasRider: antalAssets('rider') > 0 || String(s.riderText || '').trim() !== '',
      hasBank: String(s.bankKto || '').trim() !== '',
      warnings: {
        noAdmin: Number(h.admins || 0) === 0,
        orphanAttendances: Number(h.forældreløseDeltagere || 0),
        overdueInvoices: Number(h.forfaldneFakturaer || 0)
      },
      bandId,
      name: bandRow.name,
      status: bandRow.status,
      crossBand: !!Number(bandRow.crossBand),
      booking: !!Number(bandRow.booking),
      hasCpr: !!bandRow.cprEnc,
      // Produktionstjek. EU-jurisdiktionen kan ikke verificeres lokalt, og den
      // er en del af objektets identitet — den kan ikke ændres bagefter uden at
      // bandet mister sine data. Appen gemmer CPR, så den SKAL være aktiv.
      euJurisdiktion: jurisdictionActive(env),
      skemaForventet: BAND_SCHEMA_VERSION
    })
  };
}

export async function getAuditLog(ctx) {
  const entries = await ctx.master.getAuditLog(
    Math.min(500, Number(ctx.p.limit) || 200),
    ctx.p.targetBandId ? String(ctx.p.targetBandId) : null);
  return { ok: true, entries };
}

/**
 * backupBand. JSON-dump af alle bandets rækker.
 *
 * Den EGENTLIGE backup er Durable Objects' point-in-time recovery, som kan
 * gendanne til et vilkårligt tidspunkt 30 dage tilbage. Denne eksport er til
 * at flytte data ud af systemet, ikke til at redde det.
 */
export async function backupBand(ctx) {
  // Se bandHealth: panelet sender `bandId`.
  const bandId = String(ctx.p.targetBandId || ctx.p.bandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  const dump = await bandStub(ctx.env, bandId).exportAll();
  return {
    ok: true,
    bandId,
    exportedAt: new Date().toISOString(),
    bemaerk: 'Den egentlige backup er point-in-time recovery 30 dage tilbage. ' +
             'Denne eksport er til at flytte data ud af systemet.',
    data: dump
  };
}

/**
 * migrateAllBands. Pinger hvert bands objekt, så skemaløft sker med det samme
 * frem for at vente på at bandet får trafik.
 *
 * Nødvendig fordi der ikke findes nogen samlet migreringskommando: hvert objekt
 * løfter sig selv ved første adgang.
 */
export async function migrateAllBands(ctx) {
  const { env } = ctx;
  const bands = await masterStub(env).listBands();
  const svar = await Promise.allSettled(bands.map(async b => {
    const st = await bandStub(env, b.bandId).status();
    return { bandId: b.bandId, schemaVersion: st.schemaVersion };
  }));
  const ok = [], fejl = [];
  svar.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else fejl.push({ bandId: bands[i].bandId, error: String(r.reason && r.reason.message || r.reason) });
  });
  return {
    ok: true,
    forventet: BAND_SCHEMA_VERSION,
    loeftede: ok,
    fejlede: fejl,
    ikkeOpdaterede: ok.filter(b => b.schemaVersion !== BAND_SCHEMA_VERSION)
  };
}

/**
 * deleteTenant. Fjerner bandet fra registret og rydder dets objekt.
 *
 * Objektets lager slettes eksplicit — et Durable Object forsvinder ikke af sig
 * selv, og efterladt data ville stadig tælle mod lagringskvoten og stadig
 * indeholde persondata.
 */
export async function deleteTenant(ctx) {
  const { env, p, operator } = ctx;
  // KUN operatøren kan slette et band. `adminDeleteBand`, som lod bandets egen
  // admin gøre det, er fjernet 30/8 — se actions/index.js.
  //
  // Begge parameternavne læses stadig: operatør-panelet sender `bandId` fra
  // bandlisten (09-boot.js) og `targetBandId` fra kortets egen knap. Læste vi
  // kun det ene, ville sletning fejle fra det ene sted uden forklaring — samme
  // fejlklasse som bandHealth havde.
  const bandId = String(p.targetBandId || p.bandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  // Kræver eksplicit bekræftelse med bandets eget id, så et fejlklik i en liste
  // ikke kan slette et band permanent.
  if (String(p.confirm || '') !== bandId) {
    return { ok: false, error: 'Bekræft sletning ved at sende confirm = band-id' };
  }
  const master = masterStub(env);
  const bandRow = await master.getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  try {
    await bandStub(env, bandId).wipe();
  } catch (e) {
    console.error('Kunne ikke rydde band-objektet for ' + bandId + ': ' + (e && e.message || e));
    return { ok: false, error: 'Kunne ikke rydde bandets data — intet er slettet. Fejlen er logget.' };
  }
  // Bandets fakturaer ligger uden for Durable Object'et og overlever derfor
  // wipe(). De indeholder CPR, så de skal væk sammen med resten — ellers ville
  // "slet band permanent" efterlade det mest følsomme data intakt.
  let arkiv = { deleted: 0 };
  try {
    const { deleteBandArchive } = await import('../services/archive.js');
    arkiv = await deleteBandArchive(env, bandId);
  } catch (e) {
    // Bandet ER slettet på dette tidspunkt; at fejle her ville efterlade en
    // halvt slettet tilstand. Advar i stedet, så nogen kan rydde op.
    console.error('deleteTenant: kunne ikke tømme arkivet for ' + bandId + ': ' +
                  (e && e.stack || e));
    await master.deleteBand(bandId, operator.email, bandRow.name);
    await master.audit(operator.email, 'band-SLETTET-permanent', bandId, bandRow.name);
    return {
      ok: true,
      warning: 'Bandet er slettet, men fakturaarkivet kunne ikke tømmes. Fejlen er logget — arkivet skal ryddes manuelt.'
    };
  }

  await master.deleteBand(bandId, operator.email, bandRow.name);
  await master.audit(operator.email, 'band-SLETTET-permanent', bandId, bandRow.name);
  return { ok: true, arkivfilerSlettet: arkiv.deleted || 0 };
}
