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
import {
  adminReadConfig, adminWriteConfig, adminSaveAppearance,
  adminGetBillingInfo, adminSaveBillingInfo, adminUploadAsset,
  adminDeleteAsset, getRider, getSceneplan
} from './settings.js';
import {
  operatorLogin, listTenants, registerTenant, updateTenant, setTenantStatus,
  bandHealth, getAuditLog, backupBand, migrateAllBands, deleteTenant,
  operatorChangePassword, adminResetMemberPassword, runRetentionNow,
  operatorListMembers, operatorSetMemberRole,
  listBandBackups, getBandBackup, runBackupNow
} from './operator.js';
import {
  getAllJobs, getAllHonorar, getFeedUrl, rotateFeedToken
} from './crossband.js';
import {
  sendContractForSigning, listIncomingBookings, approveAndSignBooking,
  declineBooking, cancelBooking, resendSigningLink,
  getSignableBooking, submitArrangoerSignature, declineByArrangoer
} from './bookings.js';
import {
  bookerLogin, bookerGetBands, bookerListOffers, bookerSaveOffer,
  bookerSendOffer, bookerCancelOffer,
  operatorListBookers, operatorSaveBooker, operatorDeleteBooker,
  operatorResetBookerPassword
} from './booker.js';
import { archiveInvoice } from './pdf.js';
import { importBandData, importInvoicePdfs } from './import.js';

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
  deleteInvoice:       { scope: 'band', auth: 'admin',  fn: deleteInvoice },

  // ── Fase 3i ──────────────────────────────────────────────────────────────
  // getRider og getSceneplan er 'member': de sendes videre til arrangører i
  // kontrakten, så de er ikke hemmelige — men de er store, og et ulogget kald
  // ville være en gratis måde at trække båndbredde.
  adminReadConfig:      { scope: 'band', auth: 'admin', operatorOk: true,  fn: adminReadConfig },
  adminWriteConfig:     { scope: 'band', auth: 'admin', operatorOk: true,  fn: adminWriteConfig },
  adminSaveAppearance:  { scope: 'band', auth: 'admin',  fn: adminSaveAppearance },
  adminGetBillingInfo:  { scope: 'band', auth: 'admin',  fn: adminGetBillingInfo },
  adminSaveBillingInfo: { scope: 'band', auth: 'admin',  fn: adminSaveBillingInfo },
  adminUploadAsset:     { scope: 'band', auth: 'admin', operatorOk: true,  fn: adminUploadAsset },
  adminDeleteAsset:     { scope: 'band', auth: 'admin',  fn: adminDeleteAsset },
  getRider:             { scope: 'band', auth: 'member', fn: getRider },
  getSceneplan:         { scope: 'band', auth: 'member', fn: getSceneplan },

  // ── Fase 3j ──────────────────────────────────────────────────────────────
  // operatorLogin er 'public' fordi den ER autentifikationen; den har sin egen
  // rate-limit i master. Alt andet kræver et gyldigt operatør-token.
  operatorLogin:    { scope: 'none',   auth: 'public',   fn: operatorLogin },
  listTenants:      { scope: 'master', auth: 'operator', fn: listTenants },
  registerTenant:   { scope: 'master', auth: 'operator', fn: registerTenant },
  updateTenant:     { scope: 'master', auth: 'operator', fn: updateTenant },
  setTenantStatus:  { scope: 'master', auth: 'operator', fn: setTenantStatus },
  bandHealth:       { scope: 'master', auth: 'operator', fn: bandHealth },
  operatorChangePassword: { scope: 'master', auth: 'operator', fn: operatorChangePassword },
  // Tre actions frontenden kalder, som manglede i tabellen. Fundet ved at
  // sammenligne alle 63 action-navne frontenden bruger mod denne tabel.
  adminResetMemberPassword: { scope: 'master', auth: 'operator', fn: adminResetMemberPassword },
  runRetentionNow:          { scope: 'master', auth: 'operator', fn: runRetentionNow },
  // Operatøren udpeger en administrator. Et band oprettes med en admin ud fra
  // det vi ved på oprettelsestidspunktet; er den e-mail en pladsholder, skal
  // rollen kunne flyttes UDEN at nogen logger ind som pladsholderen.
  operatorListMembers:      { scope: 'master', auth: 'operator', fn: operatorListMembers },
  operatorSetMemberRole:    { scope: 'master', auth: 'operator', fn: operatorSetMemberRole },
  // Ugentlig sikkerhedskopi i R2. Ligger ved siden af PITR, ikke i stedet
  // for: PITR er minutpræcis men lever inde i objektet og dør med det,
  // mens kopien overlever en sletning og kan hentes ned som fil.
  listBandBackups:          { scope: 'master', auth: 'operator', fn: listBandBackups },
  getBandBackup:            { scope: 'master', auth: 'operator', fn: getBandBackup },
  runBackupNow:             { scope: 'master', auth: 'operator', fn: runBackupNow },
  // adminDeleteBand er FJERNET 30/8. Den lod bandets EGEN admin slette hele
  // bandet permanent — database, fakturaarkiv og faktureringsoplysninger — med
  // en prompt() som eneste værn. Rollen "admin" i et band er typisk et menigt
  // medlem der har fået den, ikke nogen der har ansvaret for at data bevares,
  // og handlingen kan ikke fortrydes.
  //
  // Sletning er nu udelukkende operatørens: deleteTenant nedenfor. Er navnet
  // her fristende at genindføre, så husk at auth: 'admin' + scope: 'band'
  // betyder ENHVER admin i ETHVERT band.
  getAuditLog:      { scope: 'master', auth: 'operator', fn: getAuditLog },
  backupBand:       { scope: 'master', auth: 'operator', fn: backupBand },
  // Migrering fra DMDT-prototypen. Master-scope: de peger på et band via
  // targetBandId/bandId, og kun operatøren må flytte data ind i et band.
  importBandData:   { scope: 'master', auth: 'operator', fn: importBandData },
  importInvoicePdfs: { scope: 'master', auth: 'operator', fn: importInvoicePdfs },
  migrateAllBands:  { scope: 'master', auth: 'operator', fn: migrateAllBands },
  deleteTenant:     { scope: 'master', auth: 'operator', fn: deleteTenant },

  // ── Fase 3k ──────────────────────────────────────────────────────────────
  // 'identity' er kryds-band: ingen enkelt band-kontekst. Auth sker PR. BAND
  // inde i fan-out'en, hvor musikeren skal være medlem for at bandet tælles med.
  getAllJobs:       { scope: 'identity', auth: 'identity', fn: getAllJobs },
  getAllHonorar:    { scope: 'identity', auth: 'identity', fn: getAllHonorar },
  getFeedUrl:       { scope: 'band',     auth: 'admin', operatorOk: true, fn: getFeedUrl },
  rotateFeedToken:  { scope: 'band',     auth: 'admin', operatorOk: true, fn: rotateFeedToken },

  // ── Fase 3g ──────────────────────────────────────────────────────────────
  // De tre sidste er OFFENTLIGE og gates udelukkende af bk:-tokenet: en
  // arrangør har intet login. Alle fejl der giver samme besked, er bevidst.
  sendContractForSigning:   { scope: 'band', auth: 'admin',   fn: sendContractForSigning },
  listIncomingBookings:     { scope: 'band', auth: 'admin',   fn: listIncomingBookings },
  approveAndSignBooking:    { scope: 'band', auth: 'admin',   fn: approveAndSignBooking },
  declineBooking:           { scope: 'band', auth: 'admin',   fn: declineBooking },
  cancelBooking:            { scope: 'band', auth: 'admin',   fn: cancelBooking },
  resendSigningLink:        { scope: 'band', auth: 'admin',   fn: resendSigningLink },
  getSignableBooking:       { scope: 'none', auth: 'signing', fn: getSignableBooking },
  submitArrangoerSignature: { scope: 'none', auth: 'signing', fn: submitArrangoerSignature },
  declineByArrangoer:       { scope: 'none', auth: 'signing', fn: declineByArrangoer },

  // ── Fase 3h ──────────────────────────────────────────────────────────────
  bookerLogin:       { scope: 'none',   auth: 'public',   fn: bookerLogin },
  bookerGetBands:    { scope: 'none',   auth: 'booker',   fn: bookerGetBands },
  bookerListOffers:  { scope: 'none',   auth: 'booker',   fn: bookerListOffers },
  bookerSaveOffer:   { scope: 'none',   auth: 'booker',   fn: bookerSaveOffer },
  bookerSendOffer:   { scope: 'none',   auth: 'booker',   fn: bookerSendOffer },
  bookerCancelOffer: { scope: 'none',   auth: 'booker',   fn: bookerCancelOffer },
  operatorListBookers:         { scope: 'master', auth: 'operator', fn: operatorListBookers },
  operatorSaveBooker:          { scope: 'master', auth: 'operator', fn: operatorSaveBooker },
  operatorDeleteBooker:        { scope: 'master', auth: 'operator', fn: operatorDeleteBooker },
  operatorResetBookerPassword: { scope: 'master', auth: 'operator', fn: operatorResetBookerPassword },

  // ── Fase 3f ──────────────────────────────────────────────────────────────
  // renderInvoicePdf er IKKE en action: den kaldes af /api/faktura-pdf-ruten,
  // som streamer bytes. Var den en action, ville PDF'en (med CPR) skulle
  // gennem et JSON-svar.
  // Navnet er frontendens (08-admin.js) og må ikke ændres. Arkivet ligger i
  // R2, ikke i Drive — se services/archive.js.
  archiveInvoiceToDrive: { scope: 'band', auth: 'admin', fn: archiveInvoice }
};

export const VALID_SCOPES = ['band', 'master', 'identity', 'none'];
export const VALID_AUTH = ['public', 'member', 'admin', 'identity', 'operator', 'booker', 'signing'];

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
