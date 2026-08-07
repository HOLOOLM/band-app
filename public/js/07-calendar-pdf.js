// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ─── Kalender-eksport (.ics) ────────────────────────────────────────
// Bygger en standard iCalendar-fil af medlemmets kommende koncerter, som kan
// importeres/abonneres i Google Calendar, Apple Kalender, Outlook m.fl.
function _icsEsc(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n'); }
function _icsLocal(d){ const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`; }
function _icsStampUTC(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; }

function downloadMyCalendar(){
  // Brug den cache der svarer til den viste scope (dette band / alle bands).
  const cache = MEMBER_JOBS_SCOPE === 'all' ? MEMBER_JOBS_CACHE_ALL : MEMBER_JOBS_CACHE;
  const jobs = (cache && cache.jobs ? cache.jobs : []).filter(j => !_isJobArchived(j));
  if (!jobs.length){ toast('Ingen kommende koncerter at eksportere', 'err'); return; }
  const stamp = _icsStampUTC();
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//band-app//DA','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  jobs.forEach(j => {
    const venue = j.venue || {};
    const base = new Date(j.date);
    if (isNaN(base)) return;
    const reTime = /^\d{1,2}:\d{2}$/;
    const hasTime = reTime.test(j.showtimeFrom || '');
    const uid = String(j.attendanceId || ((j.id||'') + '-' + j.date)).replace(/[^A-Za-z0-9-]/g,'') + '@bandapp';
    const addr = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp);
    if (hasTime){
      const [h,m] = j.showtimeFrom.split(':').map(Number);
      const s = new Date(base); s.setHours(h, m, 0, 0);
      let e;
      if (reTime.test(j.showtimeTo || '')){ const [h2,m2] = j.showtimeTo.split(':').map(Number); e = new Date(base); e.setHours(h2, m2, 0, 0); if (e <= s) e.setDate(e.getDate()+1); }
      else { e = new Date(s.getTime() + 3*3600*1000); }
      lines.push('DTSTART:' + _icsLocal(s), 'DTEND:' + _icsLocal(e));
    } else {
      const p = n => String(n).padStart(2,'0');
      lines.push('DTSTART;VALUE=DATE:' + base.getFullYear() + p(base.getMonth()+1) + p(base.getDate()));
    }
    lines.push('SUMMARY:' + _icsEsc((venue.name || 'Koncert') + (j.type ? ' (' + j.type + ')' : '')));
    if (addr) lines.push('LOCATION:' + _icsEsc(addr));
    const desc = [];
    if (j.share != null && j.share !== '') desc.push('Din andel: ' + fmtMoney(j.share));
    if (j.getIn) desc.push('Get-in: ' + j.getIn);
    if (j.soundcheck) desc.push('Lydprøve: ' + j.soundcheck);
    if (desc.length) lines.push('DESCRIPTION:' + _icsEsc(desc.join('\n')));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (BAND_CONFIG.bandShortName || 'band').toString().toLowerCase().replace(/[^a-z0-9]/g,'') + '-koncerter.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(jobs.length + ' koncert' + (jobs.length===1?'':'er') + ' eksporteret til kalender');
}

function homeAddressCardHtml(addr){
  return `
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div class="eyebrow warm" style="margin-bottom:4px">Min hjemmeadresse</div>
        <input id="memberHomeAddr" class="input" placeholder="fx Storegade 1, 1234 Byen" value="${escapeHtml(addr||'')}">
        <div class="muted" style="font-size:11px;margin-top:4px">Bruges til at beregne km til hvert spillested. Sættes som standard startadresse for alle jobs.</div>
      </div>
      <button class="btn btn-primary btn-sm" id="memberHomeAddrSave">Gem</button>
    </div>`;
}

function bindHomeAddressCard(){
  const btn = document.getElementById('memberHomeAddrSave');
  if (!btn) return;
  btn.onclick = async ()=>{
    const v = document.getElementById('memberHomeAddr').value.trim();
    btn.disabled = true; btn.textContent = 'Gemmer…';
    try {
      const d = await apiPost('updateMyAddress', { address: v });
      if (!d.ok) throw new Error(d.error||'Fejl');
      if (SESSION.member) SESSION.member.address = d.address;
      toast('Hjemmeadresse gemt — km opdateres når jobs næste gang hentes');
      MEMBER_JOBS_CACHE = null;
      renderMyJobs({force:true});
    } catch(e){
      btn.disabled = false; btn.textContent = 'Gem';
      toast(e.message||String(e),'err');
    }
  };
  attachDawaAutocomplete(document.getElementById('memberHomeAddr'));
}

/**
 * DAWA-autocomplete for danske adresser. Gratis API, ingen API-nøgle.
 * Viser dropdown med matchende adresser så brugeren kan vælge den rigtige
 * (vigtigt ved flertydige vejnavne som "Grundtvigs Alle 80").
 */
function attachDawaAutocomplete(input){
  if (!input || input._dawaBound) return;
  input._dawaBound = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;flex:1;min-width:0';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.setAttribute('autocomplete','off');
  const list = document.createElement('div');
  list.className = 'dawa-list';
  list.style.cssText = 'position:absolute;left:0;right:0;top:100%;z-index:1000;background:#0F213C;border:1px solid var(--ink-line);border-top:0;border-radius:0 0 var(--radius) var(--radius);max-height:240px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  wrap.appendChild(list);
  let activeIdx = -1;
  let items = [];
  let timer = null;
  let reqSeq = 0; // forældede fetch-svar må ikke overskrive nyere
  const close = ()=>{ list.style.display='none'; activeIdx=-1; };
  const render = ()=>{
    if (!items.length){ close(); return; }
    list.innerHTML = items.map((it,i)=>
      `<div class="dawa-item" data-i="${i}" style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--cream);border-bottom:1px solid var(--ink-line-soft);${i===activeIdx?'background:color-mix(in srgb, var(--accent) 12%, transparent)':''}">${escapeHtml(it.tekst)}</div>`
    ).join('');
    list.style.display = 'block';
    list.querySelectorAll('.dawa-item').forEach(el=>{
      el.onmousedown = (e)=>{ e.preventDefault(); pick(Number(el.getAttribute('data-i'))); };
    });
  };
  const pick = (i)=>{
    if (!items[i]) return;
    input.value = items[i].tekst;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    close();
  };
  const fetchSuggest = async (q)=>{
    const myReq = ++reqSeq;
    if (!q || q.length < 2){ items=[]; close(); return; }
    try {
      // type=adresse giver fulde adresser med husnr; per_side=8 holder dropdown'en kort
      const r = await fetch('https://api.dataforsyningen.dk/autocomplete?type=adresse&per_side=8&q='+encodeURIComponent(q));
      if (!r.ok) return;
      const data = await r.json();
      if (myReq !== reqSeq) return;
      items = Array.isArray(data) ? data : [];
      activeIdx = -1;
      render();
    } catch(e){ /* swallow — autocomplete er nice-to-have */ }
  };
  input.addEventListener('input', ()=>{
    if (timer) clearTimeout(timer);
    timer = setTimeout(()=>fetchSuggest(input.value.trim()), 180);
  });
  input.addEventListener('keydown', (e)=>{
    if (list.style.display === 'none') return;
    if (e.key === 'ArrowDown'){ e.preventDefault(); activeIdx = Math.min(activeIdx+1, items.length-1); render(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); activeIdx = Math.max(activeIdx-1, 0); render(); }
    else if (e.key === 'Enter' && activeIdx >= 0){ e.preventDefault(); pick(activeIdx); }
    else if (e.key === 'Escape'){ close(); }
  });
  input.addEventListener('blur', ()=> setTimeout(close, 150));
}

function _kmLabel(km){
  if (km === '' || km == null || isNaN(km)) return '';
  return Number(km).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' km';
}

/**
 * Bygger de to Google Maps-URL'er (embed-iframe + "åbn i Maps") for ét spillested.
 * Returnerer null hvis der ikke er nogen brugbar destination. Delt af
 * _venueMapIframe (første render) og _updateJobMap (skift af startadresse), så
 * de to veje ikke kan komme til at pege forskellige steder hen.
 */
function _venueMapUrls(venue, origin){
  if (!venue) return null;
  const dest = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (!dest) return null;
  const destEnc = encodeURIComponent(dest);
  const originStr = (origin||'').trim();
  // Vis rute hvis vi har en start-adresse, ellers blot pin på spillestedet
  return {
    dest: dest,
    originStr: originStr,
    src: originStr
      ? `https://www.google.com/maps?saddr=${encodeURIComponent(originStr)}&daddr=${destEnc}&output=embed`
      : `https://www.google.com/maps?q=${destEnc}&output=embed`,
    openUrl: originStr
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originStr)}&destination=${destEnc}`
      : `https://www.google.com/maps?q=${destEnc}`
  };
}

function _venueMapIframe(venue, origin){
  const u = _venueMapUrls(venue, origin);
  if (!u) return '';
  const { src, openUrl, originStr, dest } = u;
  const label = originStr ? `Rute fra ${originStr} til ${dest}` : `Kort over ${dest}`;
  return `<div id="jobMapWrap" style="border-radius:var(--radius);overflow:hidden;border:1px solid var(--ink-line);margin-top:6px">
    <iframe id="jobMapIframe"
      src="${src}"
      width="100%" height="280"
      style="border:0;display:block"
      loading="lazy"
      referrerpolicy="no-referrer-when-downgrade"
      title="${escapeHtml(label)}"></iframe>
    <div style="padding:6px 10px;background:rgba(8,17,31,.4);font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--cream-mute);display:flex;justify-content:space-between;align-items:center">
      <span>${originStr ? 'Rute fra start til spillested' : 'Sæt startadresse for at se rute'}</span>
      <a id="jobMapOpen" href="${openUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">↗ Åbn i Google Maps</a>
    </div>
  </div>`;
}

function _updateJobMap(venue, origin){
  const iframe = document.getElementById('jobMapIframe');
  const link = document.getElementById('jobMapOpen');
  if (!iframe) return;
  const u = _venueMapUrls(venue, origin);
  if (!u) return;
  iframe.src = u.src;
  if (link) link.href = u.openUrl;
}

function _isJobArchived(j){
  if (!j || !j.date) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const jd = new Date(j.date); jd.setHours(0,0,0,0);
  return jd.getTime() < today.getTime();
}

function _daysUntil(date){
  if (!date) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const jd = new Date(date); jd.setHours(0,0,0,0);
  return Math.round((jd.getTime() - today.getTime()) / 86400000);
}

function _countdownLabel(date){
  const n = _daysUntil(date);
  if (n == null) return '';
  if (n === 0) return 'I dag';
  if (n === 1) return 'I morgen';
  if (n === -1) return 'I går';
  if (n < 0) return 'For ' + Math.abs(n) + ' dage siden';
  return 'Om ' + n + ' dage';
}

// Lille band-mærke (logo eller farve-chip) til tværgående visning.
function _bandBadgeHtml(j){
  if (!j.bandId) return '';
  const name = escapeHtml(j.bandName || j.bandShortName || j.bandId);
  const inner = j.bandLogo
    ? `<img src="${j.bandLogo}" alt="" style="width:16px;height:16px;border-radius:3px;object-fit:cover;flex:none">`
    : `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:3px;font-size:8px;font-weight:700;color:#fff;flex:none;background:${escapeHtml(j.bandColor||'#8A8A8A')}">${escapeHtml(String(j.bandShortName||j.bandName||j.bandId).slice(0,2).toUpperCase())}</span>`;
  return `<div class="job-band-badge" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--cream-mute);margin-bottom:4px">${inner}${name}</div>`;
}

function jobCardHtml(j){
  const d = fmtDateShort(j.date);
  const venue = (j.venue && j.venue.name) || 'Uden navn';
  const city = (j.venue && j.venue.city) || '';
  const km = _kmLabel(j.distanceKm);
  const archived = _isJobArchived(j);
  const cd = _countdownLabel(j.date);
  const fullAddr = [(j.venue&&j.venue.address)||'', [(j.venue&&j.venue.postnr)||'', (j.venue&&j.venue.city)||''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const mapsUrl = fullAddr ? `https://www.google.com/maps?q=${encodeURIComponent(fullAddr)}` : '';
  const addrShort = (j.venue&&j.venue.address) ? escapeHtml(j.venue.address) : '—';
  return `
    <div class="card job-card${archived?' job-card-archived':''}" data-att="${escapeHtml(j.attendanceId)}" data-band="${escapeHtml(j.bandId||'')}">
      <div class="job-date">
        <div class="month">${d.month}</div>
        <div class="day">${d.day}</div>
        <div class="year">${d.year}</div>
      </div>
      <div class="job-info">
        ${_bandBadgeHtml(j)}
        <h3 class="job-venue">${escapeHtml(venue)}${archived?' <span class="job-archived-tag">Arkiveret</span>':''}</h3>
        <div class="job-meta">${escapeHtml(city)} · ${escapeHtml(j.type||'')} · ${escapeHtml(j.showtimeFrom||'')}</div>
        <div class="job-share">Din andel: ${fmtMoney(j.share)}</div>
        <div class="job-km mono">↦ ${km ? escapeHtml(km) : '<span style="opacity:.6">— km</span>'}</div>
      </div>
      <div class="job-side">
        <div class="job-countdown-line">${escapeHtml(cd)}</div>
        ${mapsUrl ? `<a class="job-addr-link" href="${mapsUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Åbn i Google Maps">📍 ${addrShort}</a>` : `<div class="job-addr-link" style="opacity:.5">—</div>`}
      </div>
    </div>`;
}

function bindJobCards(jobs){
  document.querySelectorAll('.job-card').forEach(card => {
    card.onclick = ()=>{ setMemberView('jobDetail', { attendanceId: card.getAttribute('data-att'), bandId: card.getAttribute('data-band') || '' }); };
  });
}

async function renderJobDetail(attId, bandId){
  MEMBER_JOB = null;
  const main = document.getElementById('memberMain');
  main.innerHTML = '<div class="muted"><span class="spinner"></span>Henter...</div>';
  try {
    // bandId sættes kun i tværgående visning — overstyrer URL-bandet, så jobbet
    // hentes fra det rigtige band (SSO verificerer adgang).
    const params = { attendanceId: attId };
    if (bandId) params.bandId = bandId;
    const d = await apiGet('getJob', params);
    if (!document.getElementById('memberMain')) return; // navigerede væk
    if (!d.ok){ _failInto('memberMain', d.error || 'Kunne ikke hente jobbet', `renderJobDetail('${escapeHtml(String(attId))}')`); return; }
    MEMBER_JOB = d.job;
    const j = d.job;
    const c = j.contract;
    const besaetningCount = (j.besaetning || []).length;
    const besaetningPills = (j.besaetning || []).map(b =>
      `<div class="member-pill">
         <div class="avatar">${escapeHtml((b.name||'').split(' ').map(n=>n[0]).slice(0,2).join(''))}</div>
         <div style="font-size:13px;color:var(--cream);line-height:1.2">${escapeHtml((b.name||'').split(' ')[0])}</div>
         <div class="mono" style="font-size:9px;color:var(--cream-mute);letter-spacing:0.1em;text-transform:uppercase">${escapeHtml(b.instrument||'')}</div>
       </div>`).join('');
    main.innerHTML = `
      <div class="page-head">
        <div>
          <button class="btn btn-text" onclick="setMemberView('jobs')">← Mine jobs</button>
          <h1 class="serif">${escapeHtml((c.venue&&c.venue.name)||'—')}</h1>
          <div class="lede">${escapeHtml((c.venue&&c.venue.city)||'')} · ${fmtDate(c.date)}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="downloadJobCalendar(MEMBER_JOB)">📅 Tilføj til kalender</button>
          <button class="btn btn-ghost btn-sm" onclick="downloadMemberCallsheet(MEMBER_JOB)">↓ Call sheet</button>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="eyebrow warm">Tider & honorar</div>
        <div class="kv-grid">
          <div class="kv"><div class="label">Get-in</div><div class="value">${escapeHtml(c.getIn||'—')}</div></div>
          <div class="kv"><div class="label">Lydprøve færdig</div><div class="value">${escapeHtml(c.soundcheck||'—')}</div></div>
          <div class="kv"><div class="label">Spilletid</div><div class="value">${escapeHtml(c.showtimeFrom||'—')}–${escapeHtml(c.showtimeTo||'—')}</div></div>
          <div class="kv"><div class="label">Din andel</div><div class="value" style="color:var(--accent)">${fmtMoney(j.share)}</div></div>
          ${c.sets ? `<div class="kv"><div class="label">Antal sæt</div><div class="value">${c.sets} × ${c.setMinutes} min</div></div>` : ''}
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="eyebrow warm">Adresse</div>
        <div class="serif" style="font-size:20px;margin:6px 0">${escapeHtml((c.venue&&c.venue.address)||'—')}</div>
        <div class="muted" style="margin-bottom:10px">${escapeHtml((c.venue&&c.venue.postnr)||'')} ${escapeHtml((c.venue&&c.venue.city)||'')}</div>
        ${_venueMapIframe(c.venue, j.startAddress || j.homeAddress || (SESSION.member && SESSION.member.address) || '')}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="eyebrow warm">Kørsel</div>
        <div style="display:flex;align-items:center;gap:12px;margin:6px 0;flex-wrap:wrap">
          <div class="serif" id="jobKmDisplay" style="font-size:20px;color:var(--accent);min-width:80px">${_kmLabel(j.distanceKm) || '—'}</div>
          <button class="btn btn-ghost btn-sm" id="jobKmRecalc" type="button">↻ Re-beregn</button>
          <div class="muted" style="font-size:12px;flex:1;min-width:150px">fra <span id="jobKmOrigin">${escapeHtml(j.distanceOrigin || j.startAddress || j.homeAddress || 'din hjemmeadresse')}</span></div>
        </div>
        <div class="field" style="margin-top:10px">
          <label>Alternativ startadresse (valgfri)</label>
          <div style="display:flex;gap:8px">
            <input id="jobStartAddr" class="input" placeholder="Lad være tom for at bruge din hjemmeadresse" value="${escapeHtml(j.startAddress||'')}" style="flex:1">
            <button class="btn btn-ghost btn-sm" id="jobStartAddrSave">Gem & beregn</button>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">Brug hvis du kører fra et andet sted end hjemme den dag — km opdateres automatisk når du gemmer.</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="eyebrow warm">Besætning</div>
          ${besaetningCount ? `<span class="count-badge">${besaetningCount} ${besaetningCount===1?'person':'personer'}</span>` : ''}
        </div>
        <div class="member-pill-row">
          ${besaetningPills || '<div class="muted" style="font-size:13px">Ingen registreret endnu</div>'}
        </div>
      </div>
    `;
    const saveBtn = document.getElementById('jobStartAddrSave');
    if (saveBtn) saveBtn.onclick = async ()=>{
      if (saveBtn.disabled) return;
      saveBtn.disabled = true; saveBtn.textContent = 'Gemmer…';
      const v = document.getElementById('jobStartAddr').value.trim();
      try {
        const r = await apiPost('updateJobStartAddress', { attendanceId: MEMBER_JOB.attendanceId, startAddress: v });
        if (!r.ok) throw new Error(r.error||'Fejl');
        MEMBER_JOB.startAddress = r.startAddress;
        MEMBER_JOB.distanceKm = '';
        MEMBER_JOB.distanceOrigin = '';
        const newOrigin = r.startAddress || (SESSION.member && SESSION.member.address) || '';
        document.getElementById('jobKmOrigin').textContent = newOrigin || 'din hjemmeadresse';
        _updateJobMap(MEMBER_JOB.contract && MEMBER_JOB.contract.venue, newOrigin);
        saveBtn.textContent = 'Beregner km…';
        const calc = await apiPost('recalcJobDistance', { attendanceId: MEMBER_JOB.attendanceId });
        if (calc.ok) {
          MEMBER_JOB.distanceKm = calc.distanceKm;
          MEMBER_JOB.distanceOrigin = calc.distanceOrigin;
          document.getElementById('jobKmDisplay').textContent = _kmLabel(calc.distanceKm) || '—';
          toast('Startadresse gemt — km: ' + (_kmLabel(calc.distanceKm)||'—'));
        } else {
          document.getElementById('jobKmDisplay').textContent = '—';
          toast(calc.error || 'Kunne ikke beregne km','err');
        }
      } catch(e){ toast(e.message||String(e),'err'); }
      finally { saveBtn.disabled = false; saveBtn.textContent = 'Gem & beregn'; }
    };
    attachDawaAutocomplete(document.getElementById('jobStartAddr'));
    const recalcBtn = document.getElementById('jobKmRecalc');
    if (recalcBtn) recalcBtn.onclick = async ()=>{
      if (recalcBtn.disabled) return;
      recalcBtn.disabled = true;
      const origText = recalcBtn.textContent;
      recalcBtn.textContent = '↻ Beregner…';
      try {
        const r = await apiPost('recalcJobDistance', { attendanceId: MEMBER_JOB.attendanceId });
        if (!r.ok) throw new Error(r.error||'Fejl');
        MEMBER_JOB.distanceKm = r.distanceKm;
        MEMBER_JOB.distanceOrigin = r.distanceOrigin;
        document.getElementById('jobKmDisplay').textContent = _kmLabel(r.distanceKm) || '—';
        document.getElementById('jobKmOrigin').textContent = r.distanceOrigin || 'din hjemmeadresse';
        recalcBtn.textContent = '↻ Re-beregn';
        MEMBER_JOBS_CACHE = null;
        toast('Km beregnet: ' + (_kmLabel(r.distanceKm)||'—'));
      } catch(e){
        recalcBtn.textContent = origText;
        toast(e.message||String(e),'err');
      } finally { recalcBtn.disabled = false; }
    };
  } catch(e){ _failInto('memberMain', e.message, `renderJobDetail('${escapeHtml(String(attId))}')`); }
}

function renderMyProfile(){
  const m = SESSION.member || {};
  const main = document.getElementById('memberMain');
  main.innerHTML = `
    <div style="max-width:520px;margin:32px auto;padding:0 16px">
      <h2 class="serif" style="margin-bottom:20px">Min profil</h2>
      <div class="card" style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="eyebrow" style="font-size:10px;letter-spacing:.1em;color:var(--cream-mute)">NAVN</label>
          <input id="prof_name" class="inp" value="${escapeHtml(m.name||'')}" placeholder="Dit fulde navn">
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="eyebrow" style="font-size:10px;letter-spacing:.1em;color:var(--cream-mute)">INSTRUMENT</label>
          <input id="prof_instrument" class="inp" value="${escapeHtml(m.instrument||'')}" placeholder="Fx guitar, trommer…">
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="eyebrow" style="font-size:10px;letter-spacing:.1em;color:var(--cream-mute)">TELEFON</label>
          <input id="prof_phone" class="inp" type="tel" value="${escapeHtml(m.phone||'')}" placeholder="+45 12 34 56 78">
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label class="eyebrow" style="font-size:10px;letter-spacing:.1em;color:var(--cream-mute)">ADRESSE</label>
          <input id="prof_address" class="inp" value="${escapeHtml(m.address||'')}" placeholder="Vejnavn 1, 1234 By">
        </div>
        <div style="padding-top:4px;display:flex;gap:10px;align-items:center">
          <button class="btn btn-primary" onclick="saveMyProfile()">Gem ændringer</button>
          <span id="profStatus" style="font-size:12px;color:var(--cream-mute)"></span>
        </div>
        <p style="font-size:11px;color:var(--cream-mute);margin:0;padding-top:4px;border-top:1px solid var(--ink-line)">
          Email: <strong>${escapeHtml(m.email||'')}</strong> · Kan ikke ændres her — kontakt admin.
        </p>
      </div>

      <div class="card" style="margin-top:16px">
        <h3 class="serif" style="margin:0 0 4px;font-size:16px">Mine data & privatliv</h3>
        <p style="font-size:12px;color:var(--cream-mute);margin:0 0 14px">Du har ret til indsigt i og en kopi af de oplysninger, vi behandler om dig (GDPR art. 15 & 20).</p>
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="gdprExportMyData(this)">↓ Download mine data (JSON)</button>
          <button class="btn btn-text btn-sm" onclick="showPrivacyPolicy()">Privatlivspolitik</button>
        </div>
      </div>
    </div>`;
}

// GDPR: hent og download alle egne data som JSON-fil.
async function gdprExportMyData(btn){
  const orig = btn ? btn.textContent : '';
  if (btn){ btn.disabled = true; btn.textContent = 'Henter…'; }
  try {
    const d = await _apiCall('exportMyData', {});
    if (!d || !d.ok) throw new Error((d && d.error) || 'Kunne ikke hente data');
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mine-data-' + (BAND_ID || 'band') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('Dine data er downloadet');
  } catch(e){ toast(e.message, 'err'); }
  finally { if (btn){ btn.disabled = false; btn.textContent = orig; } }
}

// Viser privatlivspolitik i et simpelt overlay. Controller-kontakt trækkes fra bandets config.
function showPrivacyPolicy(){
  const c = BAND_CONFIG;
  const contact = [c.contactName, c.contactEmail].filter(Boolean).join(', ') || 'bandets administrator';
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.onclick = (e)=>{ if (e.target === ov) ov.remove(); };
  ov.innerHTML = `
    <div class="card" style="max-width:560px;max-height:84vh;overflow:auto">
      <h2 class="serif" style="margin:0 0 12px">Privatlivspolitik</h2>
      <div style="font-size:13px;color:var(--cream-dim);line-height:1.6">
        <p><strong>${escapeHtml(c.bandName||'Bandet')}</strong> behandler dine personoplysninger (navn, email, telefon, adresse, kontonummer samt dine bookinger og honorar) udelukkende for at administrere bandets koncerter, kørsel og udbetalinger.</p>
        <p><strong>Retsgrundlag:</strong> opfyldelse af aftale samt legitim interesse i at drive bandets aktiviteter.</p>
        <p><strong>Opbevaring:</strong> oplysningerne opbevares så længe du er tilknyttet bandet og af hensyn til bogføring/regnskab.</p>
        <p><strong>Dine rettigheder:</strong> indsigt, berigtigelse, sletning og dataportabilitet. Brug "Download mine data" for en kopi, eller kontakt ${escapeHtml(contact)} for at få rettet eller slettet oplysninger.</p>
        <p style="color:var(--cream-mute);font-size:12px">Dataene hostes i Google Sheets/Drive under den dataansvarliges Google-konto.</p>
      </div>
      <div style="text-align:right;margin-top:14px"><button class="btn btn-primary btn-sm" onclick="this.closest('div[style*=fixed]').remove()">Luk</button></div>
    </div>`;
  document.body.appendChild(ov);
}

async function saveMyProfile(){
  const btn = document.querySelector('#memberMain .btn-primary');
  const status = document.getElementById('profStatus');
  if (btn) btn.disabled = true;
  status.textContent = 'Gemmer…';
  try {
    const d = await _apiCall('memberUpdateProfile', {
      name:       document.getElementById('prof_name').value.trim(),
      instrument: document.getElementById('prof_instrument').value.trim(),
      phone:      document.getElementById('prof_phone').value.trim(),
      address:    document.getElementById('prof_address').value.trim()
    });
    if (!d.ok) throw new Error(d.error || 'Fejl');
    // Opdatér SESSION så resten af appen ser de nye data
    SESSION.member = Object.assign(SESSION.member || {}, d.member || {});
    document.getElementById('memberName').textContent = SESSION.member.name || '';
    document.getElementById('memberAvatar').textContent = initials(SESSION.member.name);
    status.textContent = 'Gemt ✓';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch(e) {
    status.textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function renderMyHonorar(){
  const main = document.getElementById('memberMain');
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const scopeToggle = BAND_CONFIG.crossBand ? `
    <div class="job-scope-row" style="display:flex;gap:6px;margin-bottom:12px">
      <button class="job-filter-pill${MEMBER_HONORAR_SCOPE!=='all'?' active':''}" onclick="setHonorarScope('this')">Dette band</button>
      <button class="job-filter-pill${MEMBER_HONORAR_SCOPE==='all'?' active':''}" onclick="setHonorarScope('all')" title="Se din samlede optjening på tværs af alle bands med funktionen slået til">🌐 Alle bands</button>
    </div>` : '';
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Mit honorar</h1>
        <div class="lede">Vælg periode og se din optjening.</div>
      </div>
    </div>
    ${scopeToggle}
    <div class="card" style="margin-bottom:14px">
      <div class="row-3">
        <div class="field"><label>Fra</label><input id="hFra" class="input" type="date" value="${yearStart.toISOString().slice(0,10)}"></div>
        <div class="field"><label>Til</label><input id="hTil" class="input" type="date" value="${today.toISOString().slice(0,10)}"></div>
        <div class="field" style="justify-content:flex-end;display:flex"><button id="hSearchBtn" class="btn btn-primary" onclick="loadHonorar()" style="margin-top:auto">Søg</button></div>
      </div>
    </div>
    <div id="hStats" class="grid-4" style="margin-bottom:14px"></div>
    <div class="card" style="padding:0;overflow:hidden"><div id="hRows" class="muted" style="padding:24px">Tryk søg for at hente jobs i perioden...</div></div>
  `;
}

let MEMBER_HONORAR_SCOPE = 'this'; // 'this' = dette band · 'all' = alle bands
function setHonorarScope(scope){
  if (scope === MEMBER_HONORAR_SCOPE) return;
  MEMBER_HONORAR_SCOPE = scope;
  renderMyHonorar();
}

async function loadHonorar(){
  const fra = document.getElementById('hFra').value;
  const til = document.getElementById('hTil').value;
  const btn = document.getElementById('hSearchBtn');
  const statsEl = document.getElementById('hStats');
  const rowsEl = document.getElementById('hRows');
  const origLabel = btn ? btn.textContent : 'Søg';
  if (btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Henter…'; }
  if (statsEl) statsEl.innerHTML = '';
  if (rowsEl) rowsEl.innerHTML = '<div class="muted" style="padding:18px"><span class="spinner"></span>Henter honorar…</div>';
  try {
    if (MEMBER_HONORAR_SCOPE === 'all') {
      await _loadAllHonorar(fra, til, statsEl, rowsEl);
      return;
    }
    const d = await apiGet('getMyHonorar', { fra: fra, til: til });
    if (!d.ok){ if (rowsEl) rowsEl.innerHTML = _errBox(d.error || 'Kunne ikke hente honorar', 'loadHonorar()'); return; }
    document.getElementById('hStats').innerHTML = `
      <div class="stat-tile"><div class="label">Total optjent</div><div class="value warm">${fmtMoney(d.total)}</div></div>
      <div class="stat-tile"><div class="label">Antal jobs</div><div class="value">${d.rows.length}</div></div>
      <div class="stat-tile"><div class="label">Total kørsel</div><div class="value">${_kmLabel(d.totalKm) || '—'}</div></div>
      <div class="stat-tile"><div class="label">Til konto</div><div class="value mono" style="font-size:18px;font-family:var(--font-mono)">${escapeHtml(d.member.regAccount||'—')}</div></div>
    `;
    if (!d.rows.length){
      document.getElementById('hRows').innerHTML = '<div class="empty">Ingen jobs i perioden.</div>';
      return;
    }
    // Gem data så download-knappen kan bruge dem
    window._lastHonorar = { rows: d.rows, total: d.total, totalKm: d.totalKm, member: d.member, fra, til };
    document.getElementById('hRows').innerHTML = `
      <div style="padding:14px 18px;border-bottom:1px solid var(--ink-line);display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="memberPreviewHonorar()">👁 Forhåndsvis</button>
        <button class="btn btn-primary btn-sm" onclick="memberDownloadHonorar()">↓ Download PDF</button>
      </div>
      <table class="table">
        <thead><tr><th>Spilledato</th><th>Jobtitel</th><th>Adresse</th><th style="text-align:right">Km</th><th style="text-align:right">Hyre</th></tr></thead>
        <tbody>
          ${d.rows.map(r=>{
            const venue = r.venue || {};
            const adresse = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
            return `<tr>
              <td class="mono" style="color:var(--accent);white-space:nowrap">${fmtDate(r.date)}</td>
              <td><span class="serif" style="font-size:15px">${escapeHtml(venue.name||'—')}</span></td>
              <td style="font-size:12px;color:var(--cream-mute)">${escapeHtml(adresse)}</td>
              <td style="text-align:right;white-space:nowrap" class="mono">${escapeHtml(_kmLabel(r.distanceKm)||'—')}</td>
              <td style="text-align:right;white-space:nowrap" class="mono">${fmtMoney(r.share)}</td>
            </tr>`;}).join('')}
          <tr style="background:color-mix(in srgb, var(--accent) 6%, transparent)"><td colspan="3" class="mono" style="text-align:right;color:var(--accent)">TOTAL</td><td style="text-align:right;white-space:nowrap" class="mono">${escapeHtml(_kmLabel(d.totalKm)||'—')}</td><td style="text-align:right;white-space:nowrap" class="mono"><strong>${fmtMoney(d.total)}</strong></td></tr>
        </tbody>
      </table>`;
  } catch(e){ if (rowsEl) rowsEl.innerHTML = _errBox(e.message, 'loadHonorar()'); }
  finally { if (btn){ btn.disabled = false; btn.textContent = origLabel; } }
}

// Tværgående honorar: samlet optjening grupperet pr. band, med samlet total.
// Bevidst UDEN faktura-download — fakturering sker fortsat pr. band; dette er et overblik.
async function _loadAllHonorar(fra, til, statsEl, rowsEl){
  const d = await apiGet('getAllHonorar', { fra: fra, til: til });
  if (!d.ok){ if (rowsEl) rowsEl.innerHTML = _errBox(d.error || 'Kunne ikke hente honorar på tværs', 'loadHonorar()'); return; }
  const bands = d.bands || [];
  const jobCount = bands.reduce((s,b)=> s + (b.rows ? b.rows.length : 0), 0);
  if (statsEl) statsEl.innerHTML = `
    <div class="stat-tile"><div class="label">Samlet optjent</div><div class="value warm">${fmtMoney(d.grandTotal)}</div></div>
    <div class="stat-tile"><div class="label">Antal jobs</div><div class="value">${jobCount}</div></div>
    <div class="stat-tile"><div class="label">Samlet kørsel</div><div class="value">${_kmLabel(d.grandTotalKm) || '—'}</div></div>
    <div class="stat-tile"><div class="label">Bands</div><div class="value">${bands.length}</div></div>
  `;
  if (!bands.length){
    if (rowsEl) rowsEl.innerHTML = '<div class="empty">Du spiller ikke i andre bands med denne funktion slået til.</div>';
    return;
  }
  const bandHeader = b => {
    const inner = b.bandLogo
      ? `<img src="${b.bandLogo}" alt="" style="width:20px;height:20px;border-radius:4px;object-fit:cover;flex:none">`
      : `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;font-size:9px;font-weight:700;color:#fff;flex:none;background:${escapeHtml(b.bandColor||'#8A8A8A')}">${escapeHtml(String(b.bandShortName||b.bandName||'').slice(0,2).toUpperCase())}</span>`;
    return `<span style="display:inline-flex;align-items:center;gap:8px">${inner}<strong style="font-size:15px">${escapeHtml(b.bandName)}</strong></span>`;
  };
  const sections = bands.map(b => {
    const rowsHtml = (b.rows||[]).map(r=>{
      const venue = r.venue || {};
      const adresse = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return `<tr>
        <td class="mono" style="color:var(--accent);white-space:nowrap">${fmtDate(r.date)}</td>
        <td><span class="serif" style="font-size:15px">${escapeHtml(venue.name||'—')}</span></td>
        <td style="font-size:12px;color:var(--cream-mute)">${escapeHtml(adresse)}</td>
        <td style="text-align:right;white-space:nowrap" class="mono">${escapeHtml(_kmLabel(r.distanceKm)||'—')}</td>
        <td style="text-align:right;white-space:nowrap" class="mono">${fmtMoney(r.share)}</td>
      </tr>`;}).join('');
    return `
      <div style="padding:14px 18px;border-bottom:1px solid var(--ink-line);background:color-mix(in srgb, var(--accent) 4%, transparent)">${bandHeader(b)}</div>
      <table class="table">
        <thead><tr><th>Spilledato</th><th>Jobtitel</th><th>Adresse</th><th style="text-align:right">Km</th><th style="text-align:right">Hyre</th></tr></thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="5" class="muted" style="padding:14px">Ingen jobs i perioden.</td></tr>'}
          <tr style="background:color-mix(in srgb, var(--accent) 6%, transparent)"><td colspan="3" class="mono" style="text-align:right;color:var(--accent)">SUBTOTAL</td><td style="text-align:right;white-space:nowrap" class="mono">${escapeHtml(_kmLabel(b.totalKm)||'—')}</td><td style="text-align:right;white-space:nowrap" class="mono"><strong>${fmtMoney(b.total)}</strong></td></tr>
        </tbody>
      </table>`;
  }).join('');
  if (rowsEl) rowsEl.innerHTML = `
    <div style="padding:12px 18px;border-bottom:1px solid var(--ink-line);font-size:12px;color:var(--cream-mute)">
      Overblik på tværs af dine bands. Fakturering og udbetaling sker fortsat særskilt pr. band.
    </div>
    ${sections}
    <div style="padding:16px 18px;border-top:2px solid var(--accent);display:flex;justify-content:space-between;align-items:center">
      <span class="mono" style="color:var(--accent)">SAMLET PÅ TVÆRS</span>
      <strong style="font-size:18px">${fmtMoney(d.grandTotal)}</strong>
    </div>`;
}

// ─── PDF download helpers ─────────────────────────────────────────

function pdfPrintStyles(){
  return `
    @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#fff;font-family:'Inter',sans-serif;font-size:12px;color:#1A1A1A;padding:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .pdf-page{background:#ffffff;padding:36px 40px;max-width:700px;margin:0 auto;page-break-after:always}
    .pdf-page:last-child{page-break-after:avoid}
    .pdf-eyebrow{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#8A6F4D}
    .pdf-big{font-family:'Instrument Serif',serif;font-size:32px;color:#0F213C;line-height:1}
    .pdf-strong{color:#0F213C;font-weight:600;font-size:13px;margin-top:2px}
    .pdf-text{color:#2A2A2A;font-size:12px;line-height:1.5}
    .pdf-divider{border-top:1px solid #E5DAC4;margin:14px 0}
    .pdf-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    .pdf-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .pdf-attendees{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
    .pdf-attendee{background:#EFE3CC;padding:2px 7px;border-radius:3px;font-size:11px;color:#0F213C}
    .pdf-foot{margin-top:18px;padding-top:12px;border-top:1px solid #E5DAC4;font-size:10px;color:#6A5A40}
    ol{padding-left:16px;line-height:1.7} li{margin-bottom:6px}
    @media print{body{padding:0}@page{margin:10mm;size:A4}}
  `;
}

// Substituerer __BAND_NAME__, __CONTACT_NAME__ osv. med værdier fra BAND_CONFIG.
function _brandify(str){
  if (!str) return str;
  const addr = _b('contactAddress');
  const map = {
    '__BAND_NAME__': _b('bandName'),
    '__BAND_SHORT__': _b('bandShortName'),
    '__CONTACT_NAME__': _b('contactName'),
    '__CONTACT_PHONE__': _b('contactPhone'),
    '__CONTACT_EMAIL__': _b('contactEmail'),
    '__CONTACT_ADDR1__': (addr.split('\n')[0] || addr),
    '__CONTACT_ADDR2__': (addr.split('\n')[1] || ''),
    '__TECH_NAME__': _b('techContactName'),
    '__TECH_PHONE__': _b('techContactPhone'),
    '__BANK_NAME__': _b('bankName'),
    '__BANK_REG__': _b('bankReg'),
    '__BANK_KTO__': _b('bankKto'),
    '__PAYEE_NAME__': _b('payeeName'),
    '__PAYEE_ADDR1__': (_b('payeeAddress').split('\n')[0] || _b('payeeAddress')),
    '__PAYEE_ADDR2__': (_b('payeeAddress').split('\n')[1] || '')
  };
  return String(str).replace(/__[A-Z0-9_]+__/g, m => (m in map ? map[m] : m));
}

function openPrintWindow(title, bodyHtml){
  title = _brandify(title);
  bodyHtml = _brandify(bodyHtml);
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>${pdfPrintStyles()}</style></head><body>${bodyHtml}<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) toast('Popup blokeret — tillad popups for denne side og prøv igen', 'err');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Som openPrintWindow, men UDEN auto-print + tilføjer en navy bar med Print/Gem-knap.
function openPreviewWindow(title, bodyHtml){
  const printBar = `<div style="position:fixed;top:0;left:0;right:0;background:#0F213C;color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-family:'Inter',sans-serif;font-size:13px;z-index:1000" class="no-print">
    <span>${escapeHtml(title)} · Tryk <b>Print</b> og vælg "Gem som PDF" for at downloade</span>
    <button onclick="window.print()" style="background:#fff;color:#0F213C;border:0;padding:8px 16px;border-radius:4px;font-weight:600;cursor:pointer">🖨 Print / Gem som PDF</button>
  </div>`;
  const extraStyle = `@media print{.no-print{display:none !important}}body{padding-top:60px}`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>${pdfPrintStyles()}${extraStyle}</style></head><body>${printBar}${bodyHtml}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) toast('Popup blokeret — tillad popups for denne side og prøv igen', 'err');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadContractPDF(){
  if (!EDITING) return;
  const previewEl = document.getElementById('cPreview');
  if (!previewEl) return;
  const pages = previewEl.querySelectorAll('.pdf-page');
  if (!pages.length){ toast('Ingen preview at printe','err'); return; }
  let pagesHtml = '';
  pages.forEach(p => { pagesHtml += p.outerHTML; });
  openPrintWindow(`Kontrakt — ${(EDITING.venue&&EDITING.venue.name)||_b('bandShortName')||'BAND'}`, pagesHtml);
}

function downloadContractOverviewPDF(){
  if (!EDITING) return;
  const previewEl = document.getElementById('cPreview');
  if (!previewEl) return;
  const firstPage = previewEl.querySelector('.pdf-page');
  if (!firstPage){ toast('Ingen preview at printe','err'); return; }
  openPrintWindow(`Oversigt — ${(EDITING.venue&&EDITING.venue.name)||_b('bandShortName')||'BAND'}`, firstPage.outerHTML);
}

function _buildHonorarBody(rows, total, member, fra, til, totalKm){
  const logoUrl = DMD_LOGO_B64;
  const rowsHtml = rows.map(r=>{
    const venue = r.venue || {};
    const adresse = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #E5DAC4;font-family:'JetBrains Mono',monospace;color:#8A6F4D;white-space:nowrap">${fmtDate(r.date)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E5DAC4">
        <span style="font-family:'Instrument Serif',serif;font-size:15px">${escapeHtml(venue.name||'—')}</span>
      </td>
      <td style="padding:7px 10px;border-bottom:1px solid #E5DAC4;font-size:11px;color:#4A4A4A">${escapeHtml(adresse)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E5DAC4;text-align:right;font-family:'JetBrains Mono',monospace;white-space:nowrap">${escapeHtml(_kmLabel(r.distanceKm)||'—')}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E5DAC4;text-align:right;font-family:'JetBrains Mono',monospace;white-space:nowrap">${fmtMoney(r.share)}</td>
    </tr>`;}).join('');
  const body = `<style>table{width:100%;border-collapse:collapse}
    th{text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#8A6F4D;padding:8px 10px;border-bottom:2px solid #C8B99A}
    .total-row td{background:#EFE3CC;font-weight:700;font-family:'JetBrains Mono',monospace;padding:8px 10px;color:#0F213C}</style>
  <div class="pdf-page">
    <div style="background:#0F213C;margin:-36px -40px 20px;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:4px 4px 0 0">
      <img src="${logoUrl}" alt="" style="height:44px;object-fit:contain">
      <div style="color:#fff;font-family:'Inter',sans-serif;font-size:18px;font-weight:700;flex:1;text-align:center">Honorar opgørelse</div>
      <div style="text-align:right;color:rgba(255,255,255,.7);font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.06em">__BAND_NAME__<br>${new Date().getFullYear()}</div>
    </div>
    <div class="pdf-eyebrow" style="margin-bottom:4px">Honoraroversigt</div>
    <div class="pdf-big" style="font-size:26px;margin-bottom:4px">${escapeHtml(member.name)}</div>
    <div class="pdf-text" style="color:#8A6F4D;margin-bottom:16px">Periode: ${fmtDate(fra)} – ${fmtDate(til)}</div>
    <div class="pdf-divider"></div>
    <table>
      <thead><tr><th>Spilledato</th><th>Jobtitel</th><th>Adresse</th><th style="text-align:right">Km</th><th style="text-align:right">Hyre</th></tr></thead>
      <tbody>${rowsHtml}
        <tr class="total-row"><td colspan="3" style="text-align:right;padding:8px 10px">TOTAL</td><td style="text-align:right;padding:8px 10px;white-space:nowrap">${escapeHtml(_kmLabel(totalKm)||'—')}</td><td style="text-align:right;padding:8px 10px;white-space:nowrap">${fmtMoney(total)}</td></tr>
      </tbody>
    </table>
    <div class="pdf-foot">__BAND_NAME__ · Udskrevet ${new Date().toLocaleDateString('da-DK')} · Til brug ved årsregnskab</div>
  </div>`;
  return body;
}

function downloadHonorarPDF(rows, total, member, fra, til, totalKm){
  openPrintWindow(`Honorar — ${escapeHtml(member.name)}`, _buildHonorarBody(rows, total, member, fra, til, totalKm));
}

function previewHonorarPDF(rows, total, member, fra, til, totalKm){
  openPreviewWindow(`Honorar — ${escapeHtml(member.name)}`, _buildHonorarBody(rows, total, member, fra, til, totalKm));
}

// Honorarafregningen renderes SERVER-SIDE (Fase 2 i SECURITY-PLAN): Worker'en
// henter en færdig PDF med CPR indsat fra backend og streamer den til fanen.
// CPR findes derfor aldrig i browserens Network-JSON eller DOM — kun i den
// PDF-fil, som den autoriserede admin bevidst åbner. Fakturanr reserveres
// server-side i samme kald (genbruger eksisterende række hvis den findes).
function downloadFakturaPDF(){
  if (!EDITING) return;
  const c = EDITING;
  if (!c.id){ toast('Gem kontrakten først','err'); return; }

  // Åbn fanen SYNKRONT for at bevare user-gesture (ellers blokerer browseren popup'en).
  const w = window.open('/api/faktura-pdf?contractId=' + encodeURIComponent(c.id), '_blank');
  if (!w){ toast('Popup blokeret — tillad popups for denne side og prøv igen','err'); return; }
  cacheBust('invoices'); broadcastInvalidate(['invoices']);
  toast('Honorarafregning klargøres — PDF\'en åbner i en ny fane. Arkivér fra Honorarafregninger-fanen.');
}

function memberDownloadHonorar(){
  const h = window._lastHonorar;
  if (!h || !h.rows.length){ toast('Ingen data — tryk Søg først','err'); return; }
  downloadHonorarPDF(h.rows, h.total, h.member, h.fra, h.til, h.totalKm);
}

function memberPreviewHonorar(){
  const h = window._lastHonorar;
  if (!h || !h.rows.length){ toast('Ingen data — tryk Søg først','err'); return; }
  previewHonorarPDF(h.rows, h.total, h.member, h.fra, h.til, h.totalKm);
}

function _parseTimeStr(s){
  // Accept "kl. 16.00", "16:00", "16.00", "16" — return {h,m} or null
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[:.\s]*(\d{2})?/);
  if (!m) return null;
  const h = parseInt(m[1],10), mn = m[2] ? parseInt(m[2],10) : 0;
  if (isNaN(h) || h<0 || h>23 || mn<0 || mn>59) return null;
  return { h, m: mn };
}

function _icsDate(d, t){
  // Local-time format YYYYMMDDTHHmmSS (no Z = floating local time, virker på alle kalendere)
  const pad = n => String(n).padStart(2,'0');
  return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) +
    'T' + pad(t ? t.h : 0) + pad(t ? t.m : 0) + '00';
}

function _icsEscape(s){
  return String(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
}

function downloadJobCalendar(job){
  if (!job || !job.contract) return;
  const c = job.contract;
  if (!c.date){ toast('Kontrakt mangler dato','err'); return; }
  const dateObj = new Date(c.date);
  if (isNaN(dateObj)){ toast('Ugyldig dato','err'); return; }

  // Start: getIn → fallback soundcheck → fallback showtimeFrom → fallback all-day
  const startT = _parseTimeStr(c.getIn) || _parseTimeStr(c.soundcheck) || _parseTimeStr(c.showtimeFrom);
  const endT   = _parseTimeStr(c.showtimeTo) || (startT ? { h: Math.min(23, startT.h + 4), m: startT.m } : null);

  const venue = c.venue || {};
  const loc = [venue.address, [venue.postnr, venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const descParts = [
    c.getIn        && 'Get-in: ' + c.getIn,
    c.soundcheck   && 'Lydprøve færdig kl.: ' + c.soundcheck,
    (c.showtimeFrom||c.showtimeTo) && 'Spilletid: ' + [c.showtimeFrom, c.showtimeTo].filter(Boolean).join('–'),
    c.sets         && 'Sæt: ' + c.sets + ' × ' + c.setMinutes + ' min',
    job.share      && 'Din andel: ' + fmtMoney(job.share)
  ].filter(Boolean).join('\n');

  const uid = 'band-' + (job.attendanceId || c.id || Date.now()) + '@' + (_b('emailDomain')||'example.com');
  const dtStamp = _icsDate(new Date(), { h: new Date().getHours(), m: new Date().getMinutes() });

  let dtStart, dtEnd, allDay = false;
  if (startT && endT){
    dtStart = 'DTSTART:' + _icsDate(dateObj, startT);
    dtEnd   = 'DTEND:'   + _icsDate(dateObj, endT);
  } else {
    // All-day fallback
    allDay = true;
    const next = new Date(dateObj); next.setDate(next.getDate()+1);
    const yyyymmdd = d => d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
    dtStart = 'DTSTART;VALUE=DATE:' + yyyymmdd(dateObj);
    dtEnd   = 'DTEND;VALUE=DATE:'   + yyyymmdd(next);
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//' + (_b('bandShortName')||'BAND') + '//App//DA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + dtStamp,
    dtStart,
    dtEnd,
    'SUMMARY:' + _icsEscape((_b('bandShortName')||'BAND') + ' — ' + (venue.name||'Job')),
    loc ? 'LOCATION:' + _icsEscape(loc) : null,
    descParts ? 'DESCRIPTION:' + _icsEscape(descParts) : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean);

  // CRLF per RFC 5545
  const ics = lines.join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const fn = (_b('bandShortName')||'BAND') + '-' + (venue.name||'job').replace(/[^a-zA-Z0-9æøåÆØÅ-]+/g,'-') + '-' + dateObj.toISOString().slice(0,10) + '.ics';
  const a = document.createElement('a');
  a.href = url; a.download = fn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 30000);
  toast(allDay ? 'Heldagsbegivenhed tilføjet (ingen tider angivet)' : 'Kalenderfil downloadet — åbn for at tilføje');
}

function downloadMemberCallsheet(job){
  if (!job) return;
  const logoUrl = DMD_LOGO_B64;
  const c = job.contract || {};
  const venue = c.venue || {};
  const rider = riderFor(c.type).points;
  const besaetningHtml = (job.besaetning || []).map(b =>
    `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #E5DAC4">
      <div style="font-weight:600;color:#0F213C">${escapeHtml(b.name)}</div>
      <div style="color:#8A6F4D;font-size:11px">${escapeHtml(b.instrument||'')}</div>
    </div>`).join('');
  const body = `<div class="pdf-page">
    <div style="background:#0F213C;margin:-36px -40px 24px;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:4px 4px 0 0">
      <img src="${logoUrl}" alt="" style="height:44px;object-fit:contain">
      <div style="color:#fff;font-family:'Inter',sans-serif;font-size:16px;font-weight:700;flex:1;text-align:center">Call Sheet</div>
      <div style="text-align:right;color:rgba(255,255,255,.7);font-family:'JetBrains Mono',monospace;font-size:10px">${fmtDate(c.date)}</div>
    </div>
    <div class="pdf-eyebrow" style="margin-bottom:2px">${escapeHtml(c.type||'')}</div>
    <div class="pdf-big">${escapeHtml(venue.name||'—')}</div>
    <div class="pdf-text" style="color:#8A6F4D;margin-bottom:16px">${escapeHtml(venue.address||'')}${venue.postnr||venue.city ? ', '+escapeHtml((venue.postnr||'')+' '+(venue.city||'')).trim() : ''}</div>
    <div class="pdf-divider"></div>
    <div class="pdf-grid" style="margin-bottom:14px">
      <div>
        <div class="pdf-eyebrow">Tider</div>
        <table style="margin-top:6px;width:100%;border-collapse:collapse">
          ${c.getIn?`<tr><td style="color:#8A6F4D;font-size:11px;padding:3px 0;width:110px">Get-in</td><td style="font-weight:600;color:#0F213C">${escapeHtml(c.getIn)}</td></tr>`:''}
          ${c.soundcheck?`<tr><td style="color:#8A6F4D;font-size:11px;padding:3px 0">Lydprøve</td><td style="font-weight:600;color:#0F213C">${escapeHtml(c.soundcheck)}</td></tr>`:''}
          ${c.showtimeFrom?`<tr><td style="color:#8A6F4D;font-size:11px;padding:3px 0">Spilletid fra</td><td style="font-weight:600;color:#0F213C">${escapeHtml(c.showtimeFrom)}</td></tr>`:''}
          ${c.showtimeTo?`<tr><td style="color:#8A6F4D;font-size:11px;padding:3px 0">Spilletid til</td><td style="font-weight:600;color:#0F213C">${escapeHtml(c.showtimeTo)}</td></tr>`:''}
          ${c.sets?`<tr><td style="color:#8A6F4D;font-size:11px;padding:3px 0">Sæt</td><td style="font-weight:600;color:#0F213C">${c.sets} × ${c.setMinutes} min</td></tr>`:''}
        </table>
      </div>
      <div>
        <div class="pdf-eyebrow">Din andel</div>
        <div style="font-family:'Instrument Serif',serif;font-size:28px;color:#0F213C;margin-top:4px">${fmtMoney(job.share)}</div>
        <div style="font-size:11px;color:#8A6F4D;margin-top:4px">Status: ${job.status||'—'}</div>
      </div>
    </div>
    <div class="pdf-divider"></div>
    <div class="pdf-eyebrow" style="margin-bottom:6px">Besætning</div>
    ${besaetningHtml || '<div style="color:#8A6F4D;font-size:12px">Ingen registreret endnu</div>'}
    <div class="pdf-foot">__BAND_NAME__ · Udskrevet ${new Date().toLocaleDateString('da-DK')}</div>
  </div>`;
  openPrintWindow(`Call Sheet — ${escapeHtml(venue.name||_b('bandShortName')||'BAND')}`, body);
}

