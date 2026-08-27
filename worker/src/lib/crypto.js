// Kryptografi. Alt her er native WebCrypto — det håndrullede fra Code.gs er væk.
//
// Apps Script havde ikke crypto.getRandomValues og heller ikke PBKDF2 eller
// AES-GCM, så Code.gs byggede erstatninger af HMAC-kæder (_secureRandomBytes
// :318, _stretch :818, _encryptCpr :354). Workers har det hele indbygget og
// C-implementeret. Fordi der ikke er data at bevare — ingen live bands — er
// alle tre legacy hash-generationer og legacy-CPR-formatet droppet helt.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Tilfældighed ────────────────────────────────────────────────────────────
// Erstatter _secureRandomBytes (Code.gs:318), som strakte UUID'er gennem
// SHA-256 i counter-mode fordi Apps Script manglede en CSPRNG.

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomBase64(n) {
  return bytesToB64(randomBytes(n));
}

/** URL-sikkert tilfældigt id. Bruges til session-id'er. */
export function randomId(bytes = 24) {
  return b64url(randomBytes(bytes));
}

// ── Kodninger ───────────────────────────────────────────────────────────────

export function bytesToB64(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(String(b64));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** base64url uden padding — samme format som Code.gs' _b64url. */
export function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return b64ToBytes(t);
}

export function bytesToHex(bytes) {
  const a = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

// ── Hash og HMAC ────────────────────────────────────────────────────────────

/** sha256 som lowercase hex. Samme kontrakt som Code.gs' sha256 (:776). */
export async function sha256hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(str)));
  return bytesToHex(new Uint8Array(d));
}

async function hmacKey(secret, usages = ['sign']) {
  return crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? enc.encode(secret) : secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export async function hmacSha256(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return new Uint8Array(sig);
}

// ── Konstant-tids sammenligning ─────────────────────────────────────────────
// Port 1:1 af _constTimeEq (Code.gs:832). Bevidst samme løkke: den undgår at
// lække HVOR to hashes afviger gennem svartiden.

export function constTimeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Password-hashing ────────────────────────────────────────────────────────
//
// Klienten sender fortsat sha256(password) som "clientHash" — det er et
// uændret bærer-credential og en del af kontrakten mod frontenden.
//
// Serverside er _stretch's 10.000 HMAC-kald erstattet af RIGTIG PBKDF2-SHA256
// via crypto.subtle.deriveBits. Formatet "pbkdf2$<iter>$<base64>" er bevaret,
// så hashen fortsat er self-describing og needsRehash kan opgradere den, når
// iterationstallet hæves. Det er netop mekanismen der lader jer gå fra 10.000
// til 200.000 med én env-var-ændring dagen I skifter til Workers Paid.

// Valgt 5000 fordi installationen bliver på Workers Free, hvor loftet er 10 ms
// CPU pr. request. Målingen i do/bench.js: 10.000 iterationer koster 8 ms — for
// tæt på loftet at turde. 5000 giver ~4 ms og dermed margen.
//
// Prisen skal være kendt: 5000 er HALVDELEN af de 10.000 Apps Script bruger i
// dag (Code.gs:825), og OWASP anbefaler 600.000 for PBKDF2-HMAC-SHA256. Det
// betyder ikke noget for online-gætteri — det dækkes af rate-limit — men gør et
// offline-angreb efter et databrud billigere. Modforanstaltningen er derfor
// password-KVALITET: seedPassword skal skiftes til noget lang og tilfældigt.
//
// Hæv til 200.000 samme dag der skiftes til Workers Paid (30 s CPU). Det kræver
// KUN at PW_ITERATIONS-varen ændres — needsRehash opgraderer hver hash ved
// næste login, fordi hashen gemmer sit eget iterationstal.
export const PW_ALGO = 'pbkdf2';
export const PW_ITERATIONS_DEFAULT = 5000;

/** Iterationstal fra env, så det kan hæves uden kodeændring. */
export function pwIterations(env) {
  const n = parseInt(env && env.PW_ITERATIONS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : PW_ITERATIONS_DEFAULT;
}

/** PBKDF2-SHA256 → base64. 32 bytes ud, som den gamle HMAC-kæde. */
export async function pbkdf2(clientHash, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(clientHash)), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations },
    key,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

export function genSalt() {
  return randomBase64(16);
}

/** "pbkdf2$<iter>$<base64>" for et nyt password. */
export async function hashPassword(clientHash, salt, iterations) {
  return PW_ALGO + '$' + iterations + '$' + await pbkdf2(clientHash, salt, iterations);
}

/**
 * Verificér clientHash mod en gemt hash.
 *
 * Modsat _verifyHash (Code.gs:846) understøttes KUN pbkdf2-formatet. De tre
 * legacy-generationer (saltet ét-HMAC, usaltet rå sha256) er droppet, fordi der
 * ikke findes eksisterende hashes at respektere. En ukendt eller tom hash
 * fejler lukket.
 */
export async function verifyHash(clientHash, salt, stored) {
  const s = String(stored || '');
  const parts = s.split('$');
  if (parts.length !== 3 || parts[0] !== PW_ALGO) return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  return constTimeEq(await pbkdf2(clientHash, salt, iter), parts[2]);
}

/** Skal hashen genhashes, fordi iterationstallet er hævet siden den blev lavet? */
export function needsRehash(stored, targetIterations) {
  const s = String(stored || '');
  const parts = s.split('$');
  if (parts.length !== 3 || parts[0] !== PW_ALGO) return true;
  return (parseInt(parts[1], 10) || 0) < targetIterations;
}

/** Felterne til at gemme et nyt password. */
export async function newPasswordFields(clientHash, iterations) {
  const salt = genSalt();
  return { passwordHash: await hashPassword(clientHash, salt, iterations), pwSalt: salt };
}

// ── CPR-kryptering ──────────────────────────────────────────────────────────
//
// Code.gs byggede encrypt-then-MAC selv oven på en HMAC-stream-cipher (:354),
// fordi Apps Script ikke havde AES. Her er det AES-GCM, som giver fortrolighed
// OG integritet i én operation — en manipuleret værdi fejler ved dekryptering
// i stedet for at give en forkert CPR tilbage.
//
// Format: "v3:" + base64(iv[12] ‖ ciphertext‖tag). v3 markerer AES-GCM, så
// formatet fortsat er self-describing hvis nøgleskema skal ændres senere.

const CPR_PREFIX = 'v3:';

async function aesKey(env, usages) {
  const raw = String(env.CPR_KEY || '');
  if (!raw) throw new Error('CPR_KEY er ikke konfigureret');
  const bytes = b64ToBytes(raw);
  if (bytes.length !== 32) throw new Error('CPR_KEY skal være 32 bytes base64');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

export async function encryptCpr(env, plaintext) {
  const key = await aesKey(env, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(String(plaintext))
  );
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return CPR_PREFIX + bytesToB64(all);
}

export async function decryptCpr(env, ciphertext) {
  const raw = String(ciphertext || '');
  if (!raw.startsWith(CPR_PREFIX)) throw new Error('CPR-data har ukendt format');
  const key = await aesKey(env, ['decrypt']);
  const all = b64ToBytes(raw.slice(CPR_PREFIX.length));
  if (all.length < 12 + 16) throw new Error('CPR-data er korrupt');
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    // AES-GCM fejler af sig selv hvis tag'et ikke passer. Vi oversætter til den
    // samme besked Code.gs gav, så UI-teksten er uændret.
    throw new Error('CPR-integritetstjek fejlede — data kan være manipuleret');
  }
}
