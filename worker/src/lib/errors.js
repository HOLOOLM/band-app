// Fejl der er beregnet til brugeren.
//
// Port af _userError (Code.gs:781). Reglen er den samme: kun beskeder markeret
// som brugervendte når klienten. Alt andet logges og erstattes af en generisk
// besked, så interne detaljer — stier, SQL, nøglenavne — ikke lækker ud.

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
