// Fase 3a — auth- og config-actions.
//
// Svarformerne er BIT-FOR-BIT som i dag. Frontenden ændres ikke, så hvert felt
// her har en aftager i public/js: `member`, `forcePasswordChange`, `role` og
// `memberToken` læses af 02-auth.js, og `config` af 01-core.js.

import { sha256hex, pwIterations, newPasswordFields } from '../lib/crypto.js';
import { issueToken, authFingerprint, MEMBER_TOKEN_TTL_SEC } from '../lib/tokens.js';
import { PUBLIC_CONFIG_KEYS, MEMBER_CONFIG_KEYS, SETTINGS_DEFAULTS }
  from '../lib/settings-defaults.js';
import { verifyMember, verifyMemberAndMaybeRehash, publicMember } from '../auth/verify.js';
import { syncPasswordAcrossBands } from '../auth/identity.js';
import { userError } from '../lib/errors.js';
import { weakPasswordError } from '../lib/weak-passwords.js';

// Rate-limit: 5 fejlede forsøg pr. e-mail → 15 min. Uændret fra Code.gs:1604.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SEC = 15 * 60;

/**
 * Band-bredt loft mod password spraying: 60 fejlede login pr. 15 min, uanset
 * hvor mange forskellige e-mails de rammer.
 *
 * Tallet er valgt så det ikke kan udløses ved uheld. Et band har 5-30
 * medlemmer; 60 fejl på et kvarter er langt over hvad en dårlig aften på et
 * spillesteds delte WiFi producerer. Samtidig gør det spraying dyrt: en
 * angriber skal holde sig under 60 forsøg i kvarteret OG under IP-loftet.
 *
 * Bevidst ikke lavere: en band-bred spærring er også et DoS-håndtag mod
 * bandet. Vinduet glider, så bandet er automatisk frit igen efter ≤15 min.
 */
const SPRAY_HARD_LIMIT = 60;
const SPRAY_WINDOW_SEC = 15 * 60;

/**
 * Én besked til alle login-fejl der ikke er en spærring.
 *
 * Forskellige tekster for "ukendt bruger", "forkert kode", "suspenderet band"
 * og "N forsøg tilbage" var tilsammen et orakel: man kunne kortlægge hvilke
 * konti og bands der findes uden nogensinde at gætte rigtigt.
 */
const LOGIN_FEJL = 'Forkert email eller adgangskode.';

// Spærringsbeskeden er BEVIDST den samme uanset om det er kontoen eller hele
// bandet der er spærret. Forskellige tekster ville fortælle en angriber om
// deres spray blev opdaget.
const LAAST_FEJL = 'For mange mislykkede forsøg. Prøv igen om 15 minutter.';

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
    // Samme generiske besked som en forkert kode. Den gamle, specifikke tekst
    // kom FØR enhver credential-kontrol og var derfor et gratis orakel på
    // bandets tilstand for enhver der kendte et bandId.
    return { ok: false, error: LOGIN_FEJL };
  }

  const st = await band.loginAttemptState(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
  if (st.locked) {
    // Tæl OGSÅ med i spray-tælleren. Et forsøg mod en låst konto er stadig et
    // fejlet loginforsøg mod bandet, og uden dette kunne en angriber skjule sig
    // bag per-e-mail-låsene: de fyrer først, og returnerede man her, ville den
    // band-brede tæller aldrig bevæge sig.
    await band.penalizeSpray(SPRAY_HARD_LIMIT, SPRAY_WINDOW_SEC);
    return { ok: false, error: LAAST_FEJL };
  }

  // Band-bred spærring mod password spraying. Se sprayState i do/band.js:
  // per-e-mail-låsen dækker ét offer ad gangen, så én kode prøvet mod alle
  // konti i bandet ramte aldrig nogen grænse.
  const spray = await band.sprayState(SPRAY_HARD_LIMIT, SPRAY_WINDOW_SEC);
  if (spray.blocked) {
    return { ok: false, error: LAAST_FEJL };
  }

  const m = await verifyMemberAndMaybeRehash(env, band, email, p.passwordHash);
  if (!m) {
    // Tæl spray-forsøget op uanset om e-mailen findes. Netop ukendte e-mails er
    // hvad spraying består af.
    await band.penalizeSpray(SPRAY_HARD_LIMIT, SPRAY_WINDOW_SEC);
    const nu = await band.penalizeLogin(email, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_SEC);
    if (nu.locked) {
      return { ok: false, error: 'For mange mislykkede forsøg. Kontoen er låst i 15 minutter.' };
    }
    // Uden "N forsøg tilbage": tallet fortalte en angriber præcis hvornår
    // spærringen indtræder, så de kunne køre fire forsøg og holde pause i
    // stedet for nogensinde at udløse den.
    return { ok: false, error: LOGIN_FEJL };
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
  // ctx.bandId bruges til password-sync nedenfor.
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
  // Serveren ser kun sha256 og kan derfor ikke måle længde — men den kan
  // genkende hashen af de koder folk oftest vælger. Se lib/weak-passwords.js.
  const svag = weakPasswordError(nyHash);
  if (svag) return { ok: false, error: svag };

  const pf = await newPasswordFields(nyHash, pwIterations(env));
  const r = await band.setMemberPassword(m.id, pf.passwordHash, pf.pwSalt, false);
  if (!r.ok) return { ok: false, error: 'Kunne ikke gemme adgangskoden.' };

  // SSO: ét password gælder alle bands musikeren spiller i. Skrives ud til de
  // øvrige, og den kanoniske hash lægges i master. Et delvist resultat må IKKE
  // fejle handlingen — koden er skiftet her, og en fejl ville efterlade brugeren
  // i tvivl om, om skiftet gik igennem. Se auth/identity.js for hvorfor
  // relationen er vendt om i forhold til Apps Script-originalen.
  await syncPasswordAcrossBands(env, email, pf, ctx.bandId);

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

/**
 * getBandInfo — resten af bandets ikke-hemmelige konfiguration, for medlemmer.
 *
 * Kontakt- og teknikoplysninger plus rider-skabeloner lå før i getConfig, som
 * er uautentificeret. Frontenden bruger dem i kontrakt- og rider-rendering
 * (_brandify i public/js/07-calendar-pdf.js), og henter dem derfor her efter
 * login i stedet.
 *
 * Bankoplysninger er IKKE med — de kræver admin og hentes med
 * adminGetBillingInfo.
 */
export async function getBandInfo(ctx) {
  const { band } = ctx;
  const r = await band.getPublicConfig(MEMBER_CONFIG_KEYS);
  const config = r.config;
  for (const k of MEMBER_CONFIG_KEYS) {
    if (!config[k]) config[k] = SETTINGS_DEFAULTS[k] || '';
  }
  return { ok: true, config };
}
