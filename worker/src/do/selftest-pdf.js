// Selvtest af Fase 3f (PDF) og Fase 6 (oprydning).
//
// Den vigtigste test her er CPR-reglen: nummeret må optræde i den HTML der
// sendes til PDF-konvertering, og INTET andet sted. Testen bygger HTML'en og
// kontrollerer begge dele — at CPR ER der (ellers er afregningen ubrugelig for
// SKAT), og at ingen action returnerer det.

import { runAction } from '../actions/router.js';
import { bandStub, masterStub } from '../lib/addressing.js';
import { sha256hex, newPasswordFields, pwIterations, randomBase64 } from '../lib/crypto.js';
import { buildInvoiceHtml } from '../lib/invoice-html.js';
import { renderInvoicePdf } from '../actions/pdf.js';

const BAND = 'selftest-f';
const ADMIN = 'chef-f@test.dk';
const KODE = 'pdf-test-kode-lang';
const CPR = '010190-1234';

export async function pdfChecks(ydreEnv, ok) {
  const env = Object.assign({}, ydreEnv, {
    MASTER_SECRET: ydreEnv.MASTER_SECRET || randomBase64(32),
    CPR_KEY: ydreEnv.CPR_KEY || randomBase64(32)
  });
  const band = bandStub(env, BAND);
  const master = masterStub(env);
  const iter = pwIterations(env);
  const hash = await sha256hex(KODE);

  await master.createBand(BAND, 'PDF-band');
  await band.syncMeta({ band_id: BAND, name: 'PDF-band', status: 'active' });
  const pf = await newPasswordFields(hash, iter);
  if (!await band.findMemberById('f-a')) {
    await band.insertMember({
      id: 'f-a', name: 'Chef', category: 'Musiker', instrument: '', phone: '',
      email: ADMIN, regAccount: '', address: '',
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      forcePasswordChange: 0, role: 'admin', createdAt: new Date().toISOString()
    });
  } else {
    await band.setMemberPassword('f-a', pf.passwordHash, pf.pwSalt, false);
  }
  await band.clearLoginAttempts(ADMIN);
  const lg = await runAction(env, 'login', { bandId: BAND, email: ADMIN, passwordHash: hash });
  const creds = { email: ADMIN, token: lg.memberToken };
  const kald = (a, p) => runAction(env, a, Object.assign({ bandId: BAND }, p), creds);

  await kald('adminSaveBillingInfo', {
    cpr: CPR, bankName: 'Sparekassen for Nr. Nebel og Omegn',
    bankReg: '9682', bankKto: '1465171',
    payeeName: 'Peter Hansen', payeeAddress: 'Vejnavn 1\n1234 By'
  });
  await kald('adminWriteConfig', {
    changes: {
      bandName: 'Danser med Drenge Tribute',
      contactName: 'Jesper Steensbeck', contactPhone: '60 24 60 60',
      contactEmail: 'jesper@steensbeck.dk',
      contactAddress: 'Frejasvej 65\n6840 Oksbøl'
    }
  });

  for (const c of await band.listContracts()) await band.deleteContract(c.id);
  await kald('saveContract', {
    contract: {
      id: 'PDF-1', type: 'Spillested', status: 'godkendt',
      arrangoer: { name: 'Værket Vejle', address: 'Havnegade 6', postnr: '7100', city: 'Vejle' },
      venue: { name: 'Værket', city: 'Vejle' },
      date: '2026-06-13', honorar: 35000,
      paymentTerms: 'Bankoverførsel hverdag efter'
    },
    attendees: [{ memberId: 'f-a', share: 35000 }]
  });

  // ── HTML-skabelonen ─────────────────────────────────────────────────────
  const settings = await band.getSettings();
  const html = buildInvoiceHtml(
    {
      arrangoer: { name: 'Værket Vejle', address: 'Havnegade 6', postnr: '7100', city: 'Vejle' },
      venue: { name: 'Værket' },
      date: '2026-06-13T00:00:00.000Z', honorar: 35000,
      paymentTerms: 'Bankoverførsel hverdag efter'
    },
    '2026-001', settings, CPR, ''
  );

  ok('invoice-html: CPR ER med (afregningen er ubrugelig uden)',
     html.includes(CPR), 'fundet ' + (html.split(CPR).length - 1) + ' gange');
  ok('invoice-html: bandnavn, bank og beløb med',
     html.includes('Danser med Drenge Tribute') && html.includes('9682') &&
     html.includes('1465171') && html.includes('35.000'),
     'beløbsformat: ' + (html.match(/[\d.]+ kr\./) || [''])[0]);
  ok('invoice-html: dansk datoformat', html.includes('13-06-2026'));
  ok('invoice-html: fakturanummer med', html.includes('2026-001'));
  ok('invoice-html: tabel-baseret layout (Drive-Docs kan ikke flexbox)',
     html.includes('<table') && !/display:\s*(flex|grid)/.test(html));
  ok('invoice-html: kontaktfod med', html.includes('Jesper Steensbeck') &&
     html.includes('60 24 60 60'));

  // HTML-escaping: et arrangørnavn med < må ikke kunne bryde dokumentet.
  const ondsindet = buildInvoiceHtml(
    { arrangoer: { name: '<script>alert(1)</script>' }, venue: {}, date: '', honorar: 0 },
    'X', settings, CPR, '');
  ok('invoice-html: escaper HTML i data',
     !ondsindet.includes('<script>') && ondsindet.includes('&lt;script&gt;'));

  // ── CPR må ikke slippe ud gennem NOGEN action ──────────────────────────
  const svar = {};
  svar.getConfig = await runAction(env, 'getConfig', { bandId: BAND });
  svar.billing = await kald('adminGetBillingInfo', {});
  svar.readConfig = await kald('adminReadConfig', {});
  svar.invoices = await kald('getInvoices', {});
  svar.honorar = await kald('getMyHonorar', {});
  svar.contracts = await kald('getContracts', {});
  svar.contract = await kald('getContract', { id: 'PDF-1' });
  svar.dashboard = await kald('getDashboard', {});
  svar.jobs = await kald('getJobs', {});
  svar.backup = await runAction(env, 'backupBand', { targetBandId: BAND },
    { operatorToken: await opToken(env, master, iter) });

  const laekkede = Object.entries(svar)
    .filter(([, v]) => JSON.stringify(v).includes(CPR) ||
                       JSON.stringify(v).includes('010190'))
    .map(([k]) => k);
  ok('CPR: lækker IKKE gennem nogen af 10 actions', laekkede.length === 0,
     laekkede.length ? 'LÆKKEDE i: ' + laekkede.join(', ') : '10 actions tjekket');

  // ── renderInvoicePdf uden sidecar ──────────────────────────────────────
  let pdfFejl = null;
  try {
    await renderInvoicePdf(env, band, BAND, 'PDF-1');
  } catch (e) {
    pdfFejl = e;
  }
  ok('renderInvoicePdf: fejler pænt når sidecaren ikke er sat op',
     pdfFejl && pdfFejl.userFacing && /ikke konfigureret/.test(pdfFejl.message),
     pdfFejl ? pdfFejl.message : 'INGEN FEJL — uventet');

  // Men nummeret skal være reserveret alligevel: et hul i rækken er bedre end
  // to fakturaer med samme nummer.
  const efterFejl = await band.listInvoices();
  ok('renderInvoicePdf: fakturanummeret reserveres selv når PDF fejler',
     efterFejl.some(i => i.contractId === 'PDF-1'),
     efterFejl.map(i => i.invoiceNr).join(', '));

  // Uden CPR skal fejlen være en anden og forklarende.
  await master.updateBand(BAND, { cprEnc: '' });
  let udenCpr = null;
  try { await renderInvoicePdf(env, band, BAND, 'PDF-1'); } catch (e) { udenCpr = e; }
  ok('renderInvoicePdf: forklarer at CPR mangler',
     udenCpr && /CPR ikke konfigureret/.test(udenCpr.message),
     udenCpr ? udenCpr.message : '-');

  const udenArkiv = await kald('archiveInvoiceToDrive', { contractId: 'PDF-1' });
  ok('archiveInvoiceToDrive: fejler pænt uden R2-binding', udenArkiv.ok === false,
     udenArkiv.error);

  // ── Arkivet: den CPR-FRIE kopi ─────────────────────────────────────────
  // Dette er filens vigtigste test efter CPR-reglen selv.
  //
  // Baggrund: den oprindelige Code.gs renderede arkivkopien med cpr = null
  // (Code.gs:2660). Ved porteringen til Workeren kaldte arkivstien i stedet
  // renderInvoicePdf, som HENTER CPR — så hver arkivering ville lægge en
  // CPR-holdig PDF i et arkiv brugeren får at vide er "uden CPR". Intet
  // eksisterende tjek fangede det, fordi testene kun så på det svar action'en
  // returnerede, og CPR'et lå inde i PDF-bytes.
  //
  // Testen aflytter derfor den HTML der faktisk sendes til konvertering.
  // CPR skal være genskabt først — ellers ville "ingen CPR i arkivet" være
  // sandt af den uinteressante grund at bandet slet ikke har et.
  await kald('adminSaveBillingInfo', {
    cpr: CPR, bankName: 'Sparekassen for Nr. Nebel og Omegn',
    bankReg: '9682', bankKto: '1465171',
    payeeName: 'Peter Hansen', payeeAddress: 'Vejnavn 1\n1234 By'
  });

  const bucket = fakeBucket();
  const sendtHtml = [];
  const rigtigFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const krop = JSON.parse(init.body);
    if (krop.op === 'renderPdf') sendtHtml.push(krop.html);
    // btoa af en kort streng — indholdet er ligegyldigt, kun at der kommer
    // gyldig base64 tilbage så resten af stien kan køre igennem.
    return new Response(JSON.stringify({ ok: true, pdfBase64: btoa('%PDF-1.4 test') }),
      { headers: { 'Content-Type': 'application/json' } });
  };

  let arkiv, arkiv2;
  try {
    const envA = Object.assign({}, env, {
      ARCHIVE: bucket,
      SIDECAR_URL: 'https://sidecar.test/exec',
      SIDECAR_TOKEN: 'test-token'
    });
    const kaldA = (a, pp) => runAction(envA, a, Object.assign({ bandId: BAND }, pp), creds);
    arkiv = await kaldA('archiveInvoiceToDrive', { contractId: 'PDF-1' });
    arkiv2 = await kaldA('archiveInvoiceToDrive', { contractId: 'PDF-1' });
  } finally {
    globalThis.fetch = rigtigFetch;
  }

  ok('arkiv: arkivering lykkes', arkiv.ok === true, arkiv.error || arkiv.archiveKey);

  const arkivHtml = sendtHtml.join('\n');
  ok('arkiv: den arkiverede kopi indeholder IKKE CPR',
     sendtHtml.length > 0 && !arkivHtml.includes(CPR) && !arkivHtml.includes('010190'),
     sendtHtml.length ? 'HTML aflyttet, intet CPR' : 'INGEN HTML AFLYTTET — testen beviser intet');
  ok('arkiv: kopien er stadig en rigtig faktura',
     arkivHtml.includes('Danser med Drenge Tribute') && arkivHtml.includes('35.000'),
     'bandnavn og beløb med');

  ok('arkiv: nøglen ligger under bandets eget præfiks',
     String(arkiv.archiveKey || '').startsWith(BAND + '/fakturaer/2026/'),
     arkiv.archiveKey);
  ok('arkiv: download-URL peger på den login-gatede rute',
     String(arkiv.archiveUrl || '').startsWith('/api/faktura-arkiv?invoiceId='),
     arkiv.archiveUrl);

  // Drive-versionen lagde en NY fil ved hver genarkivering og skulle slette den
  // gamle manuelt via replaceFileId. Nøglen her er stabil, så en genarkivering
  // overskriver i stedet for at ophobe kopier.
  ok('arkiv: genarkivering overskriver frem for at ophobe kopier',
     arkiv2.ok === true && arkiv2.archiveKey === arkiv.archiveKey &&
     bucket._antal() === 1,
     bucket._antal() + ' objekt(er) i arkivet');

  const arkiveret = (await band.listInvoices()).find(i => i.contractId === 'PDF-1');
  ok('arkiv: nøglen gemmes på fakturarækken',
     arkiveret && arkiveret.archiveKey === arkiv.archiveKey,
     arkiveret ? String(arkiveret.archiveKey) : 'faktura ikke fundet');

  // Sletning må ikke efterlade persondata liggende.
  const { deleteBandArchive } = await import('../services/archive.js');
  const tømt = await deleteBandArchive(Object.assign({}, env, { ARCHIVE: bucket }), BAND);
  ok('arkiv: sletning af band tømmer hele præfikset',
     tømt.deleted >= 1 && bucket._antal() === 0,
     tømt.deleted + ' fil(er) slettet, ' + bucket._antal() + ' tilbage');

  // ── Fase 6: oprydning ──────────────────────────────────────────────────
  await band.putSession('ryd-udloebet', { kind: 'member', subject: 'f-a', token: 't' }, -100);
  await band.putSession('ryd-aktiv', { kind: 'member', subject: 'f-a', token: 't' }, 8 * 3600);
  await band.trackLogin('f-a', ADMIN, 'gammel-browser');
  await band.putDistanceCache('gammel|rute', 'a', 'b', 10);

  const r1 = await band.runRetention(null, null);
  ok('retention: rydder udløbne sessioner', r1.sessioner >= 1, r1.sessioner + ' ryddet');
  ok('retention: aktiv session bevares',
     (await band.getSession('ryd-aktiv')) !== null);
  ok('retention: login-log bevares når politikken er tom (behold alt)',
     r1.loginLog === 0, String(r1.loginLog));

  const fremtid = new Date(Date.now() + 86400000).toISOString();
  const r2 = await band.runRetention(fremtid, fremtid);
  ok('retention: rydder login-log når en politik er sat', r2.loginLog >= 1,
     r2.loginLog + ' poster');
  ok('retention: rydder forældet afstands-cache', r2.cache >= 1, r2.cache + ' rækker');
  ok('retention: cachen er faktisk væk',
     (await band.getDistanceCache('gammel|rute')) === null);
}

async function opToken(env, master, iter) {
  const kode = 'op-f-kode-lang';
  const pf = await newPasswordFields(await sha256hex(kode), iter);
  await master.putOperator('op-f@test.dk', pf.passwordHash, pf.pwSalt);
  await master.clearOperatorLoginAttempts('op-f@test.dk');
  const r = await runAction(env, 'operatorLogin',
    { email: 'op-f@test.dk', passwordHash: await sha256hex(kode) });
  return r.token;
}

/**
 * R2-bucket i hukommelsen. Kun de fire kald services/archive.js bruger.
 *
 * En rigtig bucket kan ikke bruges i selvtesten: den ville skrive data ved hver
 * kørsel, og testen skal kunne køres igen og igen uden at efterlade noget.
 */
function fakeBucket() {
  const m = new Map();
  return {
    async put(key, bytes, opts) { m.set(String(key), { bytes, opts }); },
    async get(key) {
      const v = m.get(String(key));
      return v ? { body: v.bytes, httpMetadata: (v.opts || {}).httpMetadata || {} } : null;
    },
    async delete(key) {
      for (const k of (Array.isArray(key) ? key : [key])) m.delete(String(k));
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const alle = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      return { objects: alle.slice(0, limit).map(key => ({ key })), truncated: false };
    },
    _antal() { return m.size; }
  };
}
