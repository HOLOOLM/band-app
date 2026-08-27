// Selvtest af Fase 3g og 3h — bookings, e-signatur og booker-portalen.
//
// De vigtigste tests handler alle om at forløbet ikke kan snydes:
//   - statusmaskinen afviser handlinger fra forkert status, så den samme
//     underskrift ikke kan køres to gange og lave to godkendte kontrakter
//   - docHash binder tokenet til kontraktens indhold
//   - ALLE offentlige fejl giver samme besked (intet orakel)
//   - et medlems- eller operatør-token kan ikke bruges som signeringstoken
//   - memberNote slipper ikke ud i booking-snapshottet, som sendes til arrangøren
//   - bookere kan ikke se eller redigere hinandens tilbud

import { runAction } from '../actions/router.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { issueToken } from '../lib/tokens.js';

const BAND = 'selftest-g';
const ADMIN = 'chef-g@test.dk';
const KODE = 'booking-admin-kode';
const ARR_EMAIL = 'arrangoer@spillested.dk';
const BOOKER = 'agent@bureau.dk';
const BOOKER2 = 'anden-agent@bureau.dk';

export async function bookingChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32)
  });
  const band = bandStub(env, BAND);
  const master = masterStub(env);
  const iter = pwIterations(env);
  const hash = await sha256hex(KODE);

  await master.createBand(BAND, 'Booking-band');
  await band.syncMeta({ band_id: BAND, name: 'Booking-band', status: 'active', booking: '0' });
  const pf = await newPasswordFields(hash, iter);
  if (!await band.findMemberById('g-a')) {
    await band.insertMember({
      id: 'g-a', name: 'Chef', category: 'Musiker', instrument: '', phone: '',
      email: ADMIN, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 0, role: 'admin', createdAt: new Date().toISOString()
    });
  } else {
    await band.setMemberPassword('g-a', pf.passwordHash, pf.pwSalt, false);
  }
  await band.clearLoginAttempts(ADMIN);
  const lg = await runAction(env, 'login', { bandId: BAND, email: ADMIN, passwordHash: hash });
  ok('3g-opsætning: admin kan logge ind', lg.ok === true, lg.error);
  const creds = { email: ADMIN, token: lg.memberToken };
  const kald = (a, p) => runAction(env, a, Object.assign({ bandId: BAND }, p), creds);

  // ── Feature-flaget gater ALT ─────────────────────────────────────────────
  const iMorgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const c of await band.listContracts()) await band.deleteContract(c.id);
  await kald('saveContract', {
    contract: {
      id: 'BK-1', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Spillestedet', contactName: 'Lise', email: ARR_EMAIL },
      venue: { name: 'Værket', address: 'Havnegade 6', postnr: '7100', city: 'Vejle' },
      date: iMorgen, honorar: 35000,
      memberNote: 'BANDINTERN-NOTE-parkering-bagved'
    },
    attendees: [{ memberId: 'g-a', share: 35000 }]
  });

  const slukket = await kald('sendContractForSigning', { contractId: 'BK-1' });
  ok('booking: alt afvises når feature-flaget er slukket',
     slukket.ok === false && /ikke aktiveret/.test(slukket.error), slukket.error);
  const tomListe = await kald('listIncomingBookings', {});
  ok('booking: listen er TOM (ikke en fejl) når flaget er slukket',
     tomListe.ok === true && tomListe.bookings.length === 0);

  await master.updateBand(BAND, { booking: 1 });
  await band.syncMeta({ booking: '1' });

  // ── Send til underskrift ─────────────────────────────────────────────────
  const udenMail = await kald('saveContract', {
    contract: {
      id: 'BK-2', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Uden mail' }, venue: { name: 'X' },
      date: iMorgen, honorar: 1000
    },
    attendees: []
  });
  const manglerMail = await kald('sendContractForSigning', { contractId: 'BK-2' });
  ok('sendContractForSigning: kræver gyldig arrangør-e-mail',
     manglerMail.ok === false && /e-mail/.test(manglerMail.error), manglerMail.error);

  const sendt = await kald('sendContractForSigning', { contractId: 'BK-1' });
  ok('sendContractForSigning: opretter booking', sendt.ok === true && sendt.bookingId,
     sendt.error);
  const bookingId = sendt.bookingId;

  const igen = await kald('sendContractForSigning', { contractId: 'BK-1' });
  ok('sendContractForSigning: afviser dobbelt aktivt forløb',
     igen.ok === false && /aktivt underskriftsforløb/.test(igen.error), igen.error);

  const ukendtK = await kald('sendContractForSigning', { contractId: 'findes-ikke' });
  ok('sendContractForSigning: ukendt kontrakt afvises', ukendtK.ok === false, ukendtK.error);

  // KERNEN: memberNote må ikke ind i snapshottet, som sendes til arrangøren.
  const rawBooking = await band.getBooking(bookingId);
  ok('sendContractForSigning: memberNote er IKKE med i booking-snapshottet',
     !String(rawBooking.contractDraft).includes('BANDINTERN-NOTE'),
     'draft er ' + String(rawBooking.contractDraft).length + ' tegn');

  // ── Statusmaskinen ──────────────────────────────────────────────────────
  const forTidligtGensend = await kald('resendSigningLink', { bookingId });
  ok('resendSigningLink: kan ikke gensendes fra status "sent"',
     forTidligtGensend.ok === false, forTidligtGensend.error);

  const utenNavn = await kald('approveAndSignBooking', { bookingId, typedName: '' });
  ok('approveAndSignBooking: kræver indtastet navn', utenNavn.ok === false, utenNavn.error);

  const gammelTs = new Date(Date.now() - 60000).toISOString();
  const konflikt = await kald('approveAndSignBooking',
    { bookingId, typedName: 'Chef Chefsen', expectedUpdatedAt: gammelTs });
  ok('approveAndSignBooking: forældet expectedUpdatedAt giver conflict',
     konflikt.ok === false && konflikt.conflict === true, konflikt.error);

  const godkendt = await kald('approveAndSignBooking',
    { bookingId, typedName: 'Chef Chefsen', appOrigin: 'https://band-app.example' });
  ok('approveAndSignBooking: bandet underskriver', godkendt.ok === true, godkendt.error);
  ok('approveAndSignBooking: mail fejler pænt uden Resend, og linket returneres',
     godkendt.mailSendt === false && typeof godkendt.signUrl === 'string' &&
     godkendt.signUrl.includes('/sign?t='),
     'mailSendt=' + godkendt.mailSendt);

  const igenGodkend = await kald('approveAndSignBooking', { bookingId, typedName: 'Chef' });
  ok('approveAndSignBooking: kan ikke godkendes to gange',
     igenGodkend.ok === false && /status/.test(igenGodkend.error), igenGodkend.error);

  const efterGodkend = await band.getBooking(bookingId);
  ok('approveAndSignBooking: docHash og bandSignature gemt',
     efterGodkend.docHash && efterGodkend.docHash.length === 64 &&
     String(efterGodkend.bandSignature).includes('Chef Chefsen'),
     'docHash ' + String(efterGodkend.docHash).slice(0, 12) + '…');

  // Udtræk tokenet fra linket.
  const token = decodeURIComponent(godkendt.signUrl.split('t=')[1]);
  ok('signeringstoken: har bk:-præfiks', token.startsWith('bk:'), token.slice(0, 10));

  // ── Det offentlige signeringsflow ───────────────────────────────────────
  const kaldOff = (a, p) => runAction(env, a, p || {}, null);

  const syn = await kaldOff('getSignableBooking', { t: token });
  ok('getSignableBooking: gyldigt token viser kontrakten',
     syn.ok === true && syn.status === 'band_signed' && syn.draft &&
     syn.draft.venue.name === 'Værket', syn.error);
  ok('getSignableBooking: bandets underskrift er med', syn.bandSignature &&
     syn.bandSignature.name === 'Chef Chefsen');
  ok('getSignableBooking: memberNote lækkes ikke til arrangøren',
     !JSON.stringify(syn).includes('BANDINTERN-NOTE'));
  ok('getSignableBooking: honorar ER med (arrangøren skal se prisen)',
     syn.draft.honorar === 35000, String(syn.draft.honorar));

  // Alle fejl skal give SAMME besked — intet orakel.
  const FEJL = 'Linket er ugyldigt eller udløbet.';
  const svar = {};
  svar.tom = await kaldOff('getSignableBooking', { t: '' });
  svar.vroevl = await kaldOff('getSignableBooking', { t: 'bk:vrøvl.vrøvl' });
  svar.manipuleret = await kaldOff('getSignableBooking', { t: token.slice(0, -1) + 'X' });
  svar.andenNoegle = await runAction(
    Object.assign({}, env, { MASTER_SECRET: randomBase64(32) }),
    'getSignableBooking', { t: token }, null);
  const udloebet = await issueToken(env, 'arr-sign',
    { bookingId, bandId: BAND, docHash: efterGodkend.docHash, v: 1 }, -10);
  svar.udloebet = await kaldOff('getSignableBooking', { t: udloebet });
  const forkertHash = await issueToken(env, 'arr-sign',
    { bookingId, bandId: BAND, docHash: 'f'.repeat(64), v: 1 }, 3600);
  svar.forkertHash = await kaldOff('getSignableBooking', { t: forkertHash });
  const ukendtBooking = await issueToken(env, 'arr-sign',
    { bookingId: 'bkg999999', bandId: BAND, docHash: efterGodkend.docHash, v: 1 }, 3600);
  svar.ukendtBooking = await kaldOff('getSignableBooking', { t: ukendtBooking });

  const beskeder = Object.entries(svar).map(([k, v]) => k + '=' + (v.error || 'OK!'));
  ok('getSignableBooking: ALLE afvisninger giver samme besked (intet orakel)',
     Object.values(svar).every(v => v.ok === false && v.error === FEJL),
     beskeder.join(', '));

  // Rolleforvirring: et medlems-token må ikke virke som signeringstoken.
  ok('signering: medlems-token afvises som signeringstoken',
     (await kaldOff('getSignableBooking', { t: lg.memberToken })).error === FEJL);
  const opTok = await issueToken(env, 'operator', { email: 'op@x.dk' }, 3600);
  ok('signering: operatør-token afvises som signeringstoken',
     (await kaldOff('getSignableBooking', { t: opTok })).error === FEJL);

  // ── Arrangøren underskriver ─────────────────────────────────────────────
  const utenNavn2 = await kaldOff('submitArrangoerSignature', { t: token, typedName: '' });
  ok('submitArrangoerSignature: kræver navn',
     utenNavn2.ok === false && /navn/.test(utenNavn2.error), utenNavn2.error);

  const underskrevet = await kaldOff('submitArrangoerSignature',
    { t: token, typedName: 'Lise Hansen', clientIp: '1.2.3.4', userAgent: 'TestBrowser' });
  ok('submitArrangoerSignature: arrangøren underskriver',
     underskrevet.ok === true && underskrevet.status === 'completed', underskrevet.error);
  ok('submitArrangoerSignature: kontrakten peges på', underskrevet.contractId === 'BK-1',
     underskrevet.contractId);

  const kontraktEfter = await band.getContract('BK-1');
  ok('submitArrangoerSignature: kontrakten er GODKENDT',
     kontraktEfter.contract.status === 'godkendt', kontraktEfter.contract.status);

  // Dobbelt-underskrift må ikke lave to godkendte kontrakter.
  const antalFoer = (await band.listContracts()).length;
  const dobbelt = await kaldOff('submitArrangoerSignature',
    { t: token, typedName: 'Lise Hansen' });
  ok('submitArrangoerSignature: kan ikke underskrives to gange',
     dobbelt.ok === false && /allerede underskrevet/.test(dobbelt.error), dobbelt.error);
  ok('submitArrangoerSignature: ingen ekstra kontrakt oprettet ved gentagelse',
     (await band.listContracts()).length === antalFoer,
     antalFoer + ' → ' + (await band.listContracts()).length);

  const efterFaerdig = await kaldOff('getSignableBooking', { t: token });
  ok('getSignableBooking: færdig booking viser kvittering frem for fejl',
     efterFaerdig.ok === true && efterFaerdig.status === 'completed');

  const kanIkkeAnnullere = await kald('cancelBooking', { bookingId });
  ok('cancelBooking: en færdig booking kan ikke annulleres',
     kanIkkeAnnullere.ok === false, kanIkkeAnnullere.error);

  // ── Afvisningsvejene ────────────────────────────────────────────────────
  await kald('saveContract', {
    contract: {
      id: 'BK-3', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Nr3', email: ARR_EMAIL }, venue: { name: 'Sted3' },
      date: iMorgen, honorar: 5000
    },
    attendees: []
  });
  const b3 = await kald('sendContractForSigning', { contractId: 'BK-3' });
  const afvist = await kald('declineBooking', { bookingId: b3.bookingId, reason: 'Optaget' });
  ok('declineBooking: bandet kan afvise fra "sent"', afvist.ok === true, afvist.error);
  ok('declineBooking: begrundelsen gemmes',
     afvist.booking.declineReason === 'Optaget', afvist.booking.declineReason);

  await kald('saveContract', {
    contract: {
      id: 'BK-4', type: 'Spillested', status: 'udkast',
      arrangoer: { name: 'Nr4', email: ARR_EMAIL }, venue: { name: 'Sted4' },
      date: iMorgen, honorar: 5000
    },
    attendees: []
  });
  const b4 = await kald('sendContractForSigning', { contractId: 'BK-4' });
  const g4 = await kald('approveAndSignBooking',
    { bookingId: b4.bookingId, typedName: 'Chef', appOrigin: 'https://x.dk' });
  const tok4 = decodeURIComponent(g4.signUrl.split('t=')[1]);
  const arrAfvist = await kaldOff('declineByArrangoer', { t: tok4, reason: 'For dyrt' });
  ok('declineByArrangoer: arrangøren kan afvise', arrAfvist.ok === true, arrAfvist.error);
  const b4Efter = await band.getBooking(b4.bookingId);
  ok('declineByArrangoer: status er arr_declined og begrundelsen gemt',
     b4Efter.status === 'arr_declined' && b4Efter.declineReason === 'For dyrt',
     b4Efter.status);
  ok('declineByArrangoer: kontrakten blev IKKE godkendt',
     (await band.getContract('BK-4')).contract.status === 'udkast');
  const efterAfvisning = await kaldOff('submitArrangoerSignature',
    { t: tok4, typedName: 'Lise' });
  ok('declineByArrangoer: kan ikke underskrive efter afvisning',
     efterAfvisning.ok === false, efterAfvisning.error);

  // Historikken skal dokumentere hele forløbet.
  const hist = JSON.parse(b4Efter.history || '[]');
  ok('booking: historikken dokumenterer hvert skridt',
     hist.length >= 3 && hist[0].to === 'sent' &&
     hist.some(h => h.to === 'band_signed') && hist.some(h => h.to === 'arr_declined'),
     hist.map(h => h.to).join(' → '));

  // Slås featuren fra midt i et forløb, holder linket op med at virke.
  await band.syncMeta({ booking: '0' });
  ok('booking: udestående link holder op med at virke når featuren slås fra',
     (await kaldOff('getSignableBooking', { t: tok4 })).error === FEJL);
  await band.syncMeta({ booking: '1' });

  // ── Fase 3h: booker-portalen ────────────────────────────────────────────
  const opPf = await newPasswordFields(await sha256hex('op-kode-lang'), iter);
  await master.putOperator('op-g@test.dk', opPf.passwordHash, opPf.pwSalt);
  await master.clearOperatorLoginAttempts('op-g@test.dk');
  const opLg = await runAction(env, 'operatorLogin',
    { email: 'op-g@test.dk', passwordHash: await sha256hex('op-kode-lang') });
  const opCreds = { operatorToken: opLg.token };

  await master.deleteBooker(BOOKER);
  await master.deleteBooker(BOOKER2);

  const nyBooker = await runAction(env, 'operatorSaveBooker',
    { email: BOOKER, name: 'Agent A', agency: 'Bureau ApS', bandIds: [BAND] }, opCreds);
  ok('operatorSaveBooker: opretter booker med midlertidig kode',
     nyBooker.ok === true && nyBooker.isNew === true &&
     typeof nyBooker.tempPassword === 'string' && nyBooker.tempPassword.length === 14,
     nyBooker.error);

  const booker2 = await runAction(env, 'operatorSaveBooker',
    { email: BOOKER2, name: 'Agent B', agency: 'Andet Bureau', bandIds: [BAND] }, opCreds);

  await master.clearBookerLoginAttempts(BOOKER);
  const bForkert = await runAction(env, 'bookerLogin',
    { email: BOOKER, passwordHash: await sha256hex('nej') });
  ok('bookerLogin: forkert kode giver generisk besked',
     bForkert.ok === false && bForkert.error === 'Forkert email eller adgangskode',
     bForkert.error);
  // Den ukendte e-mail har sin EGEN rate-limit-tæller, som også skal ryddes —
  // ellers låser den efter fem suite-kørsler og testen bliver flaky.
  await master.clearBookerLoginAttempts('findes-ikke@x.dk');
  const bUkendt = await runAction(env, 'bookerLogin',
    { email: 'findes-ikke@x.dk', passwordHash: await sha256hex('nej') });
  ok('bookerLogin: ukendt konto giver SAMME besked som forkert kode',
     bUkendt.error === bForkert.error, bUkendt.error);
  await master.clearBookerLoginAttempts(BOOKER);

  const bLg = await runAction(env, 'bookerLogin',
    { email: BOOKER, passwordHash: await sha256hex(nyBooker.tempPassword) });
  ok('bookerLogin: korrekt kode giver token',
     bLg.ok === true && typeof bLg.token === 'string', bLg.error);
  ok('bookerLogin: tvinger kodeskift første gang', bLg.forcePasswordChange === true);
  const bCreds = { bookerToken: bLg.token };
  const kaldB = (a, p) => runAction(env, a, p || {}, bCreds);

  const bBands = await kaldB('bookerGetBands');
  ok('bookerGetBands: kun bands på adgangslisten',
     bBands.ok === true && bBands.bands.length === 1 && bBands.bands[0].bandId === BAND,
     JSON.stringify(bBands.bands.map(b => b.bandId)));

  const utenAdgang = await kaldB('bookerSaveOffer',
    { bandId: 'selftest-e', offer: { venue: { name: 'Kapret' } } });
  ok('bookerSaveOffer: afviser band uden adgang',
     utenAdgang.ok === false && /Ingen adgang/.test(utenAdgang.error), utenAdgang.error);

  const kladde = await kaldB('bookerSaveOffer', {
    bandId: BAND,
    offer: {
      type: 'Festival', venue: { name: 'Roskilde', city: 'Roskilde' },
      arrangoer: { name: 'Festivalen', contactName: 'Ole', email: ARR_EMAIL },
      date: iMorgen, honorar: 80000,
      memberNote: 'FORSØG-PÅ-BANDINTERN-NOTE'
    }
  });
  ok('bookerSaveOffer: opretter kladde', kladde.ok === true && kladde.offerId, kladde.error);

  const kladdeRow = await band.getBooking(kladde.offerId);
  ok('bookerSaveOffer: booker kan IKKE indføre memberNote',
     !String(kladdeRow.contractDraft).includes('FORSØG-PÅ-BANDINTERN'),
     'draft renset');
  ok('bookerSaveOffer: tilbuddet har intet kontraktnummer endnu',
     !kladdeRow.contractId, JSON.stringify(kladdeRow.contractId));

  const bList = await kaldB('bookerListOffers');
  ok('bookerListOffers: bookeren ser sit eget tilbud',
     bList.ok === true && bList.offers.some(o => o.id === kladde.offerId),
     (bList.offers || []).length + ' tilbud');

  // Anden bookers isolation.
  await master.clearBookerLoginAttempts(BOOKER2);
  const b2Lg = await runAction(env, 'bookerLogin',
    { email: BOOKER2, passwordHash: await sha256hex(booker2.tempPassword) });
  const b2Creds = { bookerToken: b2Lg.token };
  const b2List = await runAction(env, 'bookerListOffers', {}, b2Creds);
  ok('bookerListOffers: en booker ser IKKE en andens tilbud',
     b2List.ok === true && !b2List.offers.some(o => o.id === kladde.offerId),
     (b2List.offers || []).length + ' tilbud');
  const b2Rediger = await runAction(env, 'bookerSaveOffer',
    { offerId: kladde.offerId, offer: { venue: { name: 'Kapret' } } }, b2Creds);
  ok('bookerSaveOffer: en booker kan IKKE redigere en andens tilbud',
     b2Rediger.ok === false, b2Rediger.error);

  const sendtTilbud = await kaldB('bookerSendOffer', { offerId: kladde.offerId });
  ok('bookerSendOffer: sender tilbuddet til bandet',
     sendtTilbud.ok === true && sendtTilbud.offer.status === 'sent', sendtTilbud.error);

  const redigerEfterSend = await kaldB('bookerSaveOffer',
    { offerId: kladde.offerId, offer: { honorar: 1 } });
  ok('bookerSaveOffer: kun kladder kan redigeres',
     redigerEfterSend.ok === false && /kladder/.test(redigerEfterSend.error),
     redigerEfterSend.error);

  // Bandet ser tilbuddet og fører det hele vejen til en NY kontrakt.
  const indgaaende = await kald('listIncomingBookings', {});
  ok('listIncomingBookings: bandet ser bookerens tilbud',
     indgaaende.bookings.some(b => b.id === kladde.offerId));

  const antalKontrakterFoer = (await band.listContracts()).length;
  const gTilbud = await kald('approveAndSignBooking',
    { bookingId: kladde.offerId, typedName: 'Chef', appOrigin: 'https://x.dk' });
  ok('approveAndSignBooking: bandet godkender bookerens tilbud', gTilbud.ok === true,
     gTilbud.error);
  const tokTilbud = decodeURIComponent(gTilbud.signUrl.split('t=')[1]);
  const arrSkriver = await kaldOff('submitArrangoerSignature',
    { t: tokTilbud, typedName: 'Ole Olsen' });
  ok('submitArrangoerSignature: booker-tilbud giver en NY kontrakt',
     arrSkriver.ok === true && arrSkriver.contractId &&
     (await band.listContracts()).length === antalKontrakterFoer + 1,
     'ny kontrakt: ' + arrSkriver.contractId);
  const nyKontrakt = await band.getContract(arrSkriver.contractId);
  ok('submitArrangoerSignature: den nye kontrakt er godkendt og har tilbuddets data',
     nyKontrakt.contract.status === 'godkendt' &&
     JSON.parse(nyKontrakt.contract.venue).name === 'Roskilde',
     nyKontrakt.contract.status);
  ok('submitArrangoerSignature: den nye kontrakt har TOM memberNote',
     !nyKontrakt.contract.memberNote, JSON.stringify(nyKontrakt.contract.memberNote));

  // Annullering.
  const kladde2 = await kaldB('bookerSaveOffer',
    { bandId: BAND, offer: { venue: { name: 'Aflyses' }, arrangoer: { email: ARR_EMAIL } } });
  const annulleret = await kaldB('bookerCancelOffer',
    { offerId: kladde2.offerId, reason: 'Kunden trak sig' });
  ok('bookerCancelOffer: bookeren kan annullere sin kladde',
     annulleret.ok === true && annulleret.offer.status === 'cancelled', annulleret.error);

  // Gates.
  const udenTok = await runAction(env, 'bookerListOffers', {}, null);
  ok('gate: booker-actions kræver booker-token', udenTok.ok === false, udenTok.error);
  const medMedlemsTok = await runAction(env, 'bookerListOffers', {},
    { bookerToken: lg.memberToken });
  ok('gate: medlems-token virker IKKE som booker-token', medMedlemsTok.ok === false,
     medMedlemsTok.error);

  const deaktiveret = await runAction(env, 'operatorSaveBooker',
    { email: BOOKER2, status: 'suspended' }, opCreds);
  await master.clearBookerLoginAttempts(BOOKER2);
  const suspLogin = await runAction(env, 'bookerLogin',
    { email: BOOKER2, passwordHash: await sha256hex(booker2.tempPassword) });
  ok('bookerLogin: deaktiveret konto afvises med generisk besked',
     suspLogin.ok === false && suspLogin.error === 'Forkert email eller adgangskode',
     suspLogin.error);

  const nulstil = await runAction(env, 'operatorResetBookerPassword',
    { email: BOOKER }, opCreds);
  ok('operatorResetBookerPassword: giver ny midlertidig kode',
     nulstil.ok === true && nulstil.tempPassword.length === 14, nulstil.error);
  await master.clearBookerLoginAttempts(BOOKER);
  ok('operatorResetBookerPassword: den nye kode virker',
     (await runAction(env, 'bookerLogin',
       { email: BOOKER, passwordHash: await sha256hex(nulstil.tempPassword) })).ok === true);

  const slettet = await runAction(env, 'operatorDeleteBooker', { email: BOOKER2 }, opCreds);
  ok('operatorDeleteBooker: sletter booker', slettet.ok === true, slettet.error);
  ok('operatorDeleteBooker: kontoen findes ikke længere',
     (await master.getBooker(BOOKER2)) === null);
}
