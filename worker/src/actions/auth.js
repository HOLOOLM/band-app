// Fase 3a — auth- og config-actions.
//
// Svarformerne er BIT-FOR-BIT som i dag. Frontenden ændres ikke, så hvert felt
// her har en aftager i public/js: `member`, `forcePasswordChange`, `role` og
// `memberToken` læses af 02-auth.js, og `config` af 01-core.js.

import { sha256hex, pwIterations, newPasswordFields } from '../lib/crypto.js';
import { issueToken, authFingerprint, MEMBER_TOKEN_TTL_SEC } from '../lib/tokens.js';
import { PUBLIC_CONFIG_KEYS, SETTINGS_DEFAULTS } from '../lib/settings-defaults.js';
import { verifyMember, verifyMemberAndMaybeRehash, publicMember } from '../auth/verify.js';
import { userError } from '../lib/errors.js';

// Rate-limit: 5 fejlede forsøg pr. e-mail → 15 min. Uændret fra Code.gs:1604.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SEC = 15 * 60;

async function memberToken(env, email, m) {
  return issueToken(env, 'member', {
    email,
    pwFp: await authFingerprint(sha256hex, m.passwordHash)
  }, MEMBER_TOKEN_TTL_SEC);
}

/** Fælles svarform for login og refreshSession. */
async function authSvar(env, email, m) {
  return {
    ok: true,
    member: publicMember(m),
    forcePasswordChange: !!Number(m.forcePasswordChange),
    role: m.role || 'member',
    // Workeren beholder tokenet server-side; det når aldrig browseren.
    memberToken: await memberToken(env, email, m)
  };
}

/**
 * login. Bemærk rækkefølgen: suspenderet band tjekkes FØRST, dernæst lockout,
 * og først derefter selve verifikationen. Det er samme rækkefølge som
 * Code.gs:1611 og betyder at et suspenderet band ikke kan bruges til at
 * afprøve passwords.
 */
export async function login(ctx) {
  const { env, band, p } = ctx;
  const email = String(p.email || '').toLowerCase().trim();

  const cfg = await band.getPublicConfig(PUBLIC_CONFIG_KEYS);
  if (cfg.status === 'suspended') {
    return { ok: false, error: 'Dette band er midlertidigt deaktiveret. Kontakt din administrator.' };
  }

  const st = await band.loginAttemptState(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
  if (st.locked) {
    return { ok: false, error: 'For mange mislykkede forsøg. Prøv igen om 15 minutter.' };
  }

  const m = await verifyMemberAndMaybeRehash(env, band, email, p.passwordHash);
  if (!m) {
    const nu = await band.penalizeLogin(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
    if (nu.locked) {
      return { ok: false, error: 'For mange mislykkede forsøg. Kontoen er låst i 15 minutter.' };
    }
    return {
      ok: false,
      error: 'Forkert email eller adgangskode. ' + nu.remaining + ' forsøg tilbage.'
    };
  }

  await band.clearLoginAttempts(email);
  return authSvar(env, email, m);
}

/**
 * refreshSession. Kaldes af Workerens /api/session når en fane genindlæses.
 *
 * Tæller BEVIDST ikke mod lockout. Et udløbet mt:-token er en normal hændelse
 * (8 timers TTL nået), ikke et forkert-password-gæt. Talte den med, kunne et
 * helt bands brugere låse deres egne konti ude ved at genindlæse samtidig efter
 * en nats pause. Samme begrundelse som Code.gs:1649.
 */
export async function refreshSession(ctx) {
  const { env, band, p } = ctx;
  const email = String(p.email || '').toLowerCase().trim();
  const m = await verifyMember(env, band, email, p.passwordHash);
  if (!m) return { ok: false, error: 'Session udløbet' };
  return authSvar(env, email, m);
}

/**
 * changePassword. Verificerer den GAMLE kode, før den nye sættes.
 *
 * setMemberPassword dræber alle sessioner for medlemmet i samme transaktion, og
 * fingeraftrykket i udestående tokens matcher nu det gamle password — så de er
 * ugyldige med det samme. Derfor udstedes et nyt token til den session der lige
 * skiftede, ellers ville brugeren blive smidt ud af sin egen handling.
 */
export async function changePassword(ctx) {
  const { env, band, p } = ctx;
  const email = String(p.email || '').toLowerCase().trim();

  const m = await verifyMember(env, band, email, p.oldHash);
  if (!m) return { ok: false, error: 'Den gamle adgangskode passer ikke.' };

  // Klienten sender sha256(password) som hex — 64 tegn. Samme tjek som i dag.
  const nyHash = String(p.newHash || '');
  if (nyHash.length !== 64 || !/^[0-9a-f]+$/.test(nyHash)) {
    return { ok: false, error: 'Ugyldig ny adgangskode.' };
  }
  if (nyHash === String(p.oldHash || '')) {
    return { ok: false, error: 'Den nye adgangskode skal være forskellig fra den gamle.' };
  }

  const pf = await newPasswordFields(nyHash, pwIterations(env));
  const r = await band.setMemberPassword(m.id, pf.passwordHash, pf.pwSalt, false);
  if (!r.ok) return { ok: false, error: 'Kunne ikke gemme adgangskoden.' };

  const opdateret = Object.assign({}, m, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt });
  return { ok: true, memberToken: await memberToken(env, email, opdateret) };
}

/**
 * trackLogin. Kræver gyldig auth — ellers kunne enhver skrive vilkårlige
 * rækker i et andet bands login-log, som ville lække ind i GDPR-eksporten for
 * den ramte e-mail. Samme begrundelse som Code.gs:1675.
 */
export async function trackLogin(ctx) {
  const { band, member, p } = ctx;
  await band.trackLogin(member.id, member.email, p.ua);
  return { ok: true };
}

/**
 * getConfig. Kaldes UDEN auth af login-skærmen, så svaret må kun indeholde
 * PUBLIC_CONFIG_KEYS. Defaults lægges under, så en manglende Settings-række
 * giver samme værdi som i dag frem for en tom streng.
 */
export async function getConfig(ctx) {
  const { band } = ctx;
  const r = await band.getPublicConfig(PUBLIC_CONFIG_KEYS);
  const config = r.config;
  for (const k of PUBLIC_CONFIG_KEYS) {
    if (!config[k]) config[k] = SETTINGS_DEFAULTS[k] || '';
  }
  return { ok: true, config };
}
