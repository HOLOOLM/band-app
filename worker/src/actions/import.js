// Migrering fra DMDT-prototypen ind i det nye datalag.
//
// Prototypen har intet eksport-endpoint, og dens data ligger i sit EGET Google
// Sheet bag sit eget Apps Script-deployment — et andet end det sidecaren
// overtog. `apps-script/Eksporter-fra-prototype.gs` læser regnearket og lægger
// en JSON-fil i Drive; disse to actions tager imod den.
//
// De to skemaer stammer fra samme kodebase, så kolonnerne matcher næsten felt
// for felt. Oversættelsen herunder er derfor kort — den håndterer kun de steder
// hvor modellerne reelt er skredet fra hinanden.

import { sha256hex, newPasswordFields, pwIterations, b64ToBytes } from '../lib/crypto.js';
import { masterStub, bandStub } from '../lib/addressing.js';
import { genTempPassword } from './members.js';
import { registerIdentity } from '../auth/identity.js';
import { archiveConfigured, invoiceKey, putInvoicePdf } from '../services/archive.js';

/** Apps Script leverer tal og datoer som andet end strenge. Ensret dem. */
function tekst(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * importBandData — skriver prototypens datasæt ind i et band.
 *
 * ── HVAD DER IKKE FØLGER MED, OG HVORFOR ────────────────────────────────────
 *
 * **Adgangskoder.** Prototypen gemmer en hash fra en ældre generation, som
 * lib/crypto.js bevidst ikke længere accepterer — kun `pbkdf2$<iter>$<b64>`.
 * Hvert medlem får derfor en ny startkode og tvinges til at skifte. Koderne
 * returneres ÉN gang i svaret; de kan ikke hentes frem igen bagefter, og det er
 * med vilje: en liste over gyldige adgangskoder må ikke kunne genkaldes.
 *
 * **CPR pr. medlem.** Prototypens Members-ark har en cpr-kolonne. Den nye model
 * har ÉT band-CPR, krypteret med CPR_KEY og gemt i master. Der findes ingen
 * kolonne at lægge dem i, og de skrives derfor ingen steder — heller ikke i en
 * log. Bandets eget CPR indtastes under Indstillinger.
 *
 * **LoginLog.** Ren historik uden værdi i det nye lag.
 */
export async function importBandData(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.targetBandId || p.bandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };

  const data = p.data;
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'data mangler — send indholdet af eksportfilen' };
  }

  const master = masterStub(env);
  const bandRow = await master.getBand(bandId);
  if (!bandRow) return { ok: false, error: 'Ukendt band: ' + bandId };

  const band = bandStub(env, bandId);

  // ── VÆRN MOD AT OVERSKRIVE ET BAND DER ALLEREDE ER I BRUG ─────────────────
  // Importen skriver med INSERT OR REPLACE på id. Det gør den idempotent, men
  // det betyder også at et id fra prototypen overskriver en eksisterende række
  // med samme id — uden at sige noget.
  //
  // Og de KOLLIDERER: registerTenant opretter bandets admin som `m1`
  // (operator.js:266), og prototypens medlemmer starter samme sted. En import
  // ind i et nyoprettet band ville altså erstatte den administrator operatøren
  // netop har fået udleveret en kode til, med et medlem fra regnearket.
  //
  // Derfor kræves `overskriv: true` når bandet allerede har medlemmer. Det
  // koster ét ekstra bevidst valg og fjerner en fejl der ellers først opdages
  // næste gang nogen ikke kan logge ind.
  const foer = await band.summaryStats();
  if (Number(foer.members) > 0 && p.overskriv !== true) {
    return {
      ok: false,
      error: 'Bandet har allerede ' + foer.members + ' medlem(mer). En import ' +
             'overskriver rækker med samme id — og bandets admin har typisk ' +
             'id m1, præcis som prototypens første medlem. Opret et tomt band ' +
             'til importen, eller send overskriv: true hvis du er sikker.'
    };
  }

  const iter = pwIterations(env);

  // Startkoderne dannes HER og ikke inde i objektet: PBKDF2 er asynkron og kan
  // ikke køre i transactionSync.
  const medlemmer = [];
  const koder = [];
  for (const m of (data.Members || data.members || [])) {
    const id = tekst(m.id).trim();
    const email = tekst(m.email).toLowerCase().trim();
    if (!id || !email) continue;

    const startkode = genTempPassword();
    const pf = await newPasswordFields(await sha256hex(startkode), iter);
    medlemmer.push({
      id, email,
      name: tekst(m.name), category: tekst(m.category),
      instrument: tekst(m.instrument), phone: tekst(m.phone),
      regAccount: tekst(m.regAccount), address: tekst(m.address),
      role: tekst(m.role) === 'admin' ? 'admin' : 'member',
      createdAt: tekst(m.createdAt),
      passwordHash: pf.passwordHash, pwSalt: pf.pwSalt,
      _pf: pf
    });
    koder.push({ email, navn: tekst(m.name), startkode });
  }

  const r = await band.importAll({
    members: medlemmer,
    contracts: (data.Contracts || data.contracts || []).map(c => ({
      id: tekst(c.id), type: tekst(c.type), status: tekst(c.status),
      arrangoer: tekst(c.arrangoer), venue: tekst(c.venue),
      date: tekst(c.date).slice(0, 10),
      getIn: tekst(c.getIn), soundcheck: tekst(c.soundcheck),
      showtimeFrom: tekst(c.showtimeFrom), showtimeTo: tekst(c.showtimeTo),
      sets: c.sets, setMinutes: c.setMinutes,
      musicianCount: c.musicianCount, crewCount: c.crewCount, guestCount: c.guestCount,
      honorar: c.honorar,
      paymentTerms: tekst(c.paymentTerms), paymentTermsOther: tekst(c.paymentTermsOther),
      notes: tekst(c.notes),
      createdAt: tekst(c.createdAt), updatedAt: tekst(c.updatedAt)
    })),
    attendances: (data.Attendances || data.attendances || []).map(a => ({
      id: tekst(a.id), contractId: tekst(a.contractId), memberId: tekst(a.memberId),
      share: a.share, status: tekst(a.status),
      confirmedAt: tekst(a.confirmedAt), checkedInAt: tekst(a.checkedInAt),
      startAddress: tekst(a.startAddress),
      distanceKm: a.distanceKm, distanceOrigin: tekst(a.distanceOrigin)
    })),
    invoices: (data.Invoices || data.invoices || []).map(i => ({
      id: tekst(i.id), contractId: tekst(i.contractId),
      invoiceNr: tekst(i.invoiceNr),
      date: tekst(i.date).slice(0, 10), amount: i.amount,
      status: tekst(i.status), driveFileId: tekst(i.driveFileId),
      driveUrl: tekst(i.driveUrl),
      createdAt: tekst(i.createdAt), paidAt: tekst(i.paidAt)
    })),
    distanceCache: (data.DistanceCache || data.distanceCache || []).map(k => ({
      key: tekst(k.key), origin: tekst(k.origin), destination: tekst(k.destination),
      km: k.km, cachedAt: tekst(k.cachedAt)
    }))
  });

  // Identitetskort, så SSO på tværs af bands virker for de importerede. En
  // fejl her må ikke rulle importen tilbage: dataene er skrevet, og et
  // manglende identitetskort rettes ved næste kodeskift.
  for (const m of medlemmer) {
    try {
      await registerIdentity(env, m.email, bandId, m._pf);
    } catch (e) {
      console.warn('importBandData: identitet fejlede for ' + m.email + ': ' +
                   (e && e.message || e));
    }
  }

  // Operatørlistens statistik ligger i master og opdateres normalt af
  // kontrakt-actions. Uden dette ville bandet stå med 0 medlemmer i listen
  // indtil nogen tilfældigvis gemte en kontrakt.
  try {
    const s = await band.summaryStats();
    await master.reportStats(bandId, s.members, s.upcoming);
  } catch (e) {
    console.warn('importBandData: statistik kunne ikke opdateres: ' + (e && e.message || e));
  }

  await master.audit(operator.email, 'data-importeret', bandId,
    JSON.stringify(r.importeret));

  return {
    ok: true,
    importeret: r.importeret,
    taellere: r.taellere,
    startkoder: koder,
    bemaerk: 'Adgangskoder kunne ikke migreres (anden KDF). Hvert medlem skal ' +
             'have sin startkode og skifte den ved første login. CPR pr. medlem ' +
             'er IKKE importeret — indtast bandets CPR under Indstillinger.'
  };
}

/**
 * importInvoicePdfs — lægger prototypens arkiverede PDF'er i R2.
 *
 * Bevarer de originale dokumenter frem for at gendanne dem. Det er valgt
 * bevidst: en honorarafregning der er sendt til en arrangør, bør arkiveres som
 * netop det der blev sendt.
 *
 * Prototypen fjernede CPR i browseren med et regulært udtryk før upload
 * (index.html:3053), altså ikke strukturelt som det nye lag gør. Filerne er
 * bekræftet CPR-frie ved gennemsyn, og dét er grundlaget for at lægge dem i et
 * arkiv der lover at være uden.
 *
 * Kaldes i portioner, fordi eksporten leveres i portioner.
 */
export async function importInvoicePdfs(ctx) {
  const { env, p, operator } = ctx;
  const bandId = String(p.targetBandId || p.bandId || '').trim();
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  if (!archiveConfigured(env)) {
    return { ok: false, error: 'R2-arkivet er ikke sat op (bindingen ARCHIVE mangler)' };
  }

  const liste = Array.isArray(p.pdfer) ? p.pdfer : [];
  if (!liste.length) return { ok: false, error: 'pdfer mangler eller er tom' };

  const band = bandStub(env, bandId);
  const lagt = [];
  const fejlet = [];

  for (const post of liste) {
    const invoiceId = String((post && post.invoiceId) || '').trim();
    const b64 = String((post && post.pdfBase64) || '');
    if (!invoiceId || !b64) { fejlet.push({ invoiceId, grund: 'mangler felter' }); continue; }

    const inv = await band.getInvoice(invoiceId);
    if (!inv) { fejlet.push({ invoiceId, grund: 'ukendt faktura' }); continue; }

    const aar = String(inv.date || '').slice(0, 4) ||
                String(inv.createdAt || '').slice(0, 4) || 'ukendt';
    const key = invoiceKey(bandId, aar, inv.invoiceNr, inv.id);
    try {
      await putInvoicePdf(env, key, b64ToBytes(b64), 'Faktura ' + inv.invoiceNr + '.pdf');
      await band.setInvoiceArchive(inv.id, key);
      lagt.push(inv.invoiceNr);
    } catch (e) {
      console.error('importInvoicePdfs: ' + invoiceId + ': ' + (e && e.stack || e));
      fejlet.push({ invoiceId, grund: 'kunne ikke gemmes' });
    }
  }

  await masterStub(env).audit(operator.email, 'faktura-pdf-importeret', bandId,
    lagt.length + ' arkiveret');

  return { ok: true, arkiveret: lagt.length, fakturaer: lagt, fejlet };
}
