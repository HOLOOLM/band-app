/* ───────────────────────────────────────────────────────────────────────────
   IMPORT AF PROTOTYPENS DATA — køres i browserens konsol

   Der findes ingen knap til importen i operatør-panelet; actionen er kun
   nået via /api/call. Operatør-tokenet ligger server-side i en httpOnly
   cookie, så et kald FRA panelets egen fane er den eneste vej ind uden at
   grave tokenet ud af KV.

   SÅDAN
     1. Åbn  https://band-app.jonasholm.workers.dev/?band=__operator
     2. Log ind som operatør
     3. F12 → Console → indsæt HELE denne fil → Enter
     4. Følg de to kommandoer konsollen skriver

   Filen du vælger indeholder CPR. Luk fanen når du er færdig — kør
   `glemAlt()` først, så JSON'en ikke bliver liggende i sidens hukommelse.
   ─────────────────────────────────────────────────────────────────────────── */

(() => {
  const kald = (body) => fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  }).then(r => r.json());

  window.__eksport = null;

  window.laesFil = () => new Promise((ok) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return ok(null);
      const d = JSON.parse(await f.text());
      window.__eksport = d;

      console.log('%cIndlæst: ' + f.name, 'font-weight:bold');
      console.table(['Members', 'Contracts', 'Attendances', 'Invoices',
                     'Riders', 'DistanceCache']
        .map(k => ({ ark: k, raekker: (d[k] || []).length })));

      // CPR vises IKKE. Kun om der er noget at indtaste bagefter.
      console.log('Band-CPR i eksporten: ' + (d._bandCpr ? 'JA — kør visCpr()' : 'nej'));

      // Har nogen faktura et driveFileId, findes der arkiverede PDF'er i
      // prototypens Drive, og eksporterPdfer() skal køres. HANDOVER antog nej
      // ud fra tre afregninger; arket har 18 rækker, så det skal måles.
      const fakt = d.Invoices || [];
      const medPdf = fakt.filter(i => String(i.driveFileId || '').trim() !== '');
      console.log('Fakturaer med arkiveret PDF: ' + medPdf.length + ' af ' + fakt.length +
                  (medPdf.length ? '  → kør eksporterPdfer(0) i prototypen'
                                 : '  → ingen PDF-filer at flytte'));
      if (medPdf.length) console.table(medPdf.map(i => ({
        nr: i.invoiceNr, dato: i.date, beloeb: i.amount, status: i.status
      })));

      const m = (d.Members || []).map(x => ({
        id: x.id, navn: x.name, email: x.email, rolle: x.role
      }));
      console.table(m);            // cpr-kolonnen er bevidst udeladt

      const admins = m.filter(x => String(x.rolle) === 'admin');
      if (!admins.length) {
        console.warn('INGEN med rolle "admin" i eksporten. Efter importen kan ' +
                     'ingen redigere bandet. Ret rollen i JSON-filen på DIN egen ' +
                     'række til "admin" før du importerer.');
      } else {
        console.log('Admin efter import: ' + admins.map(a => a.email).join(', '));
      }

      console.log('%cNæste:  await importer("dmdt")   ' +
                  '(tilføj , true hvis bandet allerede har medlemmer)',
                  'font-weight:bold');
      ok(d);
    };
    inp.click();
  });

  /**
   * Prototypen GENBRUGTE fakturanumre — syv slettede rækker deler 2026-001, og
   * inv17/inv18 deler 2026-003 (en rettelse hvor nummeret blev holdt fast).
   * Det nye lag reserverer i stedet: et slettet nummer er brændt for altid
   * (band.js:1050). Tages de slettede kladder med, står 2026-001..006 som
   * optaget, og næste rigtige afregning bliver 2026-007 — et synligt hul efter
   * de tre der faktisk er udstedt.
   *
   * De slettede er usynlige i UI'et under alle omstændigheder (band.js:1086),
   * så de koster kun nummerrækken. Denne funktion fjerner dem inden importen.
   */
  window.kunAktiveFakturaer = () => {
    if (!window.__eksport) { console.error('Kør laesFil() først.'); return; }
    const alle = window.__eksport.Invoices || [];
    const beholdt = alle.filter(i => String(i.status || '').trim() !== 'slettet');
    window.__eksport.Invoices = beholdt;
    console.log('Fakturaer: ' + alle.length + ' → ' + beholdt.length +
                ' (fjernede ' + (alle.length - beholdt.length) + ' slettede kladder)');
    console.table(beholdt.map(i => ({ nr: i.invoiceNr, dato: i.date, beloeb: i.amount, status: i.status })));
    const numre = beholdt.map(i => String(i.invoiceNr));
    console.log('Optagne numre efter import: ' + numre.join(', ') +
                '  → næste bliver 2026-' +
                String(numre.filter(n => n.startsWith('2026-'))
                  .map(n => parseInt(n.slice(5), 10)).filter(n => !isNaN(n))
                  .reduce((m, n) => Math.max(m, n), 0) + 1).padStart(3, '0'));
  };

  window.visCpr = () => console.log(window.__eksport && window.__eksport._bandCpr);

  window.importer = async (bandId, overskriv) => {
    if (!window.__eksport) { console.error('Kør laesFil() først.'); return; }
    const svar = await kald({
      action: 'importBandData',
      bandId: bandId,
      data: window.__eksport,
      overskriv: overskriv === true
    });
    if (!svar.ok) { console.error(svar.error || svar); return svar; }

    console.log('%cImporteret:', 'font-weight:bold');
    console.table(svar.importeret);
    console.log('%cSTARTKODER — vises kun ÉN gang. Kopiér dem NU.',
                'font-weight:bold;color:#c00');
    console.table(svar.startkoder);
    // DevTools' copy() findes KUN i udtryk man skriver direkte ved prompten.
    // Kaldt herindefra kaster den ReferenceError — og den kastes EFTER at
    // importen er skrevet, så det ligner at importen fejlede. Det gjorde den
    // ikke. Koderne lægges derfor på window, så de kan hentes bagefter uanset
    // hvad clipboard-forsøget gør.
    window.STARTKODER = svar.startkoder;
    const linjer = svar.startkoder
      .map(k => k.navn + '\t' + k.email + '\t' + k.startkode).join('\n');
    try {
      await navigator.clipboard.writeText(linjer);
      console.log('Koderne er i udklipsholderen — Ctrl+V i en note NU.');
    } catch (e) {
      // Clipboard-API'et kræver at fanen har fokus. Har den ikke det, printer
      // vi dem i stedet, så de kan markeres med musen.
      console.log('Udklipsholderen nægtede (' + (e && e.name) + '). Skriv:  copy(STARTKODER)');
      console.log(linjer);
    }
    return svar;
  };

  window.glemAlt = () => { window.__eksport = null; console.log('JSON glemt.'); };

  console.log('%cKlar. Kør:  await laesFil()', 'font-weight:bold;font-size:14px');
})();
