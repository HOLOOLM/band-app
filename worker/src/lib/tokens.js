// Tokens. Formaterne er bevaret 1:1 fra Code.gs, fordi de er en del af
// kontrakten mod frontenden og mod allerede udsendte signeringslinks:
//
//   mt:<payload>.<sig>   medlem     (_issueMemberToken, Code.gs:1287)
//   bt:<payload>.<sig>   booker
//   bk:<payload>.<sig>   arrangør-signering
//   <payload>.<sig>      operatør   (_signOperatorPayload, Code.gs:3700)
//
// Alle fire signeres med MASTER_SECRET. Rollefeltet i payloaden verificeres
// STRIKST pr. sti: et medlems-token må aldrig kunne nå operatør-, booker- eller
// signeringskode, heller ikke hvis signaturen er gyldig.

import { hmacSha256, b64url, b64urlToBytes, constTimeEq } from './crypto.js';

const dec = new TextDecoder();

export const MEMBER_TOKEN_TTL_SEC = 8 * 60 * 60;

const PREFIX = { member: 'mt:', booker: 'bt:', 'arr-sign': 'bk:', operator: '' };

function secret(env) {
  const s = String(env.MASTER_SECRET || '');
  if (!s) throw new Error('MASTER_SECRET er ikke konfigureret');
  return s;
}

async function sign(env, payloadStr) {
  return b64url(await hmacSha256(secret(env), payloadStr));
}

/**
 * Udsteder et token. `role` bestemmer både præfiks og det role-felt der
 * verificeres ved afkodning — de kan ikke komme ud af sync.
 */
export async function issueToken(env, role, claims, ttlSeconds) {
  if (!(role in PREFIX)) throw new Error('Ukendt token-rolle: ' + role);
  const payloadObj = Object.assign({}, claims, { role });
  if (ttlSeconds) payloadObj.exp = Date.now() + ttlSeconds * 1000;
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  return PREFIX[role] + payload + '.' + await sign(env, payload);
}

/**
 * Afkoder og verificerer et token. Returnerer payload eller null.
 *
 * Fejler lukket på: forkert præfiks, manglende punkt, signaturafvigelse,
 * ugyldig JSON, forkert rolle, udløb. Rollen skal matche `expectedRole` —
 * det er den kontrol der forhindrer at et medlems-token bruges som operatør.
 */
export async function verifyToken(env, expectedRole, token) {
  if (!(expectedRole in PREFIX)) return null;
  let raw = String(token || '');
  const prefix = PREFIX[expectedRole];
  if (prefix) {
    if (!raw.startsWith(prefix)) return null;
    raw = raw.slice(prefix.length);
  } else if (raw.includes(':')) {
    // Operatør-tokens har intet præfiks. Et token MED præfiks er en anden rolle
    // og må ikke slippe igennem her.
    return null;
  }

  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  if (!constTimeEq(sig, await sign(env, payload))) return null;

  let data;
  try {
    data = JSON.parse(dec.decode(b64urlToBytes(payload)));
  } catch (e) {
    return null;
  }
  if (!data || data.role !== expectedRole) return null;
  if (data.exp && Date.now() > Number(data.exp)) return null;
  if (data.email) data.email = String(data.email).toLowerCase().trim();
  return data;
}

/**
 * Fingeraftryk af det aktuelt gemte password. Lægges i medlems-tokenet, så et
 * password-skift øjeblikkeligt gør alle udestående tokens ugyldige.
 *
 * NB, jf. kommentaren i Code.gs:1276: hash HELE passwordHash-strengen og slice
 * FØRST derefter. Et slice(0,16) af strengen selv ville ramme det faste
 * præfiks "pbkdf2$10000$" og kun indeholde nogle få reelle tegn af hashen.
 */
export async function authFingerprint(sha256hex, passwordHash) {
  return (await sha256hex(String(passwordHash || ''))).slice(0, 16);
}
