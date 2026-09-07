// Routeren der kører en action med den rigtige gate foran.
//
// Kontrakten mod frontenden er uændret: POST /api/call med {action, bandId, …}
// og svar på formen {ok:true, …} / {ok:false, error}.

import { ACTIONS, VALID_AUTH } from './index.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { verifyMember, requireAdmin, verifyOperator, verifyBooker, verifySigning } from '../auth/verify.js';
import { errorToResponse, userError, SIGNING_REJECT_MESSAGE } from '../lib/errors.js';

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
      // Bemærk: bandId kommer fra request-body. For ISOLATIONEN er det
      // harmløst — stubben giver kun adgang til DET bands database, og et
      // session-id udstedt til et andet band findes ikke deri.
      //
      // Men for RESSOURCERNE er det ikke harmløst: idFromName() plus det
      // første metodekald anlægger 24 tabeller i et nyt Durable Object,
      // permanent. På de uautentificerede actions — getConfig driver
      // login-skærmens branding og kræver ingen session — kunne enhver anonym
      // derfor oprette ubegrænset mange tomme databaser, som ikke står i
      // masters bandliste og derfor aldrig ryddes op af cron'en.
      //
      // Derfor: kendt band påkrævet, før stubben overhovedet laves, på præcis
      // de stier hvor kalderen endnu ikke har bevist noget. De autentificerede
      // stier springer opslaget over, så den varme sti ikke rører master (se
      // arkitekturreglen i planens Fase 1).
      if (def.auth === 'public') {
        const { masterStub } = await import('../lib/addressing.js');
        let findes = false;
        try { findes = !!await masterStub(env).getBand(bandId); }
        catch (e) { findes = false; }          // fejler lukket
        if (!findes) throw userError('Ukendt band');
      }
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

        // Operatøren er ikke medlem af noget band og har derfor ingen
        // medlems-session. Uden denne gren kunne operatør-panelet ikke læse
        // eller rette et bands opsætning — den fik "Ikke logget ind" på sin
        // egen Rediger-knap.
        //
        // Tilladelsen er UDTRYKKELIG pr. action (operatorOk) og ikke generel.
        // Åbnede vi alle band-admin-actions for operatør-tokenet, ville
        // operatøren også kunne gemme kontrakter og honorar i et hvilket som
        // helst band — en rettighed panelet aldrig beder om, og som ville gøre
        // revisionssporet meningsløst: handlingen ville se ud som bandets egen.
        if (def.operatorOk && creds && creds.operatorToken) {
          const op = await verifyOperator(env, creds.operatorToken);
          if (op) { ctx.operator = op; break; }
        }

        if (!creds || !creds.email || !creds.token) throw userError('Ikke logget ind');
        const m = await verifyMember(env, ctx.band, creds.email, creds.token);
        if (!m) throw userError('Ikke logget ind');
        ctx.member = m;
        if (def.auth === 'admin') requireAdmin(m);
        break;
      }

      case 'identity': {
        // Kryds-band. Der er INGEN band-kontekst her, så vi kan ikke verificere
        // mod en medlemsrække endnu — det sker pr. band inde i fan-out'en, hvor
        // musikeren skal være medlem for at bandet tælles med.
        //
        // Her tjekker vi kun at e-mailen har et identitetskort, altså at den
        // hører til mindst ét band. Det forhindrer at en vilkårlig e-mail kan
        // udløse en fan-out.
        if (!creds || !creds.email || !creds.token) throw userError('Ikke logget ind');
        // Slår op i identity_bands, ikke i identities. Identitetsrækken skrives
        // nu KUN når ejeren selv har valgt en adgangskode (se registerIdentity
        // i auth/identity.js for hvorfor seedingen blev fjernet), så den findes
        // ikke for en musiker der endnu ikke har skiftet sin startkode.
        // Tilknytningen er også det rigtige spørgsmål her: gaten skal kun
        // forhindre at en vilkårlig e-mail udløser en fan-out.
        const { identityHasBands } = await import('../auth/identity.js');
        if (!await identityHasBands(env, creds.email)) throw userError('Ikke logget ind');
        ctx.creds = creds;
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
        // SAMME besked som action'ens egen validering — se SIGNING_REJECT_MESSAGE.
        if (!s) throw userError(SIGNING_REJECT_MESSAGE);
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
