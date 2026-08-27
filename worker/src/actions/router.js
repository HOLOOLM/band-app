// Routeren der kører en action med den rigtige gate foran.
//
// Kontrakten mod frontenden er uændret: POST /api/call med {action, bandId, …}
// og svar på formen {ok:true, …} / {ok:false, error}.

import { ACTIONS, VALID_AUTH } from './index.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { verifyMember, requireAdmin, verifyOperator, verifyBooker, verifySigning } from '../auth/verify.js';
import { errorToResponse, userError } from '../lib/errors.js';

/**
 * Kører en action.
 *
 * `creds` er hvad Workeren har hentet ud af den httpOnly session-cookie —
 * aldrig noget klienten selv har sendt. Det er derfor et medlems-token ikke kan
 * forfalskes ved at lægge det i request-body.
 */
export async function runAction(env, actionName, p, creds) {
  const def = ACTIONS[actionName];
  if (!def) return { ok: false, error: 'Ukendt handling' };

  // Fail-closed på en fejlkonfigureret tabel. En action med en stavefejl i
  // auth-feltet må aldrig kunne køre uden gate.
  if (!VALID_AUTH.includes(def.auth)) {
    console.error('Action ' + actionName + ' har ugyldig auth: ' + def.auth);
    return { ok: false, error: 'Serverfejl' };
  }

  const ctx = { env, p: p || {}, action: actionName };

  try {
    // ── Lager ──────────────────────────────────────────────────────────────
    if (def.scope === 'band') {
      const bandId = String(p.bandId || '').trim();
      if (!bandId) throw userError('bandId mangler');
      // Bemærk: bandId kommer fra request-body, men det er harmløst — stubben
      // giver kun adgang til DET bands database, og et session-id udstedt til
      // et andet band findes ikke deri. Isolationen afhænger altså ikke af at
      // vi validerer bandId her.
      ctx.band = bandStub(env, bandId);
      ctx.bandId = bandId;
      // Lader en action opdatere operatørlistens tal i master efter en
      // skrivning. Bevidst opt-in frem for automatisk: kun de actions der
      // ændrer medlems- eller kontraktantal behøver det, og et kald til master
      // hører ikke på en læsesti (se arkitekturreglen i planens Fase 1).
      //
      // Fejler det, er den egentlige handling stadig gennemført — statistikken
      // er kosmetisk og bliver rettet ved næste skrivning.
      ctx.reportStats = async () => {
        try {
          const s = await ctx.band.summaryStats();
          await masterStub(env).reportStats(bandId, s.members, s.upcoming);
        } catch (e) {
          console.warn('Kunne ikke opdatere opsummering for ' + bandId + ': ' +
                       (e && e.message || e));
        }
      };
    } else if (def.scope === 'master') {
      ctx.master = masterStub(env);
    }

    // ── Gate ───────────────────────────────────────────────────────────────
    switch (def.auth) {
      case 'public':
        break;

      case 'member':
      case 'admin': {
        if (!ctx.band) throw userError('Handlingen kræver et band');
        if (!creds || !creds.email || !creds.token) throw userError('Ikke logget ind');
        const m = await verifyMember(env, ctx.band, creds.email, creds.token);
        if (!m) throw userError('Ikke logget ind');
        ctx.member = m;
        if (def.auth === 'admin') requireAdmin(m);
        break;
      }

      case 'operator': {
        const op = await verifyOperator(env, creds && creds.operatorToken);
        if (!op) throw userError('Kræver operatør-adgang');
        ctx.operator = op;
        break;
      }

      case 'booker': {
        const b = await verifyBooker(env, creds && creds.bookerToken);
        if (!b) throw userError('Kræver booker-login');
        ctx.booker = b;
        break;
      }

      case 'signing': {
        const s = await verifySigning(env, p && p.t);
        if (!s) throw userError('Linket er ugyldigt eller udløbet');
        ctx.signing = s;
        break;
      }
    }

    const svar = await def.fn(ctx);
    return svar || { ok: false, error: 'Handlingen returnerede intet' };

  } catch (e) {
    if (!e || !e.userFacing) {
      console.error('Fejl i action ' + actionName + ': ' + (e && e.stack || e));
    }
    return errorToResponse(e);
  }
}
