// Verifikation af hvem der kalder.
//
// Port af _verifyAuth (Code.gs:1327) og _requireAdmin (:1364), men med én
// vigtig forskel: gaten køres af routeren ud fra `auth`-feltet på hver action,
// FØR action-koden kaldes. I Apps Script lå _requireAdmin-kaldene spredt inde i
// hver action, hvor det var muligt at glemme et. Her er det umuligt: en action
// uden auth-felt kan ikke registreres.

import { sha256hex, verifyHash, needsRehash, pwIterations, newPasswordFields, pbkdf2 }
  from '../lib/crypto.js';
import { verifyToken, authFingerprint } from '../lib/tokens.js';
import { userError } from '../lib/errors.js';

/**
 * Verificerer et medlem mod et band.
 *
 * To veje ind, præcis som i dag:
 *   1. `mt:`-token — kun signatur- og fingeraftrykstjek, ingen hashing. Det er
 *      den normale vej efter login og grunden til at almindelige kald ikke
 *      koster en KDF.
 *   2. Rå clientHash — kun ved selve login og password-skift.
 *
 * Returnerer medlemsrækken (med hash-felter) eller null. Fejler altid lukket.
 */
export async function verifyMember(env, bandStub, email, credential) {
  const normEmail = String(email || '').toLowerCase().trim();
  const cred = String(credential || '');
  if (!normEmail || !cred) return null;

  // ── Token-vejen ──────────────────────────────────────────────────────────
  if (cred.startsWith('mt:')) {
    const data = await verifyToken(env, 'member', cred);
    if (!data || data.email !== normEmail) return null;
    const m = await bandStub.findMemberByEmail(normEmail);
    if (!m) return null;
    // Fingeraftrykket binder tokenet til det password der var gældende da det
    // blev udstedt. Et kodeskift gør derfor alle udestående tokens ugyldige.
    const fp = await authFingerprint(sha256hex, m.passwordHash);
    if (data.pwFp !== fp) return null;
    return m;
  }

  // ── Hash-vejen ───────────────────────────────────────────────────────────
  const m = await bandStub.findMemberByEmail(normEmail);
  if (!m) {
    // Betal SAMME KDF-pris som for en kendt bruger.
    //
    // Uden dette returnerer en ukendt e-mail med det samme, mens en kendt
    // koster PW_ITERATIONS runder PBKDF2 — en målbar, konstant forskel på hver
    // eneste request. Fejlbeskederne er ens, men svartiden afslørede alligevel
    // om kontoen findes, og for bookere er netop dét udtrykkeligt noget koden
    // andre steder lover ikke at afsløre.
    //
    // Præcis ét pbkdf2-kald med det samme iterationstal som en rigtig
    // verifikation — ikke to, og ikke et andet tal, for så ville den nye sti
    // bare være et timing-signal den anden vej.
    await dummyVerify(env, cred);
    return null;
  }
  if (!await verifyHash(cred, m.pwSalt, m.passwordHash)) return null;
  return m;
}

// Fast salt; kun arbejdet tæller, ikke resultatet.
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

export async function dummyVerify(env, cred) {
  try {
    await pbkdf2(String(cred || 'x'), DUMMY_SALT, pwIterations(env));
  } catch (e) { /* må aldrig påvirke svaret */ }
}

/**
 * Som verifyMember, men opgraderer hashen hvis iterationstallet er hævet siden
 * den blev lavet. Kaldes KUN fra login, hvor vi har den rå clientHash — et
 * token indeholder ikke passwordet og kan derfor ikke bruges til at rehashe.
 *
 * Dette er mekanismen der lader PW_ITERATIONS hæves fra 5000 til 200.000 uden
 * at nogen skal skifte password: hver bruger opgraderes ved sit næste login.
 */
export async function verifyMemberAndMaybeRehash(env, bandStub, email, clientHash) {
  const m = await verifyMember(env, bandStub, email, clientHash);
  if (!m) return null;
  if (String(clientHash).startsWith('mt:')) return m;

  const target = pwIterations(env);
  if (!needsRehash(m.passwordHash, target)) return m;

  const pf = await newPasswordFields(clientHash, target);
  // Bevidst uden at dræbe sessioner: brugeren har ikke skiftet password, vi har
  // kun gjort lagringen stærkere. setMemberPassword ville logge dem ud.
  await bandStub.updateMember(m.id, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt });
  return Object.assign({}, m, { passwordHash: pf.passwordHash, pwSalt: pf.pwSalt });
}

/** Kaster hvis medlemmet ikke er admin. Port af _requireAdmin (Code.gs:1364). */
export function requireAdmin(m) {
  if (!m) throw userError('Ikke logget ind');
  if ((m.role || 'member') !== 'admin') throw userError('Kræver administrator-adgang');
  return m;
}

/** Verificerer et operatør-token. */
export async function verifyOperator(env, token) {
  return verifyToken(env, 'operator', token);
}

/**
 * Verificerer et booker-token.
 *
 * Var foer et rent signaturtjek. Det betoed at tokenet levede sit eget liv i
 * otte timer: satte operatoeren bookeren til `inactive`, eller nulstillede
 * deres adgangskode, beholdt indehaveren af det gamle token fuld adgang.
 * harAdgang tjekkede bandets status, aldrig bookerens egen.
 *
 * Nu slaas bookeren op, og bade status og password-fingeraftrykket skal passe.
 * Det koster ét master-opslag pr. booker-kald; bookere er faa og deres kald
 * sjaeldne, saa det er ikke den varme sti arkitekturreglen handler om.
 */
export async function verifyBooker(env, token) {
  const data = await verifyToken(env, 'booker', token);
  if (!data || !data.email) return null;

  const { masterStub } = await import('../lib/addressing.js');
  let b;
  try { b = await masterStub(env).getBooker(data.email); }
  catch (e) { return null; }                       // fejler lukket
  if (!b) return null;
  if ((b.status || 'active') !== 'active') return null;

  // Tokens udstedt foer pwFp blev indfoert har ikke feltet. De afvises, saa
  // indfoerelsen ikke efterlader en periode hvor det gamle format stadig
  // virker; bookerne logger bare ind igen.
  const fp = await authFingerprint(sha256hex, b.passwordHash);
  if (data.pwFp !== fp) return null;

  return data;
}

/** Verificerer et arrangør-signeringstoken. */
export async function verifySigning(env, token) {
  return verifyToken(env, 'arr-sign', token);
}

/**
 * Fjerner alt følsomt fra en medlemsrække, før den sendes til klienten.
 * Port af _privateMember. Whitelist frem for blacklist: en ny kolonne i
 * members bliver IKKE automatisk eksponeret.
 */
export function publicMember(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name || '',
    category: m.category || '',
    instrument: m.instrument || '',
    phone: m.phone || '',
    email: m.email || '',
    regAccount: m.regAccount || '',
    address: m.address || '',
    role: m.role || 'member'
  };
}
