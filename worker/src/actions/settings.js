// Fase 3i — settings, branding, bankoplysninger og assets.
//
// To ting er flyttet i forhold til Apps Script:
//   1. ASSETS fra Drive til bandets egen database. Ingen Drive-tilladelser, og
//      logoet kan læses på getConfig-stien uden CPU-arbejde.
//   2. CPR fra Script Properties til masters bands-række, krypteret med AES-GCM
//      under CPR_KEY. Nøglen er en Worker-hemmelighed og ligger ikke i data.
//
// CPR returneres ALDRIG. Kun et boolean om hvorvidt det er gemt — hele grunden
// til at fakturaer renderes server-side er, at nummeret ikke må nå browseren.

import { SETTINGS_DEFAULTS, ALL_SETTINGS_KEYS, PUBLIC_CONFIG_KEYS, BILLING_CONFIG_KEYS }
  from '../lib/settings-defaults.js';
import { encryptCpr } from '../lib/crypto.js';
import { masterStub } from '../lib/addressing.js';

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const GYLDIGE_ASSET_KINDS = ['logo', 'rider', 'sceneplan'];

// Tema- og fontværdier skal matche THEMES og FONT_OPTIONS i public/js/01-core.js.
const VALID_THEMES = ['kul', 'grafit', 'beton', 'stål', 'tåge'];
const VALID_FONTS = ['Inter', 'Space Grotesk', 'IBM Plex Sans', 'Instrument Serif',
                     'IBM Plex Serif', 'Fraunces'];
const HEX_KEYS = [
  'primaryColor', 'primaryColorSoft', 'primaryColorDeep',
  'bgColor', 'bgColorCard', 'bgColorRaised', 'borderColor',
  'textColor', 'textColorDim', 'textColorMute'
];

/**
 * adminReadConfig — hele konfigurationen til operatør-/admin-UI'et.
 *
 * Modsat getConfig er dette bag auth, så bank- og Drive-felter må med. CPR er
 * fortsat udelukket: det ligger ikke i settings, og selv hvis det gjorde, må det
 * ikke sendes.
 */
export async function adminReadConfig(ctx) {
  const settings = await ctx.band.getSettings();
  const config = Object.assign({}, SETTINGS_DEFAULTS, settings);
  delete config.seedPassword;   // findes ikke længere som begreb, men vær sikker
  return { ok: true, config };
}

/**
 * adminWriteConfig — skriver vilkårlige settings-nøgler.
 *
 * Whitelisten er ALL_SETTINGS_KEYS, så en kalder ikke kan indføre nye nøgler.
 * HEX- og font-værdier valideres, fordi en ugyldig værdi ellers ville nå
 * frontendens CSS og give et ubrugeligt udseende uden nogen fejlbesked.
 */
export async function adminWriteConfig(ctx) {
  const { band, p } = ctx;
  const changes = p.changes;
  if (!changes || typeof changes !== 'object') return { ok: false, error: 'changes mangler' };

  const fejl = validerUdseende(changes);
  if (fejl) return { ok: false, error: fejl };

  const r = await band.putSettings(changes, ALL_SETTINGS_KEYS);
  if (!r.written) return { ok: false, error: 'Ingen gyldige nøgler i changes' };
  await audit(ctx, 'config-aendret', Object.keys(changes).filter(k => ALL_SETTINGS_KEYS.includes(k)).join(', '));
  return { ok: true, written: r.written };
}

/** adminSaveAppearance — tema, farver og fonte. Samme validering, snævrere sæt. */
export async function adminSaveAppearance(ctx) {
  const { band, p } = ctx;
  const felter = ['theme', 'fontUi', 'fontDisplay'].concat(HEX_KEYS);
  const changes = {};
  for (const k of felter) if (p[k] !== undefined) changes[k] = String(p[k]).trim();
  if (!Object.keys(changes).length) return { ok: false, error: 'Ingen ændringer sendt' };

  const fejl = validerUdseende(changes);
  if (fejl) return { ok: false, error: fejl };

  await band.putSettings(changes, ALL_SETTINGS_KEYS);
  return { ok: true };
}

/**
 * Validerer udseende-værdier. Tom streng er altid tilladt — den betyder
 * "ryd overstyringen og følg temaet".
 */
function validerUdseende(changes) {
  if (changes.theme && !VALID_THEMES.includes(changes.theme)) {
    return 'Ukendt tema: ' + changes.theme;
  }
  for (const k of HEX_KEYS) {
    const v = changes[k];
    if (v && !/^#[0-9A-Fa-f]{6}$/.test(String(v))) {
      return 'Ugyldig farve i ' + k + ' — brug hex-format #RRGGBB';
    }
  }
  for (const k of ['fontUi', 'fontDisplay']) {
    if (changes[k] && !VALID_FONTS.includes(changes[k])) {
      return 'Ukendt font i ' + k + ': ' + changes[k];
    }
  }
  if (changes.riderTemplates) {
    try {
      const o = JSON.parse(changes.riderTemplates);
      if (!o || typeof o !== 'object') return 'riderTemplates skal være et JSON-objekt';
    } catch (e) {
      return 'riderTemplates er ikke gyldig JSON';
    }
  }
  return null;
}

/** adminGetBillingInfo — bankoplysninger + om CPR er gemt (aldrig værdien). */
export async function adminGetBillingInfo(ctx) {
  const { env, band, bandId } = ctx;
  const settings = await band.getSettings();
  const bandRow = await masterStub(env).getBand(bandId);
  const billing = {};
  for (const k of BILLING_CONFIG_KEYS) billing[k] = settings[k] || '';
  billing.payeeName = settings.payeeName || '';
  billing.payeeAddress = settings.payeeAddress || '';
  billing.hasCpr = !!(bandRow && bandRow.cprEnc);
  return { ok: true, billing };
}

/**
 * adminSaveBillingInfo. CPR krypteres med AES-GCM og gemmes i masters
 * bands-række — ikke i bandets settings, hvor det ville ligge sammen med data
 * der læses ofte.
 *
 * Formatet valideres, fordi et forkert CPR først ville vise sig på en færdig
 * faktura hos SKAT.
 */
export async function adminSaveBillingInfo(ctx) {
  const { env, band, bandId, p } = ctx;

  if (p.cpr !== undefined && p.cpr !== '') {
    const cpr = String(p.cpr).trim();
    if (!/^\d{6}-?\d{4}$/.test(cpr)) {
      return { ok: false, error: 'Ugyldigt CPR-format — forventet DDMMYY-XXXX' };
    }
    const enc = await encryptCpr(env, cpr);
    await masterStub(env).updateBand(bandId, { cprEnc: enc });
  }

  const changes = {};
  for (const k of ['bankName', 'bankReg', 'bankKto', 'payeeName', 'payeeAddress']) {
    if (p[k] !== undefined) changes[k] = String(p[k]).trim();
  }
  if (Object.keys(changes).length) await band.putSettings(changes, ALL_SETTINGS_KEYS);

  const bandRow = await masterStub(env).getBand(bandId);
  await audit(ctx, 'bankoplysninger-aendret', Object.keys(changes).join(', '));
  return { ok: true, hasCpr: !!(bandRow && bandRow.cprEnc) };
}

/**
 * adminUploadAsset — logo, rider-PDF eller sceneplan.
 *
 * Gemmes i bandets egen database frem for Drive. Det fjerner Drive-tilladelser
 * fra billedet helt, og betyder at et asset er lige så isoleret som resten af
 * bandets data.
 */
export async function adminUploadAsset(ctx) {
  const { band, p } = ctx;
  const kind = String(p.kind || '').trim();
  if (!GYLDIGE_ASSET_KINDS.includes(kind)) {
    return { ok: false, error: 'Ukendt asset-type: ' + kind };
  }
  const b64 = String(p.dataBase64 || '');
  if (!b64) return { ok: false, error: 'dataBase64 kræves' };

  // base64 er ~4/3 af de rå bytes. Vi måler på den rå størrelse, så grænsen
  // betyder det samme som den gjorde for en Drive-fil.
  const raaBytes = Math.floor(b64.length * 3 / 4);
  if (raaBytes > MAX_ASSET_BYTES) {
    return {
      ok: false,
      error: 'Filen er for stor (' + Math.round(raaBytes / 1024 / 1024 * 10) / 10 +
             ' MB). Maks 5 MB.'
    };
  }

  const r = await band.putAsset(kind, p.contentType, b64);
  // Markørfelterne bevares, så getConfig's hasRider/hasSceneplan-flag og
  // frontendens eksisterende logik fortsat virker uden ændringer.
  const markoer = { logo: 'logoFileId', rider: 'riderFileId', sceneplan: 'sceneplanFileId' };
  await band.putSettings({ [markoer[kind]]: 'do:' + kind }, ALL_SETTINGS_KEYS);
  await audit(ctx, 'asset-uploadet', kind + ': ' + (p.filename || '') + ' (' + r.chunks + ' bidder)');
  return { ok: true, kind, chunks: r.chunks };
}

export async function adminDeleteAsset(ctx) {
  const { band, p } = ctx;
  const kind = String(p.kind || '').trim();
  if (!GYLDIGE_ASSET_KINDS.includes(kind)) return { ok: false, error: 'Ukendt asset-type' };
  await band.deleteAsset(kind);
  const markoer = { logo: 'logoFileId', rider: 'riderFileId', sceneplan: 'sceneplanFileId' };
  await band.putSettings({ [markoer[kind]]: '' }, ALL_SETTINGS_KEYS);
  await audit(ctx, 'asset-fjernet', kind);
  return { ok: true };
}

/**
 * getRider — for indloggede medlemmer. PDF har forrang; ellers rider-teksten.
 * Bevaret prioritering fra Code.gs:3651.
 */
export async function getRider(ctx) {
  const { band } = ctx;
  const asset = await band.getAsset('rider');
  if (asset) {
    return { ok: true, kind: 'pdf', name: 'rider.pdf',
             contentType: asset.mime, dataUrl: asset.dataUrl };
  }
  const settings = await band.getSettings();
  const text = String(settings.riderText || '').trim();
  if (text) return { ok: true, kind: 'text', text };
  return { ok: false, error: 'Ingen rider uploadet endnu' };
}

export async function getSceneplan(ctx) {
  const asset = await ctx.band.getAsset('sceneplan');
  if (!asset) return { ok: false, error: 'Ingen sceneplan uploadet endnu' };
  return { ok: true, name: 'sceneplan', contentType: asset.mime, dataUrl: asset.dataUrl };
}

/** Skriver til masters audit-log. Må aldrig vælte den egentlige handling. */
async function audit(ctx, handling, detalje) {
  try {
    const aktor = ctx.member ? ctx.member.email : (ctx.operator ? 'operatør' : 'system');
    await masterStub(ctx.env).audit(aktor, handling, ctx.bandId, detalje || '');
  } catch (e) {
    console.warn('Audit-skrivning fejlede (' + handling + '): ' + (e && e.message || e));
  }
}
