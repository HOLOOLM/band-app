// Honorarafregningens HTML. Bygges HER i Workeren, ikke i sidecaren.
//
// Det er en bevidst arbejdsdeling: sidecaren modtager færdig HTML og konverterer
// den til PDF. Den kender derfor ikke datamodellen, har ingen Sheets-adgang og
// skal ikke opdateres når et felt ændrer navn. Alt hvad den ved, står i
// request-body.
//
// CPR-REGLEN. Denne fil er det ENESTE sted i systemet hvor et CPR-nummer
// optræder i klartekst, og det sker udelukkende inde i den HTML der sendes
// direkte til PDF-konvertering. Nummeret må ALDRIG:
//   - returneres fra en action
//   - havne i et JSON-svar
//   - nå browserens DOM
// Derfor streames PDF'en af /api/faktura-pdf med Cache-Control: no-store, og
// derfor findes der ingen action der returnerer HTML'en.
//
// Layoutet er porteret 1:1 fra _buildInvoiceHtmlServer (Code.gs), inkl.
// tabel-baseret opbygning: Drive-Docs-konverteringen i sidecaren håndterer ikke
// moderne CSS-layout, kun tabeller.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Dansk beløbsformat: 35.000 */
function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('da-DK', { maximumFractionDigits: 0 });
}

/** Dansk datoformat: 13-06-2026 */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = n => (n < 10 ? '0' : '') + n;
  return p(d.getDate()) + '-' + p(d.getMonth() + 1) + '-' + d.getFullYear();
}

/**
 * @param contract  serialiseret kontrakt (arrangoer/venue som objekter)
 * @param invoiceNr fakturanummer, fx "2026-001"
 * @param settings  bandets settings
 * @param cpr       KLARTEKST-CPR. Se CPR-reglen i filkommentaren.
 * @param logoDataUrl bandets logo som data-URL, eller tom streng
 */
export function buildInvoiceHtml(contract, invoiceNr, settings, cpr, logoDataUrl) {
  const c = contract || {};
  const s = settings || {};
  const arr = c.arrangoer || {};
  const honorarTxt = c.honorar ? fmtMoney(c.honorar) + ' kr.' : '—';
  const paymentTxt = (c.paymentTerms === 'Andet' && c.paymentTermsOther)
    ? c.paymentTermsOther : (c.paymentTerms || '');
  const payeeAddr = String(s.payeeAddress || '').split('\n');
  const contactAddr = String(s.contactAddress || '').split('\n');
  const logoImg = logoDataUrl
    ? '<img src="' + logoDataUrl + '" alt="" style="height:56px" />' : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#2A2A2A;margin:0;padding:24px}' +
    'table{border-collapse:collapse;width:100%}' +
    '@page{margin:10mm;size:A4}' +
    '</style></head><body>' +
    '<table style="background:#0F213C;margin-bottom:28px"><tr>' +
      '<td style="padding:18px 24px">' + logoImg + '</td>' +
      '<td style="padding:18px 24px;text-align:right;color:#ffffff;font-size:24px;font-weight:bold">Honorar afregning</td>' +
    '</tr></table>' +
    '<table style="margin-bottom:18px"><tr>' +
      '<td style="vertical-align:top;font-size:12px;line-height:1.6;width:55%">' +
        '<strong>' + esc(s.bandName || '') + '</strong><br/>' +
        (s.payeeName ? 'V/ ' + esc(s.payeeName) + '<br/>' : '') +
        payeeAddr.filter(Boolean).map(esc).join('<br/>') +
        (cpr ? '<br/>CPR: ' + esc(cpr) : '') +
      '</td>' +
      '<td style="vertical-align:top;font-size:12px;line-height:1.7">' +
        esc(arr.name || '') + '<br/>' +
        esc(arr.address || '') + '<br/>' +
        esc([arr.postnr, arr.city].filter(Boolean).join(' ')) + '<br/><br/>' +
        'Dato: ' + esc(fmtDate(c.date)) + '<br/>' +
        'Afregningsnr: ' + esc(invoiceNr) +
      '</td>' +
    '</tr></table>' +
    '<table style="border-top:1px solid #B8A88A;border-bottom:1px solid #B8A88A;margin-bottom:18px"><tr>' +
      '<td style="padding:14px 0;font-size:13px">Honorarafregning for arrangement d. <strong>' +
        esc(fmtDate(c.date)) + '</strong></td>' +
      '<td style="padding:14px 0;text-align:right;font-weight:bold;color:#0F213C;font-size:15px">' +
        esc(honorarTxt) + '</td>' +
    '</tr></table>' +
    '<div style="height:280px"></div>' +
    '<div style="border-top:1px solid #B8A88A;padding-top:12px;font-size:11px;line-height:1.7">' +
      'Betalingsbetingelser: <strong>' + esc(paymentTxt) + '</strong><br/>' +
      'Beløbet indbetales til vores bank ' + esc(s.bankName || '') + '<br/>' +
      'Reg: ' + esc(s.bankReg || '') + '&nbsp;&nbsp;Kto: ' + esc(s.bankKto || '') + '<br/>' +
      esc((c.venue && c.venue.name) || 'Spillested') + ' bedes anført ved overførsel' +
      (cpr ? '<br/>Beløbet indberettes på Cpr. ' + esc(cpr) : '') +
    '</div>' +
    '<div style="margin-top:24px;border-top:1px solid #D9CFBE;padding-top:10px;font-size:10px;color:#6A5A40">' +
      [s.bandName, s.contactName, contactAddr[0], contactAddr[1],
       s.contactPhone ? 'Tel: ' + s.contactPhone : '',
       s.contactEmail ? 'Email: ' + s.contactEmail : '']
        .filter(Boolean).map(esc).join(' · ') +
    '</div>' +
    '</body></html>';
}
