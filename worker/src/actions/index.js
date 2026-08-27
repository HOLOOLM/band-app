// ACTION-tabellen. Erstatter handle() (Code.gs:615-739).
//
// Hver action erklærer sit `scope` (hvilket objekt den arbejder mod) og sin
// `auth` (hvem der må kalde den). Routeren kører verifikationen ud fra de to
// felter FØR `fn` kaldes.
//
// Det er den vigtigste strukturelle forbedring i porten. I Apps Script lå
// _requireAdmin-kaldene inde i hver action, hvor man kunne glemme et — og en
// glemt gate er en åben dør. Her kan en action ikke registreres uden at erklære
// sin gate, og routeren nægter at køre en action med ukendt auth-værdi.

import { login, refreshSession, changePassword, trackLogin, getConfig } from './auth.js';
import {
  getMembers, saveMember, deleteMember, resetPassword,
  memberUpdateProfile, exportMyData
} from './members.js';
import {
  getContracts, getContract, saveContract,
  changeContractStatus, deleteContract, getDashboard
} from './contracts.js';
import {
  getJobs, getJob, updateMyAddress, updateJobStartAddress,
  updateJobReturnHome, recalcJobDistance
} from './jobs.js';
import {
  getMyHonorar, getHonorarAdmin, createInvoice,
  getInvoices, updateInvoiceStatus, deleteInvoice
} from './honorar.js';

// scope: hvilket lager action'en får udleveret
//   'band'      → ctx.band er bandets DO-stub (kræver gyldigt bandId)
//   'master'    → ctx.master er master-stubben
//   'identity'  → kryds-band; ctx.bandIds + fan-out
//   'none'      → intet lager
//
// auth: hvad routeren kræver, før fn kaldes
//   'public'    → ingen auth. Må KUN bruges hvor svaret er offentligt.
//   'member'    → gyldigt medlem i bandet; ctx.member sættes
//   'admin'     → medlem med role=admin
//   'operator'  → gyldigt operatør-token
//   'booker'    → gyldigt booker-token
//   'signing'   → gyldigt bk:-signeringstoken
export const ACTIONS = {
  // ── Fase 3a ──────────────────────────────────────────────────────────────
  // login og refreshSession er 'public', fordi de ER autentifikationen — de
  // verificerer selv credentials og har deres egen rate-limit.
  login:          { scope: 'band', auth: 'public', fn: login },
  refreshSession: { scope: 'band', auth: 'public', fn: refreshSession },
  changePassword: { scope: 'band', auth: 'public', fn: changePassword },
  getConfig:      { scope: 'band', auth: 'public', fn: getConfig },
  trackLogin:     { scope: 'band', auth: 'member', fn: trackLogin },

  // ── Fase 3b ──────────────────────────────────────────────────────────────
  // Bemærk skellet: alt der rører ANDRE medlemmer kræver admin, mens de to
  // actions der kun rører kalderens egne data er 'member'.
  getMembers:          { scope: 'band', auth: 'admin',  fn: getMembers },
  saveMember:          { scope: 'band', auth: 'admin',  fn: saveMember },
  deleteMember:        { scope: 'band', auth: 'admin',  fn: deleteMember },
  resetPassword:       { scope: 'band', auth: 'admin',  fn: resetPassword },
  memberUpdateProfile: { scope: 'band', auth: 'member', fn: memberUpdateProfile },
  exportMyData:        { scope: 'band', auth: 'member', fn: exportMyData },

  // ── Fase 3c ──────────────────────────────────────────────────────────────
  // getDashboard er 'admin' som i originalen (Code.gs:1978), selvom den også
  // viser medlemmets eget honorar — den indeholder bandets samlede økonomi.
  getContracts:         { scope: 'band', auth: 'admin', fn: getContracts },
  getContract:          { scope: 'band', auth: 'admin', fn: getContract },
  saveContract:         { scope: 'band', auth: 'admin', fn: saveContract },
  changeContractStatus: { scope: 'band', auth: 'admin', fn: changeContractStatus },
  deleteContract:       { scope: 'band', auth: 'admin', fn: deleteContract },
  getDashboard:         { scope: 'band', auth: 'admin', fn: getDashboard },

  // ── Fase 3d ──────────────────────────────────────────────────────────────
  // Alle 'member': hver af dem rører KUN kalderens egne rækker, og
  // ejerskabet verificeres i selve SQL-forespørgslen (member_id = ?) frem for
  // med et tjek bagefter, som kunne glemmes.
  getJobs:                { scope: 'band', auth: 'member', fn: getJobs },
  getJob:                 { scope: 'band', auth: 'member', fn: getJob },
  updateMyAddress:        { scope: 'band', auth: 'member', fn: updateMyAddress },
  updateJobStartAddress:  { scope: 'band', auth: 'member', fn: updateJobStartAddress },
  updateJobReturnHome:    { scope: 'band', auth: 'member', fn: updateJobReturnHome },
  recalcJobDistance:      { scope: 'band', auth: 'member', fn: recalcJobDistance },

  // ── Fase 3e ──────────────────────────────────────────────────────────────
  // getMyHonorar er 'member' (egen afregning), getHonorarAdmin er 'admin'
  // (andres). Fakturaerne er bandets bogføring og dermed admin hele vejen.
  getMyHonorar:        { scope: 'band', auth: 'member', fn: getMyHonorar },
  getHonorarAdmin:     { scope: 'band', auth: 'admin',  fn: getHonorarAdmin },
  createInvoice:       { scope: 'band', auth: 'admin',  fn: createInvoice },
  getInvoices:         { scope: 'band', auth: 'admin',  fn: getInvoices },
  updateInvoiceStatus: { scope: 'band', auth: 'admin',  fn: updateInvoiceStatus },
  deleteInvoice:       { scope: 'band', auth: 'admin',  fn: deleteInvoice }
};

export const VALID_SCOPES = ['band', 'master', 'identity', 'none'];
export const VALID_AUTH = ['public', 'member', 'admin', 'operator', 'booker', 'signing'];

/**
 * Kontrollerer at tabellen er velformet. Kaldes af selvtesten, så en action med
 * en stavefejl i `auth` bliver fanget i test frem for at fejle åbent i drift.
 */
export function validateActionTable() {
  const fejl = [];
  for (const [navn, a] of Object.entries(ACTIONS)) {
    if (!a || typeof a.fn !== 'function') fejl.push(navn + ': mangler fn');
    if (!VALID_SCOPES.includes(a && a.scope)) fejl.push(navn + ': ukendt scope ' + (a && a.scope));
    if (!VALID_AUTH.includes(a && a.auth)) fejl.push(navn + ': ukendt auth ' + (a && a.auth));
  }
  return fejl;
}
