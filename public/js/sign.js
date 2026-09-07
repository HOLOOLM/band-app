// Standalone offentlig signeringsside (Booking Fase A). Ingen login, intet
// afhængighed af de øvrige app-filer — kun dette ene script.
// Al auth sker via tokenet i URL'en (?t=...); /api/sign er uautentificeret og
// rate-limited i Worker'en (worker/src/worker.js apiSign).

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const root = document.getElementById('signRoot');

async function callSign(op, extra){
  const body = Object.assign({ op: op, t: TOKEN }, extra || {});
  const res = await fetch('/api/sign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch(e){ return { ok: false, error: 'Uventet svar fra serveren.' }; }
}

function renderStatus(icon, title, msg){
  root.innerHTML = `<div class="card status-box"><div class="icn">${icon}</div><h2 class="serif">${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p></div>`;
}

function renderError(msg){
  renderStatus('⚠', 'Kunne ikke åbne kontrakten', msg || 'Linket er ugyldigt eller udløbet.');
}

function renderCompleted(){
  renderStatus('✓', 'Allerede underskrevet', 'Denne kontrakt er allerede underskrevet af begge parter. Du kan lukke dette vindue.');
}

// ── Kontrakt-rendering ──────────────────────────────────────────────────────
//
// Siden læste før `d.html`, men getSignableBooking har aldrig returneret det
// felt — den sender `draft`. Kontraktboksen viste derfor bogstaveligt talt
// teksten "undefined", mens der lige under stod at man ved at underskrive
// bekræfter at have læst kontrakten ovenfor. En registreret e-signatur på et
// dokument der aldrig blev vist er værdiløs, uanset hvor korrekt docHash er.
//
// Rendering sker her, klientside, ud fra draften. Det er med vilje valgt frem
// for at lade serveren sende HTML: så findes der ingen rå innerHTML-sink på
// appens eneste side uden login. Hvert felt går gennem escapeHtml.

function fmtDato(iso){
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt)) return String(iso);
  return dt.toLocaleDateString('da-DK', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
function fmtKr(n){
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '—';
  return v.toLocaleString('da-DK') + ' kr.';
}
function adresseLinje(o){
  const dele = [o.address, [o.postnr, o.city].filter(Boolean).join(' ')].filter(Boolean);
  return dele.join(', ');
}
// Én række. Udelades helt når værdien er tom, så kontrakten ikke fyldes med
// tankestreger for felter bandet ikke har udfyldt.
function raekke(label, vaerdi){
  const v = String(vaerdi == null ? '' : vaerdi).trim();
  if (!v || v === '—') return '';
  return `<tr>
    <th style="text-align:left;vertical-align:top;padding:6px 14px 6px 0;font-weight:500;opacity:.65;white-space:nowrap">${escapeHtml(label)}</th>
    <td style="padding:6px 0;vertical-align:top">${escapeHtml(v)}</td>
  </tr>`;
}
function afsnit(titel, raekker){
  const indhold = raekker.filter(Boolean).join('');
  if (!indhold) return '';
  return `<h3 style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:18px 0 6px">${escapeHtml(titel)}</h3>
    <table><tbody>${indhold}</tbody></table>`;
}

function renderKontrakt(d){
  const k = d.draft || {};
  const a = k.arrangoer || {};
  const v = k.venue || {};

  const spilletid = [k.showtimeFrom, k.showtimeTo].filter(Boolean).join(' – ');
  const saet = k.sets
    ? k.sets + ' sæt' + (k.setMinutes ? ' à ' + k.setMinutes + ' min.' : '')
    : '';
  const betaling = (k.paymentTerms === 'Andet' && k.paymentTermsOther)
    ? k.paymentTermsOther : (k.paymentTerms || '');

  const dele = [
    afsnit('Aftale', [
      raekke('Type', k.type),
      raekke('Dato', fmtDato(k.date)),
      raekke('Honorar', fmtKr(k.honorar)),
      raekke('Betalingsbetingelser', betaling)
    ]),
    afsnit('Spillested', [
      raekke('Navn', v.name),
      raekke('Adresse', adresseLinje(v))
    ]),
    afsnit('Arrangør', [
      raekke('Navn', a.name),
      raekke('Kontaktperson', a.contactName),
      raekke('Adresse', adresseLinje(a)),
      raekke('E-mail', a.email),
      raekke('Telefon', a.phone),
      raekke('CVR', a.cvr)
    ]),
    afsnit('Tider', [
      raekke('Get-in', k.getIn),
      raekke('Soundcheck', k.soundcheck),
      raekke('Spilletid', spilletid),
      raekke('Sæt', saet)
    ]),
    afsnit('Omfang', [
      raekke('Musikere', k.musicianCount),
      raekke('Crew', k.crewCount),
      raekke('Gæster på liste', k.guestCount)
    ])
  ].filter(Boolean);

  // notes bevarer sine linjeskift. memberNote er bandintern og sendes aldrig
  // hertil — se kommentaren i worker/src/actions/bookings.js.
  const noter = String(k.notes || '').trim()
    ? `<h3 style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:18px 0 6px">Noter</h3>
       <p style="white-space:pre-wrap;margin:0">${escapeHtml(k.notes)}</p>`
    : '';

  // Bandets underskriver vises med navn og dato. Ikke e-mail: den er et
  // bandmedlems persondata og har intet at gøre hos en ekstern arrangør.
  const bs = d.bandSignature || {};
  const bandsig = bs.name
    ? `<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid rgba(0,0,0,.12);font-size:12px;opacity:.7">
         Underskrevet af bandet: ${escapeHtml(bs.name)}${bs.ts ? ' · ' + escapeHtml(fmtDato(bs.ts)) : ''}
       </p>`
    : '';

  // Ingen felter overhovedet betyder at draften mangler. Så må der ikke
  // underskrives — det var præcis den tilstand fejlen efterlod folk i.
  if (!dele.length && !noter) return null;
  return dele.join('') + noter + bandsig;
}

function renderSignable(d){
  const kontraktHtml = renderKontrakt(d);
  if (kontraktHtml === null){
    renderStatus('⚠', 'Kontrakten kan ikke vises',
      'Vi kunne ikke hente kontraktens indhold, og du bør ikke underskrive noget du ikke kan læse. ' +
      'Kontakt bandet og bed om et nyt link.');
    return;
  }
  document.getElementById('signBandName').textContent = d.bandName || 'Kontrakt';
  document.getElementById('signVenueName').textContent = d.venueName || '';
  root.innerHTML = `
    <div class="contract-box">${kontraktHtml}</div>
    <div class="card sign-panel">
      <div class="eyebrow warm">Din underskrift</div>
      <h2 class="serif" style="font-weight:400;font-size:20px;margin:6px 0 14px">Bekræft og underskriv</h2>
      <div class="confirm-box">Ved at indtaste dit navn og trykke "Underskriv kontrakt" bekræfter du at have læst og accepteret kontrakten ovenfor. Dit navn, tidspunkt og IP-adresse registreres som elektronisk signatur.</div>
      <div class="field">
        <label>Dit fulde navn</label>
        <input id="signName" class="input" placeholder="Fornavn Efternavn" autocomplete="name">
      </div>
      <div id="signErr" class="login-err"></div>
      <div class="sign-actions">
        <button id="declineBtn" class="btn btn-ghost">Afvis kontrakt</button>
        <button id="signBtn" class="btn btn-primary btn-lg">Underskriv kontrakt</button>
      </div>
    </div>
  `;
  document.getElementById('signBtn').onclick = doSign;
  document.getElementById('declineBtn').onclick = doDecline;
  document.getElementById('signName').addEventListener('keydown', e=>{ if (e.key === 'Enter') doSign(); });
}

function showErr(msg){
  const el = document.getElementById('signErr');
  if (el){ el.textContent = msg; el.classList.add('show'); }
}

async function doSign(){
  const nameEl = document.getElementById('signName');
  const name = (nameEl.value || '').trim();
  if (!name){ showErr('Indtast dit fulde navn for at underskrive.'); return; }
  if (!confirm('Underskriver du kontrakten som "' + name + '"? Dette kan ikke fortrydes.')) return;
  const btn = document.getElementById('signBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Underskriver…';
  try {
    const d = await callSign('sign', { typedName: name });
    if (!d || !d.ok){ showErr((d && d.error) || 'Kunne ikke underskrive — prøv igen.'); btn.disabled = false; btn.textContent = 'Underskriv kontrakt'; return; }
    renderStatus('✓', 'Underskrevet — tak!', 'Kontrakten er nu underskrevet af begge parter. En kvittering med kontrakten som PDF er sendt til din e-mail.');
  } catch(e){ showErr('Netværksfejl: ' + e.message); btn.disabled = false; btn.textContent = 'Underskriv kontrakt'; }
}

async function doDecline(){
  const reason = prompt('Vil du angive en grund til afvisningen? (valgfrit)') || '';
  if (!confirm('Afviser du kontrakten? Dette kan ikke fortrydes.')) return;
  const btn = document.getElementById('declineBtn');
  btn.disabled = true;
  try {
    const d = await callSign('decline', { reason: reason });
    if (!d || !d.ok){ showErr((d && d.error) || 'Kunne ikke afvise — prøv igen.'); btn.disabled = false; return; }
    renderStatus('✕', 'Kontrakt afvist', 'Du har afvist kontrakten. Bandet er blevet underrettet.');
  } catch(e){ showErr('Netværksfejl: ' + e.message); btn.disabled = false; }
}

(async function boot(){
  if (!TOKEN){ renderError('Linket mangler et gyldigt token.'); return; }
  try {
    const d = await callSign('view');
    if (!d || !d.ok){ renderError(d && d.error); return; }
    if (d.status === 'completed'){ renderCompleted(); return; }
    renderSignable(d);
  } catch(e){ renderError('Netværksfejl: ' + e.message); }
})();
