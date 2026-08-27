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
  const bandId = String(p.bandId || '').trim().toLowerCase();
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

  const svar = { ok: true, bandId, name: bandName };
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
  const bandId = String(p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
  const master = masterStub(env);
  const bandRow = await master.getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  const band = bandStub(env, bandId);
  const h = await band.health();

  return {
    ok: true,
    health: Object.assign({}, h, {
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
  const bandId = String(ctx.p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
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
  const bandId = String(p.targetBandId || '').trim();
  if (!bandId) return { ok: false, error: 'targetBandId mangler' };
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
  await master.deleteBand(bandId, operator.email, bandRow.name);
  await master.audit(operator.email, 'band-SLETTET-permanent', bandId, bandRow.name);
  return { ok: true };
}
