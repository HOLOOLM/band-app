// Selvtest af crypto- og token-laget (Fase 3a).
//
// Vægten ligger på at det FEJLER LUKKET. En hashfunktion der siger "ja" til et
// forkert password, eller en token-verifikation der lader et medlems-token
// passere som operatør, er værre end ingen af dem — så hver positiv test har en
// negativ modpart.
//
// Bemærk at de tre legacy hash-generationer fra Code.gs:846 (saltet ét-HMAC og
// usaltet rå sha256) bevidst er droppet: der findes ingen eksisterende hashes at
// respektere, og testen herunder kræver eksplicit at de nu AFVISES.

import {
  sha256hex, constTimeEq, randomBase64, genSalt,
  hashPassword, verifyHash, needsRehash, newPasswordFields,
  encryptCpr, decryptCpr, b64ToBytes, bytesToB64
} from '../lib/crypto.js';
import { issueToken, verifyToken, authFingerprint } from '../lib/tokens.js';

const ITER = 2000;   // lavt tal: testen skal være hurtig, ikke sikker

export async function authChecks(ok) {
  // ── sha256 og konstant-tid ────────────────────────────────────────────────
  const h = await sha256hex('abc');
  ok('sha256: kendt værdi',
     h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
     h.slice(0, 16) + '…');

  ok('constTimeEq: ens strenge', constTimeEq('abc', 'abc'));
  ok('constTimeEq: forskellige strenge', !constTimeEq('abc', 'abd'));
  ok('constTimeEq: forskellig længde', !constTimeEq('abc', 'abcd'));

  // ── PBKDF2 ────────────────────────────────────────────────────────────────
  const clientHash = await sha256hex('hemmeligt-password');
  const salt = genSalt();
  const stored = await hashPassword(clientHash, salt, ITER);

  ok('pbkdf2: format er self-describing',
     stored.startsWith('pbkdf2$' + ITER + '$'), stored.slice(0, 20) + '…');
  ok('pbkdf2: korrekt password verificerer', await verifyHash(clientHash, salt, stored));
  ok('pbkdf2: forkert password afvises',
     !await verifyHash(await sha256hex('forkert'), salt, stored));
  ok('pbkdf2: forkert salt afvises', !await verifyHash(clientHash, genSalt(), stored));
  ok('pbkdf2: samme password + forskellige salte giver forskellige hashes',
     (await hashPassword(clientHash, genSalt(), ITER)) !== stored);

  // Fejler lukket på alt der ikke er det nuværende format.
  ok('pbkdf2: tom gemt hash afvises', !await verifyHash(clientHash, salt, ''));
  ok('pbkdf2: legacy usaltet hash afvises', !await verifyHash(clientHash, salt, clientHash));
  ok('pbkdf2: legacy saltet hash (ét felt) afvises',
     !await verifyHash(clientHash, salt, 'abc123=='));
  ok('pbkdf2: ukendt algoritme afvises',
     !await verifyHash(clientHash, salt, 'scrypt$2000$abc'));
  ok('pbkdf2: absurd lavt iterationstal afvises',
     !await verifyHash(clientHash, salt, 'pbkdf2$1$abc'));

  // ── needsRehash: mekanismen der lader iterationstallet hæves ──────────────
  ok('needsRehash: samme tal → nej', !needsRehash(stored, ITER));
  ok('needsRehash: hævet tal → ja', needsRehash(stored, ITER * 10));
  ok('needsRehash: legacy → ja', needsRehash(clientHash, ITER));
  ok('needsRehash: tom → ja', needsRehash('', ITER));

  const pf = await newPasswordFields(clientHash, ITER);
  ok('newPasswordFields: giver hash + salt der passer sammen',
     await verifyHash(clientHash, pf.pwSalt, pf.passwordHash));

  // ── CPR: AES-GCM ─────────────────────────────────────────────────────────
  // Egen env med en frisk nøgle, så testen ikke kræver at CPR_KEY er sat.
  const cprEnv = { CPR_KEY: randomBase64(32) };
  const cpr = '0101901234';
  const ct = await encryptCpr(cprEnv, cpr);
  ok('cpr: krypteret værdi er ikke klartekst', !ct.includes(cpr), ct.slice(0, 14) + '…');
  ok('cpr: dekrypterer til samme værdi', (await decryptCpr(cprEnv, ct)) === cpr);
  ok('cpr: to krypteringer af samme værdi er forskellige (tilfældig iv)',
     (await encryptCpr(cprEnv, cpr)) !== ct);

  // Manipulation skal afvises, ikke give en forkert CPR tilbage.
  const bytes = b64ToBytes(ct.slice(3));
  bytes[bytes.length - 1] ^= 0xff;
  ok('cpr: manipuleret ciphertext afvises',
     await forventerFejl(() => decryptCpr(cprEnv, 'v3:' + bytesToB64(bytes))));
  ok('cpr: forkert nøgle afvises',
     await forventerFejl(() => decryptCpr({ CPR_KEY: randomBase64(32) }, ct)));
  ok('cpr: ukendt format afvises',
     await forventerFejl(() => decryptCpr(cprEnv, 'gammeltformat==')));
  ok('cpr: manglende nøgle afvises',
     await forventerFejl(() => encryptCpr({}, cpr)));

  // ── Tokens ────────────────────────────────────────────────────────────────
  const tokEnv = { MASTER_SECRET: randomBase64(32) };
  const fp = await authFingerprint(sha256hex, stored);
  const mt = await issueToken(tokEnv, 'member',
    { email: 'Jho@Example.com', pwFp: fp }, 3600);

  ok('token: medlems-token har mt:-præfiks', mt.startsWith('mt:'), mt.slice(0, 12) + '…');
  const mtData = await verifyToken(tokEnv, 'member', mt);
  ok('token: verificerer og normaliserer e-mail',
     mtData && mtData.email === 'jho@example.com', mtData && mtData.email);
  ok('token: fingeraftryk bevaret', mtData && mtData.pwFp === fp);

  // Rolleforvirring: samme signatur, forkert forventet rolle.
  ok('token: medlems-token afvises som operatør',
     (await verifyToken(tokEnv, 'operator', mt)) === null);
  ok('token: medlems-token afvises som booker',
     (await verifyToken(tokEnv, 'booker', mt)) === null);
  ok('token: medlems-token afvises som signeringstoken',
     (await verifyToken(tokEnv, 'arr-sign', mt)) === null);

  // Signatur og indhold.
  ok('token: manipuleret signatur afvises',
     (await verifyToken(tokEnv, 'member', mt.slice(0, -1) + 'X')) === null);
  ok('token: anden hemmelighed afvises',
     (await verifyToken({ MASTER_SECRET: randomBase64(32) }, 'member', mt)) === null);
  ok('token: vrøvl afvises', (await verifyToken(tokEnv, 'member', 'mt:vrøvl')) === null);
  ok('token: tomt afvises', (await verifyToken(tokEnv, 'member', '')) === null);

  const udloebet = await issueToken(tokEnv, 'member', { email: 'a@b.dk' }, -10);
  ok('token: udløbet afvises', (await verifyToken(tokEnv, 'member', udloebet)) === null);

  // Operatør-token har intet præfiks — og må ikke kunne udgives for et medlem.
  const opTok = await issueToken(tokEnv, 'operator', { email: 'op@b.dk' }, 3600);
  ok('token: operatør-token verificerer', (await verifyToken(tokEnv, 'operator', opTok)) !== null);
  ok('token: operatør-token afvises som medlem',
     (await verifyToken(tokEnv, 'member', opTok)) === null);

  // ── Fingeraftryk: password-skift dræber udestående tokens ─────────────────
  const nyHash = await hashPassword(clientHash, genSalt(), ITER);
  const nyFp = await authFingerprint(sha256hex, nyHash);
  ok('fingeraftryk: ændrer sig når password-hashen ændres', nyFp !== fp, fp + ' → ' + nyFp);
  ok('fingeraftryk: er 16 tegn', fp.length === 16);
  // Regressionsværn for kommentaren i Code.gs:1276: hash HELE strengen, ellers
  // ville to hashes med samme "pbkdf2$2000$"-præfiks give samme fingeraftryk.
  ok('fingeraftryk: rammer ikke kun det faste præfiks',
     (await authFingerprint(sha256hex, 'pbkdf2$2000$AAAA')) !==
     (await authFingerprint(sha256hex, 'pbkdf2$2000$BBBB')));
}

async function forventerFejl(fn) {
  try { await fn(); return false; } catch (e) { return true; }
}
