// Selvtest af omskiftningsflaget.
//
// Det vigtigste tjek i hele suiten set fra bandets stol: at STANDARDEN ikke
// flytter nogen. Bandenes rigtige data ligger i Apps Scripts Google Sheet, og
// et utilsigtet skift ville vise dem en tom app — ikke ødelagt, men tom, og det
// er umuligt at skelne fra "alt er tabt" når man sidder som bandleder søndag
// aften.
//
// Testen dækker også at flaget fejler MOD SHEETS ved en tastefejl. En ukendt
// værdi skal ramme den sti hvor dataen faktisk ligger.

import { usesDurableObjects, backendDescription } from '../backend.js';

export function cutoverChecks(ok) {
  const f = (v, band) => usesDurableObjects({ BACKEND: v }, band);

  // ── Standarden må ikke flytte nogen ─────────────────────────────────────
  ok('omskiftning: STANDARD (uden BACKEND sat) holder alle på Apps Script',
     usesDurableObjects({}, 'dmdt') === false &&
     usesDurableObjects({}, 'hvad-som-helst') === false);
  ok('omskiftning: "sheets" holder alle på Apps Script',
     f('sheets', 'dmdt') === false && f('sheets', 'test-a') === false);
  ok('omskiftning: beskrivelsen siger tydeligt hvad der er i brug',
     backendDescription({}).includes('Apps Script') &&
     backendDescription({ BACKEND: 'do' }).includes('Durable Objects'),
     backendDescription({}));

  // ── Fejl MOD Sheets, ikke mod DO ────────────────────────────────────────
  ok('omskiftning: tastefejl i flaget holder alle på Apps Script',
     f('DO', 'dmdt') === false &&           // versaler
     f('durable', 'dmdt') === false &&
     f('do-', 'dmdt') === false &&
     f('', 'dmdt') === false &&
     f('  ', 'dmdt') === false);
  ok('omskiftning: "do:" uden bands flytter ingen',
     f('do:', 'dmdt') === false && f('do:', '') === false);

  // ── Skift pr. band ──────────────────────────────────────────────────────
  ok('omskiftning: "do:dmdt" flytter KUN dmdt',
     f('do:dmdt', 'dmdt') === true &&
     f('do:dmdt', 'andet-band') === false);
  ok('omskiftning: flere bands kan nævnes',
     f('do:dmdt,test-a', 'dmdt') === true &&
     f('do:dmdt,test-a', 'test-a') === true &&
     f('do:dmdt,test-a', 'test-b') === false);
  ok('omskiftning: mellemrum i listen tolereres',
     f('do: dmdt , test-a ', 'dmdt') === true &&
     f('do: dmdt , test-a ', 'test-a') === true);
  ok('omskiftning: delvist navnematch tæller IKKE',
     f('do:dmdt', 'dmdt-2') === false &&
     f('do:dmdt-2', 'dmdt') === false);

  // ── Alle på én gang ─────────────────────────────────────────────────────
  ok('omskiftning: "do" flytter alle bands',
     f('do', 'dmdt') === true && f('do', 'et-helt-nyt-band') === true);
  ok('omskiftning: mellemrum omkring "do" tolereres',
     f('  do  ', 'dmdt') === true);

  // ── Tomt bandId ─────────────────────────────────────────────────────────
  // Operatør- og booker-actions har intet bandId. De hører til det nye lag så
  // snart NOGEN er skiftet — ellers ville operatøren administrere ét system og
  // bandene ligge i et andet.
  ok('omskiftning: tomt bandId matcher ikke en band-liste',
     f('do:dmdt', '') === false);
}
