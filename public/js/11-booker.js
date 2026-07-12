// Del af band-app frontend. Booker-portal (Booking Fase B/C) — ?band=__booker.
// Ekstern booking-agent: login, se tilbud på tværs af tildelte bands, opret/send/
// annullér tilbud som KLADDER. Fra "send" og frem kører forløbet præcis som
// Fase A (band godkender & underskriver → arrangør underskriver via offentligt
// link) — booker-tilbud er blot en anden KILDE til en Bookings-række.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..11) SKAL bevares.

let BK_OFFERS = [];
let BK_BANDS = [];

function bkRoot(){ return document.getElementById('bkRoot'); }

function bkStart(){
  _applyThemeVars(DEFAULT_THEME);
  // Distinkt booker-accent (blå) — tydeligt forskellig fra operatørens gyldne.
  document.documentElement.style.setProperty('--accent', '#4A7A9C');
  document.documentElement.style.setProperty('--accent-soft', '#7CA6C4');
  document.documentElement.style.setProperty('--accent-deep', '#345C77');
  document.title = 'Booker — Band-app';
  document.body.innerHTML = '<div id="bkRoot"></div>';
  fetch('/api/session', { credentials: 'same-origin' })
    .then(r => r.json()).catch(()=>null)
    .then(d => {
      if (d && d.ok && d.role === 'booker'){ BOOKER_SESSION = { loggedIn: true }; bkLoadOffers(); }
      else bkRenderLogin();
    });
}

function bkRenderLogin(msg){
  bkRoot().innerHTML = `
    <div class="login-wrap">
      <div class="card login-card" style="max-width:420px">
        <div class="eyebrow warm" style="text-align:center;margin-bottom:8px">BOOKER</div>
        <h1 class="serif" style="text-align:center">Log ind</h1>
        <p class="lede" style="text-align:center">Send og følg dine bookingtilbud.</p>
        ${msg ? `<div class="login-err show">${escapeHtml(msg)}</div>` : '<div class="login-err"></div>'}
        <div class="field" style="margin-bottom:14px"><label>Email</label>
          <input id="bkEmail" class="input" type="email" autocomplete="username" placeholder="dig@agency.dk"></div>
        <div class="field" style="margin-bottom:18px"><label>Adgangskode</label>
          <input id="bkPw" class="input" type="password" autocomplete="current-password" placeholder="••••••••"></div>
        <button id="bkLoginBtn" class="btn btn-primary btn-lg" style="width:100%;justify-content:center">Log ind</button>
      </div>
    </div>`;
  const go = ()=>bkDoLogin();
  document.getElementById('bkLoginBtn').onclick = go;
  document.getElementById('bkPw').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
  document.getElementById('bkEmail').focus();
}

async function bkDoLogin(){
  const email = document.getElementById('bkEmail').value.trim().toLowerCase();
  const pw = document.getElementById('bkPw').value;
  if (!email || !pw){ bkRenderLogin('Udfyld email og adgangskode'); return; }
  const btn = document.getElementById('bkLoginBtn');
  btn.disabled = true; btn.textContent = 'Logger ind…';
  try {
    const hash = await sha256hex(pw);
    const res = await fetch('/api/booker-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: email, passwordHash: hash })
    });
    const d = await res.json().catch(()=>null);
    if (!d || !d.ok){ bkRenderLogin((d && d.error) || 'Login mislykkedes'); return; }
    BOOKER_SESSION = { loggedIn: true, name: (d.booker&&d.booker.name)||'', agency: (d.booker&&d.booker.agency)||'', forcePasswordChange: !!d.forcePasswordChange };
    bkLoadOffers();
  } catch(e){
    bkRenderLogin('Netværksfejl: ' + e.message);
  }
}

function bkLogout(){
  try { fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(()=>{}); } catch(e){}
  BOOKER_SESSION = null;
  bkRenderLogin();
}

function bkShell(inner){
  const who = BOOKER_SESSION && (BOOKER_SESSION.agency || BOOKER_SESSION.name);
  return `
    <div style="max-width:880px;margin:0 auto;padding:28px 20px 80px">
      <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:24px">
        <div>
          <div class="eyebrow warm">BOOKER${who ? ' · ' + escapeHtml(who) : ''}</div>
          <h1 class="serif" style="margin:2px 0 0">Bookingtilbud</h1>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="bkLogout()">Log ud</button>
      </div>
      ${inner}
    </div>`;
}

async function bkLoadOffers(){
  bkRoot().innerHTML = bkShell('<div class="card"><span class="spinner"></span>Henter tilbud…</div>');
  try {
    const [bandsRes, offersRes] = await Promise.all([
      _apiCall('bookerGetBands', {}),
      _apiCall('bookerListOffers', {})
    ]);
    if (!offersRes || !offersRes.ok){
      if (offersRes && /session/i.test(offersRes.error||'')){ bkLogout(); return; }
      bkRoot().innerHTML = bkShell(`<div class="card"><p style="color:var(--danger)">${escapeHtml((offersRes&&offersRes.error)||'Kunne ikke hente tilbud')}</p></div>`);
      return;
    }
    BK_BANDS = (bandsRes && bandsRes.ok) ? (bandsRes.bands || []) : [];
    BK_OFFERS = offersRes.offers || [];
    bkRenderDashboard();
  } catch(e){
    bkRoot().innerHTML = bkShell(`<div class="card"><p style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</p></div>`);
  }
}

function bkRenderDashboard(){
  bkRoot().innerHTML = bkShell(`
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:14px">
      <h2 class="serif" style="margin:0;font-size:18px">Dine tilbud (${BK_OFFERS.length})</h2>
      <button class="btn btn-primary btn-sm" onclick="bkRenderOfferForm()" ${BK_BANDS.length ? '' : 'disabled title="Ingen bands tildelt endnu"'}>+ Nyt tilbud</button>
    </div>
    ${!BK_BANDS.length ? '<div class="card" style="margin-bottom:14px"><p style="color:var(--cream-mute);margin:0">Du har endnu ikke adgang til nogen bands. Kontakt operatøren.</p></div>' : ''}
    <div id="bkOfferList">${bkOfferListHtml()}</div>`);
}

function bkOfferListHtml(){
  if (!BK_OFFERS.length) return '<div class="card"><p style="color:var(--cream-mute);margin:0">Ingen tilbud endnu.</p></div>';
  return BK_OFFERS.map((o, idx) => {
    const c = o.contractDraft || {};
    const venue = c.venue || {};
    return `<div class="card" style="margin-bottom:10px;padding:14px 16px;cursor:pointer" onclick="bkOpenOffer(${idx})">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <div class="flex" style="align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:15px">${escapeHtml(venue.name || 'Tilbud')}</strong>
            <span style="color:var(--cream-mute);font-size:12px">${escapeHtml(o.bandName || o.bandId || '')}</span>
            ${typeof _bookingStatusBadge === 'function' ? _bookingStatusBadge(o.status) : escapeHtml(o.status)}
          </div>
          <div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(o.arrangoerName||'')} · ${fmtDate(c.date)} · ${fmtMoney(c.honorar)}</div>
        </div>
        <div class="muted">→</div>
      </div>
    </div>`;
  }).join('');
}

function bkOpenOffer(idx){
  const o = BK_OFFERS[idx];
  if (!o) return;
  if (o.status === 'draft') { bkRenderOfferForm(o.id); return; }
  bkRenderOfferDetail(o);
}

function bkRenderOfferDetail(o){
  const c = o.contractDraft || {};
  const venue = c.venue || {};
  const arr = c.arrangoer || {};
  let actionsHtml = '';
  if (o.status === 'sent'){
    actionsHtml = `<button class="btn btn-danger btn-sm" onclick="bkCancelOffer('${escapeHtml(o.id)}')">Annullér tilbud</button>`;
  }
  const historyHtml = (o.history || []).slice().reverse().map(h => `
    <div style="padding:8px 0;border-bottom:1px solid var(--ink-line-soft);font-size:12px">
      <span class="mono muted" style="font-size:10px">${escapeHtml(fmtDate(h.ts))}</span> — ${escapeHtml(h.actor || '')}${h.note ? ': ' + escapeHtml(h.note) : ''}
    </div>`).join('');
  bkRoot().innerHTML = bkShell(`
    <button class="btn btn-text btn-sm" onclick="bkLoadOffers()" style="margin-bottom:8px">← Alle tilbud</button>
    <div class="card" style="max-width:640px">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px">
        <h2 class="serif" style="margin:0 0 6px;font-size:18px">${escapeHtml(venue.name || 'Tilbud')}</h2>
        ${typeof _bookingStatusBadge === 'function' ? _bookingStatusBadge(o.status) : ''}
      </div>
      <div class="kv-grid" style="margin-top:10px">
        <div class="kv"><div class="label">Band</div><div class="value" style="font-size:15px">${escapeHtml(o.bandName || o.bandId || '—')}</div></div>
        <div class="kv"><div class="label">Arrangør</div><div class="value" style="font-size:15px">${escapeHtml(arr.name || o.arrangoerName || '—')}</div></div>
        <div class="kv"><div class="label">Dato</div><div class="value" style="font-size:15px">${fmtDate(c.date)}</div></div>
        <div class="kv"><div class="label">Honorar</div><div class="value" style="font-size:15px">${fmtMoney(c.honorar)}</div></div>
      </div>
      ${o.declineReason ? `<div class="muted" style="font-size:12px;margin-top:10px">Begrundelse: ${escapeHtml(o.declineReason)}</div>` : ''}
      ${actionsHtml ? `<div style="margin-top:16px">${actionsHtml}</div>` : ''}
      <div class="eyebrow" style="margin-top:18px;margin-bottom:4px">Forløb</div>
      ${historyHtml || '<div class="muted" style="font-size:12px">Ingen historik.</div>'}
    </div>`);
}

function _bkContractDraftFromForm(){
  return {
    type: 'Spillested',
    venue: {
      name: document.getElementById('bkVenueName').value.trim(),
      address: document.getElementById('bkVenueAddr').value.trim(),
      postnr: document.getElementById('bkVenuePostnr').value.trim(),
      city: document.getElementById('bkVenueCity').value.trim()
    },
    arrangoer: {
      name: document.getElementById('bkArrName').value.trim(),
      contactName: document.getElementById('bkArrContact').value.trim(),
      email: document.getElementById('bkArrEmail').value.trim().toLowerCase()
    },
    date: document.getElementById('bkDate').value,
    showtimeFrom: document.getElementById('bkTimeFrom').value.trim(),
    showtimeTo: document.getElementById('bkTimeTo').value.trim(),
    honorar: Number(document.getElementById('bkHonorar').value) || 0,
    notes: document.getElementById('bkNotes').value.trim()
  };
}

function bkRenderOfferForm(offerId){
  const existing = offerId ? BK_OFFERS.find(o => o.id === offerId) : null;
  const c = (existing && existing.contractDraft) || {};
  const venue = c.venue || {};
  const arr = c.arrangoer || {};
  const isNew = !existing;
  bkRoot().innerHTML = bkShell(`
    <button class="btn btn-text btn-sm" onclick="bkLoadOffers()" style="margin-bottom:8px">← Alle tilbud</button>
    <div class="card" style="max-width:640px">
      <h2 class="serif" style="margin:0 0 4px;font-size:18px">${isNew ? 'Nyt tilbud' : 'Rediger kladde'}</h2>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 16px">${isNew ? 'Gemmes som kladde — sendes først til bandet når du trykker "Send til band".' : 'Kladden kan redigeres frit indtil den sendes.'}</p>
      <div class="login-err" id="bkFormErr"></div>
      ${isNew ? `
      <div class="field" style="margin-bottom:14px"><label>Band</label>
        <select id="bkBandSelect" class="select">
          ${BK_BANDS.map(b => `<option value="${escapeHtml(b.bandId)}">${escapeHtml(b.name||b.bandId)}</option>`).join('')}
        </select></div>` : ''}
      <div class="field" style="margin-bottom:14px"><label>Spillested</label>
        <input id="bkVenueName" class="input" value="${escapeHtml(venue.name||'')}" placeholder="Fx Vega"></div>
      <div class="flex" style="gap:10px">
        <div class="field" style="flex:2"><label>Adresse</label><input id="bkVenueAddr" class="input" value="${escapeHtml(venue.address||'')}"></div>
        <div class="field" style="flex:1"><label>Postnr</label><input id="bkVenuePostnr" class="input" value="${escapeHtml(venue.postnr||'')}"></div>
        <div class="field" style="flex:1"><label>By</label><input id="bkVenueCity" class="input" value="${escapeHtml(venue.city||'')}"></div>
      </div>
      <div class="flex" style="gap:10px;margin-top:14px">
        <div class="field" style="flex:1"><label>Dato</label><input id="bkDate" type="date" class="input" value="${c.date ? String(c.date).slice(0,10) : ''}"></div>
        <div class="field" style="flex:1"><label>Fra</label><input id="bkTimeFrom" class="input" value="${escapeHtml(c.showtimeFrom||'')}" placeholder="21:00"></div>
        <div class="field" style="flex:1"><label>Til</label><input id="bkTimeTo" class="input" value="${escapeHtml(c.showtimeTo||'')}" placeholder="23:00"></div>
        <div class="field" style="flex:1"><label>Honorar (kr)</label><input id="bkHonorar" type="number" class="input" value="${escapeHtml(String(c.honorar||''))}"></div>
      </div>
      <h3 class="serif" style="margin:18px 0 10px;font-size:15px">Arrangør</h3>
      <div class="flex" style="gap:10px">
        <div class="field" style="flex:1"><label>Navn/virksomhed</label><input id="bkArrName" class="input" value="${escapeHtml(arr.name||'')}"></div>
        <div class="field" style="flex:1"><label>Kontaktperson</label><input id="bkArrContact" class="input" value="${escapeHtml(arr.contactName||'')}"></div>
      </div>
      <div class="field" style="margin-bottom:14px"><label>Arrangør-email (til underskrift)</label>
        <input id="bkArrEmail" class="input" type="email" value="${escapeHtml(arr.email||'')}" placeholder="arrangoer@eksempel.dk"></div>
      <div class="field" style="margin-bottom:18px"><label>Noter</label>
        <textarea id="bkNotes" class="input" rows="3">${escapeHtml(c.notes||'')}</textarea></div>
      <div class="flex" style="gap:8px;justify-content:flex-end">
        <button id="bkSaveDraftBtn" class="btn btn-ghost">Gem kladde</button>
        <button id="bkSendBtn" class="btn btn-primary">${isNew ? 'Gem og send til band' : 'Send til band'}</button>
      </div>
    </div>`);
  document.getElementById('bkSaveDraftBtn').onclick = () => bkSaveOffer(existing ? existing.id : null, false);
  document.getElementById('bkSendBtn').onclick = () => bkSaveOffer(existing ? existing.id : null, true);
}

async function bkSaveOffer(offerId, sendAfter){
  const err = document.getElementById('bkFormErr');
  const fail = m => { err.textContent = m; err.classList.add('show'); };
  const bandSelect = document.getElementById('bkBandSelect');
  if (!offerId && (!bandSelect || !bandSelect.value)){ fail('Vælg et band'); return; }
  const offer = _bkContractDraftFromForm();
  if (!offer.venue.name){ fail('Udfyld spillested'); return; }
  if (!offer.arrangoer.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(offer.arrangoer.email)){ fail('Udfyld en gyldig arrangør-email'); return; }
  const btn = sendAfter ? document.getElementById('bkSendBtn') : document.getElementById('bkSaveDraftBtn');
  await withBusy(btn, 'Gemmer…', async () => {
    const payload = { offerId: offerId || undefined, offer: offer };
    if (!offerId) payload.bandId = bandSelect.value;
    const d = await _apiCall('bookerSaveOffer', payload);
    if (!d || !d.ok){ fail((d && d.error) || 'Kunne ikke gemme'); return; }
    if (!sendAfter){ toast('Kladde gemt'); bkLoadOffers(); return; }
    const sendD = await _apiCall('bookerSendOffer', { offerId: d.offerId });
    if (!sendD || !sendD.ok){ fail((sendD && sendD.error) || 'Gemt som kladde, men kunne ikke sendes'); return; }
    toast('Tilbud sendt til bandet');
    bkLoadOffers();
  });
}

async function bkCancelOffer(offerId){
  if (!confirm('Annullér dette tilbud?\n\nBandet kan ikke længere godkende det.')) return;
  try {
    const d = await _apiCall('bookerCancelOffer', { offerId: offerId });
    if (!d || !d.ok){ toast((d && d.error) || 'Kunne ikke annullere', 'err'); return; }
    toast('Tilbud annulleret');
    bkLoadOffers();
  } catch(e){ toast('Netværksfejl: ' + e.message, 'err'); }
}
