// Fejl der er beregnet til brugeren.
//
// Port af _userError (Code.gs:781). Reglen er den samme: kun beskeder markeret
// som brugervendte når klienten. Alt andet logges og erstattes af en generisk
// besked, så interne detaljer — stier, SQL, nøglenavne — ikke lækker ud.

/**
 * Den ENE besked alle afvisninger på det offentlige signeringsflow giver.
 *
 * Den ligger her, fordi to lag afviser uafhængigt af hinanden: routerens
 * 'signing'-gate (forkert signatur, udløb, forkert rolle) og selve action'ens
 * validering (forkert docHash, forkert status, ukendt booking, band uden
 * booking). Afveg beskederne bare med et punktum, ville forskellen være et
 * orakel man kunne udspørge om hvilken del der fejlede.
 *
 * Selvtesten håndhæver at begge lag bruger præcis denne streng.
 */
export const SIGNING_REJECT_MESSAGE = 'Linket er ugyldigt eller udløbet.';

export class UserError extends Error {
  constructor(message, status = 200) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
    this.status = status;
  }
}

export function userError(message, status) {
  return new UserError(message, status);
}

/**
 * Oversætter en fejl til et svar-objekt. Ikke-brugervendte fejl bliver til den
 * generiske besked; kalderen logger selv originalen.
 */
export function errorToResponse(e) {
  if (e && e.userFacing) return { ok: false, error: String(e.message) };
  return { ok: false, error: 'Serverfejl' };
}
