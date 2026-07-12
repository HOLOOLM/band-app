// Del af band-app frontend. Booking & e-signatur (Fase A) — band-admins visning
// af indgående/afsendte underskriftsforløb. Kun synlig når BAND_CONFIG.booking
// er slået til af operatøren (se applyBranding i 09-boot.js).
// Klassiske <script>-filer deler global scope; rækkefølgen (01..11) SKAL bevares.

function _bookingStatusBadge(status){
  const map = {
    draft:          ['mute',   'Kladde'],
    sent:           ['warn',   'Afventer godkendelse'],
    band_signed:    ['warn',   'Afventer arrangør'],
    completed:      ['ok',     'Underskrevet'],
    band_declined:  ['danger', 'Afvist af band'],
    arr_declined:   ['danger', 'Afvist af arrangør'],
    cancelled:      ['mute',   'Annulleret'],
    expired:        ['mute',   'Udløbet']
  };
  const pair = map[status] || ['mute', status];
  return `<span class="badge ${pair[0]}"><span class="badge-dot"></span>${escapeHtml(pair[1])}</span>`;
}

async function renderBookingsList(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Bookinger</h1>
        <div class="lede">Kontrakter til elektronisk underskrift.</div>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="bookingsTable" class="muted" style="padding:24px"><span class="spinner"></span>Henter...</div>
    </div>
  `;
  if (CACHE.bookings && cacheFresh('bookings')) { drawBookingsTable(); return; }
  try {
    const d = await apiGet('listIncomingBookings');
    if (!document.getElementById('bookingsTable')) return; // navigerede væk
    if (!d.ok){ _failInto('bookingsTable', d.error || 'Kunne ikke hente bookinger', 'renderBookingsList()'); return; }
    CACHE.bookings = d.bookings; cacheTouch('bookings'); _updateBookingsBadge();
    drawBookingsTable();
  } catch(e){ _failInto('bookingsTable', e.message, 'renderBookingsList()'); }
}

function drawBookingsTable(){
  const wrap = document.getElementById('bookingsTable');
  if (!wrap || !CACHE.bookings) return;
  const rows = CACHE.bookings;
  if (!rows.length){ wrap.innerHTML = '<div class="empty">Ingen bookinger endnu. Send en kontrakt til underskrift fra kontrakt-editoren.</div>'; return; }
  wrap.innerHTML = `
    <table class="table">
      <thead><tr><th>Spillested</th><th>Arrangør</th><th>Dato</th><th>Status</th><th>Sidst opdateret</th><th></th></tr></thead>
      <tbody>
        ${rows.map((b, idx) => {
          const c = b.contractDraft || {};
          const venue = c.venue || {};
          return `<tr class="clickable" data-idx="${idx}">
            <td><span class="serif" style="font-size:16px">${escapeHtml(venue.name || '—')}</span> <span class="muted">· ${escapeHtml(venue.city || '')}</span>${b.source === 'booker' ? ' <span class="badge mute" style="font-size:10px">Booker</span>' : ''}</td>
            <td class="muted" style="font-size:13px">${escapeHtml(b.arrangoerName || '')}</td>
            <td class="mono" style="color:var(--accent)">${fmtDate(c.date)}</td>
            <td>${_bookingStatusBadge(b.status)}</td>
            <td class="mono muted" style="font-size:11px">${fmtDate(b.updatedAt)}</td>
            <td class="muted">→</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('tr[data-idx]').forEach(row => {
    row.onclick = () => openBookingReview(Number(row.getAttribute('data-idx')));
  });
}

function openBookingReview(idx){
  const b = (CACHE.bookings || [])[idx];
  if (!b) return;
  const c = b.contractDraft || {};
  const venue = c.venue || {};
  const arr = c.arrangoer || {};
  const drawer = document.getElementById('drawer');

  let actionsHtml = '';
  if (b.status === 'sent'){
    actionsHtml = `
      <div class="field"><label>Dit navn (til underskrift)</label><input id="bkSignName" class="input" placeholder="Fornavn Efternavn"></div>
      <div id="bkErr" class="login-err"></div>
      <div class="flex" style="gap:8px;justify-content:flex-end;margin-top:6px">
        <button class="btn btn-ghost" id="bkDeclineBtn">Afvis</button>
        <button class="btn btn-primary" id="bkSignBtn">Godkend og underskriv</button>
      </div>`;
  } else if (b.status === 'band_signed'){
    actionsHtml = `
      <div class="muted" style="font-size:12px;margin-bottom:10px">Afventer arrangørens underskrift. Link udløber ${fmtDate(b.tokenExp)}.</div>
      <div class="flex" style="gap:8px;justify-content:flex-end">
        <button class="btn btn-danger btn-sm" id="bkCancelBtn">Annullér</button>
        <button class="btn btn-ghost" id="bkResendBtn">Gensend link</button>
      </div>`;
  } else if (b.declineReason){
    actionsHtml = `<div class="muted" style="font-size:12px">Begrundelse: ${escapeHtml(b.declineReason)}</div>`;
  }

  const historyHtml = (b.history || []).slice().reverse().map(h => `
    <div style="padding:8px 0;border-bottom:1px solid var(--ink-line-soft);font-size:12px">
      <span class="mono muted" style="font-size:10px">${escapeHtml(fmtDate(h.ts))}</span> — ${escapeHtml(h.actor || '')}${h.note ? ': ' + escapeHtml(h.note) : ''}
    </div>`).join('');
  // Booker-oprettede tilbud har ingen agency-navn på selve rækken (kun det
  // ikke-reversible bookerId-hash) — den første historik-linje ("Kladde oprettet
  // af booker (<agency>)") er den brugervendte kilde til hvem der sendte det.
  const firstHist = (b.history || [])[0];
  const sourceLine = b.source === 'booker'
    ? `<div class="muted" style="font-size:12px;margin-top:6px">Modtaget fra booker${firstHist && firstHist.actor ? ' · ' + escapeHtml(firstHist.actor) : ''}</div>`
    : '';

  drawer.innerHTML = `
    <div class="drawer-head">
      <h2 class="serif">${escapeHtml(venue.name || 'Booking')}</h2>
      <button class="btn btn-text" onclick="closeDrawer()">✕</button>
    </div>
    <div class="drawer-body">
      ${_bookingStatusBadge(b.status)}
      ${sourceLine}
      <div class="kv-grid" style="margin-top:6px">
        <div class="kv"><div class="label">Arrangør</div><div class="value" style="font-size:15px">${escapeHtml(arr.name || b.arrangoerName || '—')}</div></div>
        <div class="kv"><div class="label">Dato</div><div class="value" style="font-size:15px">${fmtDate(c.date)}</div></div>
        <div class="kv"><div class="label">Honorar</div><div class="value" style="font-size:15px">${fmtMoney(c.honorar)}</div></div>
        <div class="kv"><div class="label">Kontrakt-nr</div><div class="value" style="font-size:15px">${escapeHtml(c.id || '—')}</div></div>
      </div>
      ${actionsHtml}
      <div class="eyebrow" style="margin-top:16px;margin-bottom:4px">Forløb</div>
      ${historyHtml || '<div class="muted" style="font-size:12px">Ingen historik.</div>'}
    </div>
  `;
  if (b.status === 'sent'){
    document.getElementById('bkSignBtn').onclick = () => doApproveAndSign(b.id);
    document.getElementById('bkDeclineBtn').onclick = () => doDeclineBooking(b.id);
  } else if (b.status === 'band_signed'){
    document.getElementById('bkCancelBtn').onclick = () => doCancelBooking(b.id);
    document.getElementById('bkResendBtn').onclick = () => doResendSigningLink(b.id);
  }
  drawer.classList.add('show');
  document.getElementById('drawerBackdrop').classList.add('show');
}

async function doApproveAndSign(bookingId){
  const nameEl = document.getElementById('bkSignName');
  const name = (nameEl.value || '').trim();
  const errEl = document.getElementById('bkErr');
  if (!name){ if (errEl){ errEl.textContent = 'Indtast dit navn.'; errEl.classList.add('show'); } return; }
  const btn = document.getElementById('bkSignBtn');
  await withBusy(btn, 'Underskriver…', async () => {
    const b = (CACHE.bookings || []).find(x => x.id === bookingId);
    const d = await apiPost('approveAndSignBooking', { bookingId: bookingId, typedName: name, expectedUpdatedAt: b && b.updatedAt });
    if (!d || !d.ok){ toast((d && d.error) || 'Kunne ikke godkende', 'err'); return; }
    toast('Godkendt og underskrevet — link sendt til arrangøren');
    closeDrawer();
    cacheBust('bookings'); cacheBust('contracts'); renderBookingsList();
  });
}

async function doDeclineBooking(bookingId){
  const reason = prompt('Begrundelse for afvisning (valgfrit):') || '';
  if (!confirm('Afvis dette tilbud?')) return;
  try {
    const d = await apiPost('declineBooking', { bookingId: bookingId, reason: reason });
    if (!d || !d.ok){ toast((d && d.error) || 'Kunne ikke afvise', 'err'); return; }
    toast('Tilbud afvist');
    closeDrawer();
    cacheBust('bookings'); renderBookingsList();
  } catch(e){ toast('Netværksfejl: ' + e.message, 'err'); }
}

async function doCancelBooking(bookingId){
  if (!confirm('Annullér dette underskriftsforløb? Arrangørens link holder op med at virke med det samme.')) return;
  try {
    const d = await apiPost('cancelBooking', { bookingId: bookingId });
    if (!d || !d.ok){ toast((d && d.error) || 'Kunne ikke annullere', 'err'); return; }
    toast('Annulleret');
    closeDrawer();
    cacheBust('bookings'); cacheBust('contracts'); renderBookingsList();
  } catch(e){ toast('Netværksfejl: ' + e.message, 'err'); }
}

async function doResendSigningLink(bookingId){
  try {
    const d = await apiPost('resendSigningLink', { bookingId: bookingId });
    if (!d || !d.ok){ toast((d && d.error) || 'Kunne ikke gensende', 'err'); return; }
    toast('Link gensendt til arrangøren');
  } catch(e){ toast('Netværksfejl: ' + e.message, 'err'); }
}
