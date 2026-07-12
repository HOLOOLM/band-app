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

function renderSignable(d){
  document.getElementById('signBandName').textContent = d.bandName || 'Kontrakt';
  document.getElementById('signVenueName').textContent = d.venueName || '';
  root.innerHTML = `
    <div class="contract-box">${d.html}</div>
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
