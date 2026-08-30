// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ─── Wire up ──────────────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('emailInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('passwordInput').focus(); });
document.getElementById('changePwBtn').addEventListener('click', doChangePassword);
document.getElementById('logoutAdmin').addEventListener('click', logout);
document.getElementById('logoutMember').addEventListener('click', logout);
document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
document.querySelectorAll('.sidebar .nav-item[data-route], .mobile-nav .mn-item[data-route]').forEach(item=>{
  item.addEventListener('click', ()=> setAdminRoute(item.getAttribute('data-route')));
});
document.querySelectorAll('#memberApp .mode-pill button').forEach(b=>{
  b.addEventListener('click', ()=> setMemberView(b.getAttribute('data-mview')));
});
// Delegeret, da rider-skabelon-kortet gen-injiceres via innerHTML flere steder i operatør-UI'et.
document.addEventListener('click', e=>{
  const btn = e.target.closest('[data-reset-rider-tpl]');
  if (btn) opResetRiderTemplate(btn.getAttribute('data-reset-rider-tpl'));
});

// ─── Boot: hent band-config og anvend branding FØR vi prøver restore ───
// ════════════════════════════════════════════════════════════════════
// OPERATØR-APP — samlet admin i selve appen (?band=__operator)
// Login → bands-liste → "+ Nyt band" (ét trin) → site-editor pr. band.
// Alle kald gated af operatorToken; band-scoped kald sender bandId i params.
// ════════════════════════════════════════════════════════════════════

let OP_TENANTS = [];

function opSlugify(s){
  return String(s||'').toLowerCase()
    .replace(/æ/g,'ae').replace(/ø/g,'oe').replace(/å/g,'aa')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

function opRoot(){ return document.getElementById('opRoot'); }

function opStart(){
  _applyThemeVars(DEFAULT_THEME);
  // Distinkt operatør-accent så man tydeligt kan se at man er i operatør-mode.
  document.documentElement.style.setProperty('--accent', '#C8A24B');
  document.documentElement.style.setProperty('--accent-soft', '#DBBE7C');
  document.documentElement.style.setProperty('--accent-deep', '#9C7B2E');
  document.title = 'Operatør — Band-app';
  document.body.innerHTML = '<div id="opRoot"></div>';
  // Operatør-session lever i en httpOnly-cookie; spørg Worker'en om den er gyldig.
  fetch('/api/session', { credentials: 'same-origin' })
    .then(r => r.json()).catch(()=>null)
    .then(d => {
      if (d && d.ok && d.role === 'operator'){ OPERATOR_TOKEN = true; opLoadDashboard(); }
      else opRenderLogin();
    });
}

function opRenderLogin(msg){
  opRoot().innerHTML = `
    <div class="login-wrap">
      <div class="card login-card" style="max-width:420px">
        <div class="eyebrow warm" style="text-align:center;margin-bottom:8px">OPERATØR</div>
        <h1 class="serif" style="text-align:center">Log ind</h1>
        <p class="lede" style="text-align:center">Administrér alle bands fra ét sted.</p>
        ${msg ? `<div class="login-err show">${escapeHtml(msg)}</div>` : '<div class="login-err"></div>'}
        <div class="field" style="margin-bottom:14px"><label>Email</label>
          <input id="opEmail" class="input" type="email" autocomplete="username" placeholder="dig@eksempel.dk"></div>
        <div class="field" style="margin-bottom:18px"><label>Adgangskode</label>
          <input id="opPw" class="input" type="password" autocomplete="current-password" placeholder="••••••••"></div>
        <button id="opLoginBtn" class="btn btn-primary btn-lg" style="width:100%;justify-content:center">Log ind</button>
      </div>
    </div>`;
  const go = ()=>opDoLogin();
  document.getElementById('opLoginBtn').onclick = go;
  document.getElementById('opPw').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
  document.getElementById('opEmail').focus();
}

async function opDoLogin(){
  const email = document.getElementById('opEmail').value.trim().toLowerCase();
  const pw = document.getElementById('opPw').value;
  if (!email || !pw){ opRenderLogin('Udfyld email og adgangskode'); return; }
  const btn = document.getElementById('opLoginBtn');
  btn.disabled = true; btn.textContent = 'Logger ind…';
  try {
    const hash = await sha256hex(pw);
    // Worker'en verificerer og gemmer operatør-tokenet server-side; browseren får
    // kun en httpOnly session-cookie. Tokenet findes aldrig i browseren.
    const res = await fetch('/api/operator-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: email, passwordHash: hash })
    });
    const d = await res.json().catch(()=>null);
    if (!d || !d.ok){ opRenderLogin((d && d.error) || 'Login mislykkedes'); return; }
    OPERATOR_TOKEN = true; // sentinel: "logget ind" — den ægte session er cookien
    opLoadDashboard();
  } catch(e){
    opRenderLogin('Netværksfejl: ' + e.message);
  }
}

function opLogout(){
  try { fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(()=>{}); } catch(e){}
  OPERATOR_TOKEN = null;
  opRenderLogin();
}

function opShell(inner){
  return `
    <div style="max-width:880px;margin:0 auto;padding:28px 20px 80px">
      <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:24px">
        <div>
          <div class="eyebrow warm">OPERATØR</div>
          <h1 class="serif" style="margin:2px 0 0">Band-administration</h1>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="opLogout()">Log ud</button>
      </div>
      ${inner}
    </div>`;
}

async function opLoadDashboard(){
  opResetChrome();
  opRoot().innerHTML = opShell('<div class="card"><span class="spinner"></span>Henter bands…</div>');
  try {
    const d = await _apiCall('listTenants', {});
    if (!d || !d.ok){
      if (d && /token/i.test(d.error||'')){ opLogout(); return; }
      opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">${escapeHtml((d&&d.error)||'Kunne ikke hente bands')}</p></div>`);
      return;
    }
    OP_TENANTS = d.tenants || [];
    OP_HEALTH = {}; // frisk sundhedstjek hver gang oversigten åbnes (fanger ændringer fra editoren)
    opRenderDashboard();
  } catch(e){
    opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</p></div>`);
  }
}

// Lille statusfarvet "chip" til sundhedstjek-badges.
function opChip(text, kind){
  const base = 'display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;margin:0 5px 4px 0;border:1px solid ';
  const styles = {
    ok:      'border-color:rgba(120,180,120,.45);color:#8FCE8F;background:rgba(120,180,120,.08)',
    miss:    'border-color:rgba(217,122,108,.5);color:var(--danger);background:rgba(217,122,108,.1)',
    neutral: 'border-color:var(--ink-line-soft);color:var(--cream-mute)'
  };
  return `<span style="${base}${styles[kind]||styles.neutral}">${escapeHtml(text)}</span>`;
}

function opStatusPill(status){
  if (status === 'suspended'){
    return '<span style="font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid rgba(217,122,108,.5);color:var(--danger);background:rgba(217,122,108,.1)">På pause</span>';
  }
  return '<span style="font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid rgba(120,180,120,.45);color:#8FCE8F;background:rgba(120,180,120,.08)">Aktiv</span>';
}

// Health-cache pr. band (#4/#5/#10) og dashboardets visningstilstand (#5).
let OP_HEALTH = {};
let OP_VIEW = { q: '', filter: 'all', sort: 'name' };

function opRenderDashboard(){
  opRoot().innerHTML = opShell(`
    <div style="margin-bottom:16px">
      <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 class="serif" style="margin:0;font-size:18px">Dine bands (${OP_TENANTS.length})</h2>
        <div class="flex" style="gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="opOpenBookers()">Bookere</button>
          <button class="btn btn-ghost btn-sm" onclick="opOpenAudit()">Audit-log</button>
          <button class="btn btn-ghost btn-sm" onclick="opRunRetention()">Kør log-oprydning</button>
          <button class="btn btn-primary btn-sm" onclick="opRenderNewBand()">+ Nyt band</button>
        </div>
      </div>
      <div id="opSummary" style="margin-bottom:14px"></div>
      ${OP_TENANTS.length ? `
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:160px;margin:0"><label style="font-size:11px">Søg</label>
          <input id="opSearch" class="input" placeholder="navn eller id" value="${escapeHtml(OP_VIEW.q)}" oninput="opSetView('q',this.value)"></div>
        <div class="field" style="margin:0"><label style="font-size:11px">Filter</label>
          <select class="select" onchange="opSetView('filter',this.value)">
            ${[['all','Alle'],['active','Aktive'],['suspended','På pause'],['missing','Mangler opsætning']].map(o=>`<option value="${o[0]}" ${OP_VIEW.filter===o[0]?'selected':''}>${o[1]}</option>`).join('')}
          </select></div>
        <div class="field" style="margin:0"><label style="font-size:11px">Sortér</label>
          <select class="select" onchange="opSetView('sort',this.value)">
            ${[['name','Navn'],['status','Status'],['nextgig','Næste gig'],['gigs','Flest gigs']].map(o=>`<option value="${o[0]}" ${OP_VIEW.sort===o[0]?'selected':''}>${o[1]}</option>`).join('')}
          </select></div>
      </div>` : ''}
      <div id="opBandList"></div>
    </div>`);
  opRenderBandList();
  opUpdateSummary();
  opLoadHealth();
}

function opSetView(key, val){
  OP_VIEW[key] = val;
  opRenderBandList();
}

// Afgør om et band mangler opsætning eller har integritets-advarsler (#10).
function opMissingSetup(h){
  if (!h || h._error) return false;
  const w = h.warnings || {};
  return !h.hasLogo || !h.hasRider || !h.hasBank || !h.hasCpr ||
         w.noAdmin || (w.orphanAttendances|0) > 0 || (w.overdueInvoices|0) > 0;
}

function opRenderBandList(){
  const el = document.getElementById('opBandList');
  if (!el) return;
  if (!OP_TENANTS.length){ el.innerHTML = '<p style="color:var(--cream-mute)">Ingen bands endnu. Opret det første herunder.</p>'; return; }
  const q = OP_VIEW.q.trim().toLowerCase();
  let list = OP_TENANTS.filter(t => {
    if (q && (t.name||'').toLowerCase().indexOf(q) === -1 && t.bandId.toLowerCase().indexOf(q) === -1) return false;
    if (OP_VIEW.filter === 'active' && t.status === 'suspended') return false;
    if (OP_VIEW.filter === 'suspended' && t.status !== 'suspended') return false;
    if (OP_VIEW.filter === 'missing' && !opMissingSetup(OP_HEALTH[t.bandId])) return false;
    return true;
  });
  const nextTs = id => { const h = OP_HEALTH[id]; return (h && h.nextGig) ? new Date(h.nextGig).getTime() : Infinity; };
  const gigs = id => { const h = OP_HEALTH[id]; return (h && h.upcomingGigs) || 0; };
  list = list.slice().sort((a,b) => {
    if (OP_VIEW.sort === 'status') return (a.status==='suspended'?0:1) - (b.status==='suspended'?0:1) || (a.name||a.bandId).localeCompare(b.name||b.bandId);
    if (OP_VIEW.sort === 'nextgig') return nextTs(a.bandId) - nextTs(b.bandId);
    if (OP_VIEW.sort === 'gigs') return gigs(b.bandId) - gigs(a.bandId);
    return (a.name||a.bandId).localeCompare(b.name||b.bandId);
  });
  if (!list.length){ el.innerHTML = '<p style="color:var(--cream-mute)">Ingen bands matcher filteret.</p>'; return; }
  el.innerHTML = list.map(t => {
    const id = escapeHtml(t.bandId);
    const suspended = t.status === 'suspended';
    const cached = OP_HEALTH[t.bandId];
    const healthInner = cached
      ? opHealthBadges(cached)
      : '<span class="spinner" style="width:12px;height:12px"></span> Henter status…';
    return `
    <div class="card" style="margin-bottom:10px;padding:14px 16px">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <div class="flex" style="align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:15px">${escapeHtml(t.name||t.bandId)}</strong>
            <span class="mono" style="color:var(--cream-mute);font-size:11px">${id}</span>
            ${opStatusPill(t.status)}
            ${t.crossBand ? opChip('På tværs ✓', 'ok') : ''}
            ${t.booking ? opChip('Booking ✓', 'ok') : ''}
          </div>
          <div id="health-${id}" style="margin-top:9px;font-size:12px;color:var(--cream-mute)">${healthInner}</div>
        </div>
        <div class="flex" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="opOpenEditor('${id}')">Rediger</button>
          <button class="btn btn-text btn-sm" onclick="opRenderRename('${id}')">Omdøb</button>
          <button class="btn btn-text btn-sm" onclick="opToggleCrossBand('${id}',${t.crossBand?'false':'true'})" title="Betalt feature: musikere kan se jobs og honorar på tværs af bands">${t.crossBand?'Slå tværgående fra':'Slå tværgående til'}</button>
          <button class="btn btn-text btn-sm" onclick="opToggleBooking('${id}',${t.booking?'false':'true'})" title="Booking & e-signatur: bandet kan sende kontrakter til elektronisk underskrift">${t.booking?'Slå booking fra':'Slå booking til'}</button>
          <button class="btn btn-text btn-sm" onclick="opToggleStatus('${id}','${suspended?'active':'suspended'}')">${suspended?'Genaktivér':'Sæt på pause'}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Aggregeret topbanner (#4) — opdateres løbende mens health-kald lander.
function opUpdateSummary(){
  const el = document.getElementById('opSummary');
  if (!el) return;
  const loaded = OP_TENANTS.filter(t => OP_HEALTH[t.bandId] && !OP_HEALTH[t.bandId]._error);
  let members = 0, missing = 0;
  loaded.forEach(t => { const h = OP_HEALTH[t.bandId]; members += h.members||0; if (opMissingSetup(h)) missing++; });
  const paused = OP_TENANTS.filter(t => t.status === 'suspended').length;
  const pending = OP_TENANTS.length - loaded.length;
  el.innerHTML = `<div class="card" style="padding:12px 16px">
    ${opChip(OP_TENANTS.length + ' bands', 'neutral')}
    ${opChip(members + ' medlemmer', 'neutral')}
    ${paused ? opChip(paused + ' på pause', 'miss') : ''}
    ${missing ? opChip(missing + ' mangler opsætning', 'miss') : (pending ? '' : opChip('Alt opsat ✓', 'ok'))}
    ${pending ? `<span style="font-size:11px;color:var(--cream-mute)">henter ${pending}…</span>` : ''}
  </div>`;
}

// Sundhedstjek hentes pr. band PARALLELT (kun bands der ikke allerede er i cachen).
// Hvert svar opdaterer rækken in-place; når alle er hjemme, gen-renderes listen så
// health-afhængig sortering/filtrering slår igennem.
function opLoadHealth(){
  const pending = OP_TENANTS.filter(t => !OP_HEALTH[t.bandId]);
  Promise.all(pending.map(t =>
    _apiCall('bandHealth', { bandId: t.bandId }).then(d => {
      OP_HEALTH[t.bandId] = (d && d.ok && d.health) ? d.health : { _error: true };
    }).catch(()=>{ OP_HEALTH[t.bandId] = { _error: true }; }).then(()=>{
      const el = document.getElementById('health-' + t.bandId);
      if (el) el.innerHTML = opHealthBadges(OP_HEALTH[t.bandId]);
      opUpdateSummary();
    })
  )).then(()=>{ opRenderBandList(); opUpdateSummary(); });
}

function opHealthBadges(h){
  if (!h || h._error) return '<span style="color:var(--danger)">Kunne ikke hente status</span>';
  let out = opChip(h.members + ' medlem' + (h.members===1?'':'mer'), 'neutral');
  if (h.nextGig){
    const d = new Date(h.nextGig);
    if (!isNaN(d.getTime())) out += opChip('Næste: ' + d.toLocaleDateString('da-DK',{day:'numeric',month:'short',year:'numeric'}), 'neutral');
  }
  [['hasLogo','Logo'],['hasRider','Rider'],['hasBank','Bank'],['hasCpr','CPR']].forEach(c => {
    out += h[c[0]] ? opChip(c[1] + ' ✓', 'ok') : opChip(c[1] + ' mangler', 'miss');
  });
  const w = h.warnings || {};
  if (w.noAdmin) out += opChip('Ingen admin', 'miss');
  if ((w.orphanAttendances|0) > 0) out += opChip(w.orphanAttendances + ' forældreløse deltagelser', 'miss');
  if ((w.overdueInvoices|0) > 0) out += opChip(w.overdueInvoices + ' forfaldne fakturaer', 'miss');
  return out;
}

async function opRunRetention(){
  if (!confirm('Kør log-oprydning nu?\n\nSletter login-log-rækker der er ældre end hvert bands opbevaringspolitik (retentionLoginLogMonths). Bands uden politik røres ikke.')) return;
  try {
    const d = await _apiCall('runRetentionNow', {});
    if (d && d.ok){
      const total = (d.summary||[]).reduce((s,x)=>s+(x.deleted||0),0);
      toast(total ? ('Oprydning kørt — slettede ' + total + ' rækker') : 'Oprydning kørt — intet at slette');
    } else toast((d&&d.error)||'Kunne ikke køre oprydning', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

async function opToggleStatus(bandId, newStatus){
  if (newStatus === 'suspended' &&
      !confirm('Sæt "' + bandId + '" på pause?\n\nMedlemmer kan ikke logge ind før du genaktiverer. Ingen data slettes.')) return;
  try {
    const d = await _apiCall('setTenantStatus', { targetBandId: bandId, status: newStatus });
    if (d && d.ok){
      const t = OP_TENANTS.find(x => x.bandId === bandId); if (t) t.status = newStatus;
      toast(newStatus === 'suspended' ? 'Band sat på pause' : 'Band genaktiveret');
      opRenderDashboard();
    } else toast((d&&d.error)||'Kunne ikke ændre status', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

async function opToggleCrossBand(bandId, enable){
  const on = (enable === true || enable === 'true');
  if (on && !confirm('Slå tværgående jobs/honorar TIL for "' + bandId + '"?\n\nDette er en betalt feature. Bandets musikere kan herefter se deres jobs og honorar samlet på tværs af de bands (med featuren slået til) de spiller i.')) return;
  try {
    const d = await _apiCall('updateTenant', { targetBandId: bandId, crossBand: on });
    if (d && d.ok){
      const t = OP_TENANTS.find(x => x.bandId === bandId); if (t) t.crossBand = on;
      toast(on ? 'Tværgående slået til' : 'Tværgående slået fra');
      opRenderBandList();
    } else toast((d&&d.error)||'Kunne ikke ændre feature', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

// Slår Fase A-e-signaturflowet til/fra for bandet. Håndhæves server-side i hver
// booking-action (_bookingEnabled), så en slukning midt i et forløb med det samme
// gør udestående signeringslinks ugyldige — ikke kun et UI-skjul.
async function opToggleBooking(bandId, enable){
  const on = (enable === true || enable === 'true');
  if (on && !confirm('Slå booking & e-signatur TIL for "' + bandId + '"?\n\nBandet kan herefter sende kontrakter til elektronisk underskrift hos arrangøren.')) return;
  if (!on && !confirm('Slå booking & e-signatur FRA for "' + bandId + '"?\n\nUdestående signeringslinks holder op med at virke med det samme.')) return;
  try {
    const d = await _apiCall('updateTenant', { targetBandId: bandId, booking: on });
    if (d && d.ok){
      const t = OP_TENANTS.find(x => x.bandId === bandId); if (t) t.booking = on;
      toast(on ? 'Booking slået til' : 'Booking slået fra');
      opRenderBandList();
    } else toast((d&&d.error)||'Kunne ikke ændre feature', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

function opRenderRename(bandId){
  const t = OP_TENANTS.find(x => x.bandId === bandId) || { bandId: bandId };
  opRoot().innerHTML = opShell(`
    <div class="card" style="max-width:520px">
      <button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Tilbage</button>
      <h2 class="serif" style="margin:0 0 4px;font-size:18px">Omdøb band</h2>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 16px">Ændrer det viste bandnavn (samt bandets titel og login-skærm). Band-id'et <span class="mono">${escapeHtml(bandId)}</span> i URL'en kan ikke ændres.</p>
      <div class="login-err" id="opRenameErr"></div>
      <div class="field" style="margin-bottom:16px"><label>Nyt bandnavn</label>
        <input id="opRenameName" class="input" value="${escapeHtml(t.name||'')}"></div>
      <button id="opRenameBtn" class="btn btn-primary">Gem nyt navn</button>
    </div>`);
  document.getElementById('opRenameBtn').onclick = ()=> opDoRename(bandId);
  const inp = document.getElementById('opRenameName');
  inp.focus();
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') opDoRename(bandId); });
}

async function opDoRename(bandId){
  const name = document.getElementById('opRenameName').value.trim();
  const err = document.getElementById('opRenameErr');
  const fail = m => { err.textContent = m; err.classList.add('show'); };
  if (!name){ fail('Udfyld bandnavn'); return; }
  const btn = document.getElementById('opRenameBtn'); btn.disabled = true; btn.textContent = 'Gemmer…';
  try {
    const d = await _apiCall('updateTenant', { targetBandId: bandId, bandName: name });
    if (d && d.ok){
      const t = OP_TENANTS.find(x => x.bandId === bandId); if (t) t.name = name;
      toast('Bandnavn opdateret'); opLoadDashboard();
    } else { btn.disabled = false; btn.textContent = 'Gem nyt navn'; fail((d&&d.error)||'Kunne ikke omdøbe'); }
  } catch(e){ btn.disabled = false; btn.textContent = 'Gem nyt navn'; fail('Netværksfejl: '+e.message); }
}

async function opOpenAudit(){
  opResetChrome();
  opRoot().innerHTML = opShell('<div class="card"><span class="spinner"></span>Henter audit-log…</div>');
  try {
    const d = await _apiCall('getAuditLog', {});
    if (!d || !d.ok){
      if (d && /token/i.test(d.error||'')){ opLogout(); return; }
      opRoot().innerHTML = opShell(`<div class="card"><button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Tilbage</button><p style="color:var(--danger)">${escapeHtml((d&&d.error)||'Kunne ikke hente log')}</p></div>`);
      return;
    }
    opRenderAudit(d.entries || []);
  } catch(e){
    opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</p></div>`);
  }
}

let OP_AUDIT = [];        // alle hentede entries
let OP_AUDIT_VIEW = { q: '', band: '' };

function opRenderAudit(entries){
  OP_AUDIT = entries || [];
  OP_AUDIT_VIEW = { q: '', band: '' };
  const bands = Array.from(new Set(OP_AUDIT.map(e => e.bandId).filter(Boolean))).sort();
  opRoot().innerHTML = opShell(`
    <button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Alle bands</button>
    <div class="card">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:4px">
        <h2 class="serif" style="margin:0;font-size:18px">Audit-log</h2>
        <button class="btn btn-ghost btn-sm" onclick="opExportAuditCsv()">Download CSV</button>
      </div>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 14px">Seneste ${OP_AUDIT.length} operatør-handlinger (nyeste først). Fuld historik ligger i <span class="mono">Band-app – Audit-log</span>-arket i din Drive.</p>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:160px;margin:0"><label style="font-size:11px">Søg</label>
          <input id="opAuditSearch" class="input" placeholder="person, handling, detalje…" oninput="opAuditSetView('q',this.value)"></div>
        <div class="field" style="margin:0"><label style="font-size:11px">Band</label>
          <select class="select" onchange="opAuditSetView('band',this.value)">
            <option value="">Alle bands</option>
            ${bands.map(b=>`<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
          </select></div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:560px">
          <thead><tr style="text-align:left;color:var(--cream-mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em">
            <th style="padding:0 10px 6px">Tidspunkt</th><th style="padding:0 10px 6px">Hvem</th><th style="padding:0 10px 6px">Handling</th><th style="padding:0 10px 6px">Band</th><th style="padding:0 10px 6px">Detalje</th>
          </tr></thead>
          <tbody id="opAuditRows"></tbody>
        </table>
      </div>
    </div>`);
  opRenderAuditRows();
}

function opAuditFiltered(){
  const q = OP_AUDIT_VIEW.q.trim().toLowerCase();
  return OP_AUDIT.filter(e => {
    if (OP_AUDIT_VIEW.band && e.bandId !== OP_AUDIT_VIEW.band) return false;
    if (q && [e.actor,e.action,e.bandId,e.detail].join(' ').toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}

function opAuditSetView(key, val){ OP_AUDIT_VIEW[key] = val; opRenderAuditRows(); }

function opRenderAuditRows(){
  const tbody = document.getElementById('opAuditRows');
  if (!tbody) return;
  const list = opAuditFiltered();
  tbody.innerHTML = list.length ? list.map(e => {
    const d = new Date(e.ts);
    const when = isNaN(d.getTime()) ? escapeHtml(e.ts) : d.toLocaleString('da-DK');
    return `<tr style="border-top:1px solid var(--ink-line-soft)">
      <td style="padding:7px 10px;white-space:nowrap;color:var(--cream-mute);font-size:12px">${when}</td>
      <td style="padding:7px 10px;font-size:12px">${escapeHtml(e.actor)}</td>
      <td style="padding:7px 10px;font-size:12px"><span class="mono">${escapeHtml(e.action)}</span></td>
      <td style="padding:7px 10px;font-size:12px;color:var(--cream-mute)">${escapeHtml(e.bandId)}</td>
      <td style="padding:7px 10px;font-size:12px;color:var(--cream-mute)">${escapeHtml(e.detail)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" style="padding:14px;color:var(--cream-mute)">Ingen handlinger matcher.</td></tr>';
}

function opExportAuditCsv(){
  const list = opAuditFiltered();
  const esc = v => '"' + String(v==null?'':v).replace(/"/g,'""') + '"';
  const header = ['timestamp','actor','action','bandId','detail'];
  const lines = [header.join(',')].concat(list.map(e => [e.ts,e.actor,e.action,e.bandId,e.detail].map(esc).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audit-log.csv';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ─── Operatør: booker-administration (Booking Fase B) ───────────────────────
// En booker er en ekstern booking-agent med eget login (?band=__booker).
// Operatøren opretter kontoen, tildeler adgang til bands via checkbokse (samme
// mønster som crossBand/booking-toggles), og er den ENESTE vej til at sætte/
// nulstille bookerens password i v1 — der findes ingen selvbetjenings-vej.

let OP_BOOKERS = [];

async function opOpenBookers(){
  opResetChrome();
  opRoot().innerHTML = opShell('<div class="card"><span class="spinner"></span>Henter bookere…</div>');
  try {
    const [bookersRes, tenantsRes] = await Promise.all([
      _apiCall('operatorListBookers', {}),
      OP_TENANTS.length ? Promise.resolve({ ok: true, tenants: OP_TENANTS }) : _apiCall('listTenants', {})
    ]);
    if (!bookersRes || !bookersRes.ok){
      if (bookersRes && /token/i.test(bookersRes.error||'')){ opLogout(); return; }
      opRoot().innerHTML = opShell(`<div class="card"><button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Tilbage</button><p style="color:var(--danger)">${escapeHtml((bookersRes&&bookersRes.error)||'Kunne ikke hente bookere')}</p></div>`);
      return;
    }
    if (tenantsRes && tenantsRes.ok) OP_TENANTS = tenantsRes.tenants || OP_TENANTS;
    OP_BOOKERS = bookersRes.bookers || [];
    opRenderBookers();
  } catch(e){
    opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</p></div>`);
  }
}

function opRenderBookers(){
  opRoot().innerHTML = opShell(`
    <button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Alle bands</button>
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:14px">
      <h2 class="serif" style="margin:0;font-size:18px">Bookere (${OP_BOOKERS.length})</h2>
      <button class="btn btn-primary btn-sm" onclick="opRenderBookerForm()">+ Ny booker</button>
    </div>
    <div id="opBookerList">${opBookerListHtml()}</div>`);
}

function opBookerListHtml(){
  if (!OP_BOOKERS.length) return '<p style="color:var(--cream-mute)">Ingen bookere endnu.</p>';
  return OP_BOOKERS.map(b => {
    const suspended = b.status === 'suspended';
    const bandNames = (b.bandIds||[]).map(id => { const t = OP_TENANTS.find(x=>x.bandId===id); return t ? (t.name||t.bandId) : id; });
    return `
    <div class="card" style="margin-bottom:10px;padding:14px 16px">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <div class="flex" style="align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:15px">${escapeHtml(b.name || b.email)}</strong>
            ${b.agency ? `<span style="color:var(--cream-mute);font-size:12px">${escapeHtml(b.agency)}</span>` : ''}
            ${suspended ? opChip('Suspenderet', 'miss') : opChip('Aktiv', 'ok')}
          </div>
          <div style="font-size:12px;color:var(--cream-mute);margin-top:4px">${escapeHtml(b.email)}</div>
          <div style="font-size:12px;color:var(--cream-mute);margin-top:6px">${bandNames.length ? 'Adgang: ' + bandNames.map(escapeHtml).join(', ') : 'Ingen bands tildelt endnu'}</div>
        </div>
        <div class="flex" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="opCopyBookerLoginLink()">Kopiér login-link</button>
          <button class="btn btn-ghost btn-sm" onclick="opRenderBookerForm('${escapeHtml(b.email)}')">Rediger</button>
          <button class="btn btn-text btn-sm" onclick="opResetBookerPw('${escapeHtml(b.email)}')">Nulstil kode</button>
          <button class="btn btn-text btn-sm" onclick="opDeleteBooker('${escapeHtml(b.email)}')">Slet</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function opCopyBookerLoginLink(){
  const url = location.origin + location.pathname + '?band=__booker';
  if (navigator.clipboard) navigator.clipboard.writeText(url);
  toast('Booker-login-link kopieret');
}

function opRenderBookerForm(email){
  const existing = email ? OP_BOOKERS.find(b => b.email === email) : null;
  const isNew = !existing;
  opRoot().innerHTML = opShell(`
    <button class="btn btn-text btn-sm" onclick="opOpenBookers()" style="margin-bottom:8px">← Bookere</button>
    <div class="card" style="max-width:620px">
      <h2 class="serif" style="margin:0 0 4px;font-size:18px">${isNew ? 'Ny booker' : 'Rediger booker'}</h2>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 16px">${isNew ? 'Der genereres en midlertidig adgangskode, som vises én gang herefter — send den til bookeren ad sikker vej.' : 'Bandadgang og status kan ændres. E-mail kan ikke ændres.'}</p>
      <div class="login-err" id="opBookerErr"></div>
      <div class="field" style="margin-bottom:14px"><label>E-mail</label>
        <input id="opBkEmail" class="input" type="email" ${isNew?'':'disabled'} value="${escapeHtml((existing&&existing.email)||'')}" placeholder="booker@agency.dk"></div>
      <div class="field" style="margin-bottom:14px"><label>Navn</label>
        <input id="opBkName" class="input" value="${escapeHtml((existing&&existing.name)||'')}" placeholder="Fx Anna Booking"></div>
      <div class="field" style="margin-bottom:14px"><label>Agency</label>
        <input id="opBkAgency" class="input" value="${escapeHtml((existing&&existing.agency)||'')}" placeholder="Fx Nordic Booking ApS"></div>
      ${!isNew ? `
      <div class="field" style="margin-bottom:14px"><label>Status</label>
        <select id="opBkStatus" class="select">
          <option value="active" ${existing.status!=='suspended'?'selected':''}>Aktiv</option>
          <option value="suspended" ${existing.status==='suspended'?'selected':''}>Suspenderet</option>
        </select></div>` : ''}
      <div class="field" style="margin-bottom:18px"><label>Adgang til bands</label>
        <div style="max-height:220px;overflow-y:auto;border:1px solid var(--ink-line-soft);border-radius:var(--radius);padding:8px">
          ${OP_TENANTS.length ? OP_TENANTS.map(t => `
            <label class="flex" style="gap:8px;align-items:center;padding:4px 2px;cursor:pointer;font-size:13px">
              <input type="checkbox" class="opBkBand" value="${escapeHtml(t.bandId)}" style="width:auto;flex:none" ${(existing&&existing.bandIds||[]).indexOf(t.bandId)!==-1?'checked':''}>
              ${escapeHtml(t.name||t.bandId)} ${!t.booking ? '<span style="color:var(--cream-mute);font-size:11px">(booking er slået fra)</span>' : ''}
            </label>`).join('') : '<span style="color:var(--cream-mute);font-size:12px">Ingen bands oprettet endnu</span>'}
        </div>
        <span style="font-size:11px;color:var(--cream-mute)">Kun bands med booking slået til kan reelt bruges, selvom du tildeler adgang her.</span></div>
      <button id="opBkSaveBtn" class="btn btn-primary btn-lg" style="width:100%;justify-content:center">${isNew ? 'Opret booker' : 'Gem ændringer'}</button>
    </div>`);
  document.getElementById('opBkSaveBtn').onclick = () => opSaveBooker(isNew, existing);
}

async function opSaveBooker(isNew, existing){
  const email = document.getElementById('opBkEmail').value.trim().toLowerCase();
  const name = document.getElementById('opBkName').value.trim();
  const agency = document.getElementById('opBkAgency').value.trim();
  const statusEl = document.getElementById('opBkStatus');
  const bandIds = Array.from(document.querySelectorAll('.opBkBand:checked')).map(el => el.value);
  const err = document.getElementById('opBookerErr');
  const fail = m => { err.textContent = m; err.classList.add('show'); };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ fail('Udfyld en gyldig e-mail'); return; }
  const btn = document.getElementById('opBkSaveBtn');
  btn.disabled = true; btn.textContent = 'Gemmer…';
  try {
    const payload = { email: email, name: name, agency: agency, bandIds: bandIds };
    if (statusEl) payload.status = statusEl.value;
    const d = await _apiCall('operatorSaveBooker', payload);
    if (!d || !d.ok){ btn.disabled=false; btn.textContent = isNew?'Opret booker':'Gem ændringer'; fail((d&&d.error)||'Kunne ikke gemme'); return; }
    if (d.tempPassword){
      opRoot().innerHTML = opShell(`
        <div class="card" style="max-width:520px">
          <div class="eyebrow warm">OPRETTET ✓</div>
          <h2 class="serif" style="margin:2px 0 16px;font-size:20px">${escapeHtml(name||email)}</h2>
          <p style="color:var(--cream-mute);font-size:13px;margin:0 0 6px">Login: <strong>${escapeHtml(email)}</strong></p>
          <p style="color:var(--cream-mute);font-size:13px;margin:0 0 6px">Login-side: <span class="mono">${escapeHtml(location.origin + location.pathname + '?band=__booker')}</span></p>
          <p style="color:var(--cream-mute);font-size:13px;margin:0 0 18px">Midlertidig adgangskode: <strong class="mono">${escapeHtml(d.tempPassword)}</strong> — send den sikkert til bookeren, den vises ikke igen.</p>
          <div class="flex" style="gap:8px">
            <button class="btn btn-ghost" onclick="opCopyBookerLoginLink()">Kopiér login-link</button>
            <button class="btn btn-primary" onclick="opOpenBookers()">Til bookere</button>
          </div>
        </div>`);
      return;
    }
    toast('Booker gemt');
    opOpenBookers();
  } catch(e){ btn.disabled=false; btn.textContent = isNew?'Opret booker':'Gem ændringer'; fail('Netværksfejl: '+e.message); }
}

async function opResetBookerPw(email){
  if (!confirm('Nulstil adgangskode for "' + email + '"?\n\nEn ny midlertidig kode genereres, og den nuværende session (og alle udestående) udløber med det samme.')) return;
  try {
    const d = await _apiCall('operatorResetBookerPassword', { email: email });
    if (d && d.ok){
      opRoot().innerHTML = opShell(`
        <div class="card" style="max-width:480px">
          <h2 class="serif" style="margin:0 0 12px;font-size:18px">Kode nulstillet</h2>
          <p style="color:var(--cream-mute);font-size:13px;margin:0 0 18px">Ny midlertidig adgangskode for <strong>${escapeHtml(email)}</strong>: <strong class="mono">${escapeHtml(d.tempPassword)}</strong> — send den sikkert, den vises ikke igen.</p>
          <button class="btn btn-primary" onclick="opOpenBookers()">Til bookere</button>
        </div>`);
    } else toast((d&&d.error)||'Kunne ikke nulstille', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

async function opDeleteBooker(email){
  if (!confirm('Slet booker "' + email + '" permanent?\n\nBookerens login stopper med at virke med det samme. Allerede sendte/underskrevne tilbud i bandenes egne Sheets berøres ikke.')) return;
  try {
    const d = await _apiCall('operatorDeleteBooker', { email: email });
    if (d && d.ok){ toast('Booker slettet'); opOpenBookers(); }
    else toast((d&&d.error)||'Kunne ikke slette', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

function opRenderNewBand(){
  opRoot().innerHTML = opShell(`
    <div class="card" style="max-width:560px">
      <button class="btn btn-text btn-sm" onclick="opRenderDashboard()" style="margin-bottom:8px">← Tilbage</button>
      <h2 class="serif" style="margin:0 0 4px;font-size:18px">Nyt band</h2>
      <p style="color:var(--cream-mute);font-size:13px;margin:0 0 18px">Du udfylder kun navn + admin-email. Sheet'et oprettes automatisk.</p>
      <div class="login-err" id="opNewErr"></div>
      <div class="field" style="margin-bottom:14px"><label>Bandnavn</label>
        <input id="opNewName" class="input" placeholder="Fx DM i Dansk Top"></div>
      <div class="field" style="margin-bottom:14px"><label>Band-id (auto)</label>
        <input id="opNewId" class="input mono" placeholder="dm-i-dansk-top">
        <span style="font-size:11px;color:var(--cream-mute)">Kun a-z, 0-9 og bindestreg. Bruges i login-URL'en.</span></div>
      <div class="field" style="margin-bottom:14px"><label>Admin-email</label>
        <input id="opNewEmail" class="input" type="email" placeholder="admin@band.dk"></div>
      <div class="field" style="margin-bottom:18px"><label>Admin-navn</label>
        <input id="opNewAdminName" class="input" placeholder="Fx Jonas Holm"></div>
      <div class="field" style="margin-bottom:18px"><label>Kopiér udseende fra (skabelon)</label>
        <select id="opNewTemplate" class="select">
          <option value="">Ingen — start fra standard</option>
          ${OP_TENANTS.map(t => `<option value="${escapeHtml(t.bandId)}">${escapeHtml(t.name||t.bandId)}</option>`).join('')}
        </select>
        <span style="font-size:11px;color:var(--cream-mute)">Kopierer tema, farver, fonte og rider-tekst. Kontaktinfo, bank, CPR og logo kopieres ikke.</span></div>
      <label class="flex" style="gap:8px;align-items:center;margin-bottom:18px;cursor:pointer;font-size:13px">
        <input id="opNewSendEmail" type="checkbox" checked style="width:auto;flex:none">
        Send velkomst-email til admin (login-URL + midlertidig kode)</label>
      <button id="opCreateBtn" class="btn btn-primary btn-lg" style="width:100%;justify-content:center">Opret band</button>
    </div>`);
  const nameEl = document.getElementById('opNewName');
  const idEl = document.getElementById('opNewId');
  let idEdited = false;
  idEl.addEventListener('input', ()=>{ idEdited = true; });
  nameEl.addEventListener('input', ()=>{ if(!idEdited) idEl.value = opSlugify(nameEl.value); });
  document.getElementById('opCreateBtn').onclick = opCreateBand;
  nameEl.focus();
}

async function opCreateBand(){
  const name = document.getElementById('opNewName').value.trim();
  const bandId = opSlugify(document.getElementById('opNewId').value.trim());
  const email = document.getElementById('opNewEmail').value.trim().toLowerCase();
  const adminName = document.getElementById('opNewAdminName').value.trim();
  const err = document.getElementById('opNewErr');
  const fail = m => { err.textContent = m; err.classList.add('show'); };
  if (!name){ fail('Udfyld bandnavn'); return; }
  if (!bandId || !/^[a-z0-9-]+$/.test(bandId)){ fail('Ugyldigt band-id'); return; }
  if (!email){ fail('Udfyld admin-email'); return; }
  const btn = document.getElementById('opCreateBtn');
  btn.disabled = true; btn.textContent = 'Opretter…';
  const url = location.origin + location.pathname + '?band=' + encodeURIComponent(bandId);
  try {
    const tplEl = document.getElementById('opNewTemplate');
    const templateBandId = tplEl ? tplEl.value : '';
    const sendEmailEl = document.getElementById('opNewSendEmail');
    const sendOnboardingEmail = sendEmailEl ? sendEmailEl.checked : false;
    const d = await _apiCall('registerTenant', {
      newBandId: bandId, bandName: name,
      adminEmail: email, adminName: adminName || name,
      templateBandId: templateBandId,
      sendOnboardingEmail: sendOnboardingEmail, loginUrl: url
    });
    if (!d || !d.ok){ btn.disabled=false; btn.textContent='Opret band'; fail((d&&d.error)||'Kunne ikke oprette band'); return; }
    opRoot().innerHTML = opShell(`
      <div class="card" style="max-width:560px">
        <div class="eyebrow warm">OPRETTET ✓</div>
        <h2 class="serif" style="margin:2px 0 16px;font-size:20px">${escapeHtml(name)}</h2>
        <p style="color:var(--cream-mute);font-size:13px;margin:0 0 6px">Login-URL til bandet:</p>
        <div class="input mono" style="word-break:break-all;margin-bottom:14px">${escapeHtml(url)}</div>
        <p style="color:var(--cream-mute);font-size:13px;margin:0 0 6px">Admin: <strong>${escapeHtml(email)}</strong></p>
        <p style="color:var(--cream-mute);font-size:13px;margin:0 0 18px">Midlertidig adgangskode: <strong class="mono">${escapeHtml(d.seedPassword)}</strong> (tvinges skiftet ved første login)</p>
        <p style="font-size:12px;margin:0 0 18px;color:${d.emailSent?'#8FCE8F':'var(--cream-mute)'}">${d.emailSent ? '✓ Velkomst-email sendt til admin' : 'Ingen email sendt — del login-URL og kode manuelt'}</p>
        <div class="flex" style="gap:8px">
          <button id="opCopyUrlBtn" class="btn btn-primary">Kopiér URL</button>
          <button id="opOpenEditorBtn" class="btn btn-ghost">Tilpas udseende →</button>
          <button class="btn btn-text" onclick="opLoadDashboard()">Til oversigt</button>
        </div>
      </div>`);
    document.getElementById('opCopyUrlBtn').onclick = ()=>{ navigator.clipboard && navigator.clipboard.writeText(url); toast('Login-URL kopieret'); };
    document.getElementById('opOpenEditorBtn').onclick = ()=> opOpenEditor(bandId);
  } catch(e){
    btn.disabled=false; btn.textContent='Opret band'; fail('Netværksfejl: ' + e.message);
  }
}

let OP_CFG = null; // config for band der redigeres
async function opOpenEditor(bandId){
  opRoot().innerHTML = opShell('<div class="card"><span class="spinner"></span>Henter konfiguration…</div>');
  try {
    const d = await _apiCall('adminReadConfig', { bandId: bandId });
    if (!d || !d.ok){ opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">${escapeHtml((d&&d.error)||'Fejl')}</p></div>`); return; }
    OP_CFG = Object.assign({ _bandId: bandId }, d.config || {});
    opRenderEditor();
  } catch(e){
    opRoot().innerHTML = opShell(`<div class="card"><p style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</p></div>`);
  }
}

function opField(label, key, type, ph){
  const v = OP_CFG[key] == null ? '' : OP_CFG[key];
  return `<div class="field" style="margin-bottom:12px"><label>${label}</label>
    <input class="input" data-cfg="${key}" type="${type||'text'}" value="${escapeHtml(String(v))}" placeholder="${escapeHtml(ph||'')}"></div>`;
}

function opRenderEditor(){
  const c = OP_CFG;
  const themes = Object.keys(THEMES);
  opRoot().innerHTML = opShell(`
    <button class="btn btn-text btn-sm" onclick="opLoadDashboard()" style="margin-bottom:8px">← Alle bands</button>
    <div class="flex" style="justify-content:space-between;align-items:baseline;margin-bottom:18px">
      <h2 class="serif" style="margin:0;font-size:20px">${escapeHtml(c.bandName||c._bandId)}</h2>
      <span class="mono" style="color:var(--cream-mute);font-size:12px">${escapeHtml(c._bandId)}</span>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 4px;font-size:16px">Udseende</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 14px">Vælg et tema som udgangspunkt — eller overstyr farver (HEX) og fonte frit. Tomme felter følger temaet. Preview opdaterer med det samme.</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px">
        <div class="field" style="min-width:180px"><label>Tema (baggrund + font)</label>
          <select class="select" data-cfg="theme" onchange="opPreviewAppearance()">
            ${themes.map(t=>`<option value="${t}" ${c.theme===t?'selected':''}>${escapeHtml(THEMES[t].label)}</option>`).join('')}
          </select></div>
        ${opColorField('Accentfarve','primaryColor','#8A8A8A',false)}
        ${opColorField('Baggrund (HEX)','bgColor','#101316',true)}
        ${opColorField('Tekst (HEX)','textColor','#E8EBEE',true)}
      </div>
      <details style="margin-bottom:14px">
        <summary style="cursor:pointer;color:var(--cream-mute);font-size:12px;font-family:var(--font-mono);letter-spacing:.06em;text-transform:uppercase">Finjustér nuancer</summary>
        <p style="color:var(--cream-mute);font-size:12px;margin:10px 0 12px">Nuancerne udledes normalt af baggrund og tekst ovenfor. Udledningen blander mod hvidt og vasker mætning ud, så en mættet farvetrappe (fx en navy der bliver mere blå opad) skal angives her. Tomme felter = udledt som hidtil.</p>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
          ${opColorField('Kort/panel','bgColorCard','#181C20',true)}
          ${opColorField('Hævede flader','bgColorRaised','#22272C',true)}
          ${opColorField('Rammer/streger','borderColor','#313840',true)}
          ${opColorField('Sekundær tekst','textColorDim','#BCC2C8',true)}
          ${opColorField('Dæmpet tekst','textColorMute','#7E868E',true)}
          ${opColorField('Accent — lys','primaryColorSoft','#A8A8A8',true)}
          ${opColorField('Accent — mørk','primaryColorDeep','#5C5C5C',true)}
        </div>
      </details>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="min-width:170px"><label>Font — brødtekst</label>
          <select class="select" data-cfg="fontUi" onchange="opPreviewAppearance()">${opFontOptions(c.fontUi)}</select></div>
        <div class="field" style="min-width:170px"><label>Font — overskrifter</label>
          <select class="select" data-cfg="fontDisplay" onchange="opPreviewAppearance()">${opFontOptions(c.fontDisplay)}</select></div>
        <button class="btn btn-primary" onclick="opSaveAppearance(this)">Gem udseende</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 14px;font-size:16px">Logo</h3>
      <div class="flex" style="gap:16px;align-items:center">
        <img id="opLogoPreview" class="band-logo" src="${c.logoDataUrl||''}" alt="" style="height:56px;object-fit:contain;background:var(--ink-soft);border-radius:6px;padding:6px;min-width:80px">
        <div>
          <input id="opLogoFile" type="file" accept="image/*" style="font-size:13px;color:var(--cream-mute)">
          <button class="btn btn-ghost btn-sm" onclick="opUploadAsset('logo', this)" style="margin-left:8px">Upload logo</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 6px;font-size:16px">Rider-PDF (erstatter genererede sider)</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 12px">Har I jeres egen færdige rider, så upload den her som PDF — den <strong>erstatter</strong> de genererede rider-sider (side 2, 3 og 4, inkl. sceneplan) i kontrakten. Lad stå tom for at bruge skabelonerne nedenfor.</p>
      <div id="opRiderPdfStatus" style="font-size:12px;color:var(--cream-mute);margin-bottom:8px">${OP_CFG.riderFileId ? '✓ Rider-PDF uploadet — bruges i stedet for skabelonerne' : 'Ingen rider-PDF — skabelonerne nedenfor bruges'}</div>
      <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
        <input id="opRiderFile" type="file" accept="application/pdf" style="font-size:13px;color:var(--cream-mute)">
        <button class="btn btn-ghost btn-sm" onclick="opUploadAsset('rider', this)">Upload rider-PDF</button>
        <button class="btn btn-text btn-sm" onclick="opRemoveRiderPdf(this)">Fjern</button>
      </div>
    </div>

    ${opRiderTemplatesCard()}

    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 14px;font-size:16px">Identitet & kontakt</h3>
      ${opField('Bandnavn','bandName')}
      ${opField('Kort navn','bandShortName')}
      ${opField('Tagline','bandTagline')}
      ${opField('Email-domæne','emailDomain','text','band.dk')}
      ${opField('Kontaktperson','contactName')}
      ${opField('Kontakt-email','contactEmail','email')}
      ${opField('Kontakt-telefon','contactPhone')}
      ${opField('Kontakt-adresse','contactAddress')}
      ${opField('Teknik-kontakt navn','techContactName')}
      ${opField('Teknik-kontakt telefon','techContactPhone')}
      <button class="btn btn-primary" style="margin-top:6px" onclick="opSaveConfig(this)">Gem identitet & kontakt</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 4px;font-size:16px">Dataopbevaring (GDPR)</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 12px">Hvor længe login-loggen må gemmes. Tom eller 0 = behold alt. <em>Bemærk: automatisk sletning er ikke aktiveret — værdien gemmes som politik og kan slås til senere.</em></p>
      <div class="flex" style="gap:8px;align-items:flex-end">
        <div class="field" style="max-width:200px"><label>Slet login-log efter (måneder)</label>
          <input class="input" data-cfg="retentionLoginLogMonths" type="number" min="0" placeholder="Aldrig" value="${escapeHtml(String(c.retentionLoginLogMonths||''))}"></div>
        <button class="btn btn-primary" onclick="opSaveRetention(this)">Gem</button>
      </div>
    </div>

    <div class="card">
      <h3 class="serif" style="margin:0 0 6px;font-size:16px">Admin-adgang</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 12px">Nulstil en brugers adgangskode til den midlertidige kode (tvinges skiftet).</p>
      <div class="flex" style="gap:8px;align-items:flex-end">
        <div class="field" style="flex:1"><label>Email</label><input id="opResetEmail" class="input" type="email" placeholder="bruger@band.dk"></div>
        <button class="btn btn-ghost" onclick="opResetPassword(this)">Nulstil kode</button>
      </div>
      <p style="color:var(--cream-mute);font-size:12px;margin:14px 0 0;border-top:1px solid var(--ink-line-soft);padding-top:12px">Bankoplysninger og CPR styrer bandet selv under <strong>Indstillinger</strong> i deres eget admin-panel.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 class="serif" style="margin:0 0 6px;font-size:16px">Kalender-feed</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 12px">Abonnérbar URL med bandets gigs — del den med medlemmerne, så gigs lander i deres kalender. Alle med URL'en kan se gigs; "Forny" ugyldiggør den gamle URL.</p>
      <div id="opFeedBox" style="margin-bottom:10px"><span class="spinner" style="width:12px;height:12px"></span> Henter feed-URL…</div>
      <div class="flex" style="gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="opCopyFeed()">Kopiér URL</button>
        <button class="btn btn-text btn-sm" onclick="opRotateFeed()">Forny token</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 class="serif" style="margin:0 0 6px;font-size:16px">Backup & data</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 12px">Lav en komplet kopi af bandets Sheet i <span class="mono">Band-app/${escapeHtml(c._bandId)}/Backups/</span> i din Drive.</p>
      <button class="btn btn-ghost btn-sm" id="opBackupBtn" onclick="opBackup()">Lav backup nu</button>
    </div>`);
  // Vis bandets faktiske udseende (tema + HEX-overrides + font) live mens man redigerer.
  opPreviewAppearance();
  opLoadFeed();
}

let OP_FEED_URL = '';
// Feedet serveres af Workerens /ical-rute. FØR: location.pathname + '?action=ical',
// som pegede på app-roden — den rute fandtes ikke i Workeren, så et
// kalenderabonnement hentede index.html i stedet for en kalender. Fejlen har
// været der siden Worker-migreringen; dengang appen kaldte Apps Script direkte,
// ramte ?action=ical dens doGet.
function opFeedUrl(token){ return location.origin + '/ical?band=' + encodeURIComponent(OP_CFG._bandId) + '&token=' + encodeURIComponent(token); }

async function opLoadFeed(){
  const box = document.getElementById('opFeedBox');
  try {
    const d = await _apiCall('getFeedUrl', { bandId: OP_CFG._bandId });
    if (!box) return;
    if (d && d.ok && d.token){
      OP_FEED_URL = opFeedUrl(d.token);
      box.innerHTML = `<div class="input mono" style="word-break:break-all;font-size:11px">${escapeHtml(OP_FEED_URL)}</div>`;
    } else box.innerHTML = `<span style="color:var(--danger)">${escapeHtml((d&&d.error)||'Kunne ikke hente feed-URL')}</span>`;
  } catch(e){ if (box) box.innerHTML = `<span style="color:var(--danger)">Netværksfejl: ${escapeHtml(e.message)}</span>`; }
}

function opCopyFeed(){
  if (!OP_FEED_URL){ toast('Feed-URL ikke klar endnu', 'err'); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(OP_FEED_URL);
  toast('Feed-URL kopieret');
}

async function opRotateFeed(){
  if (!confirm('Forny feed-token?\n\nDen nuværende URL holder op med at virke, og medlemmer skal abonnere på den nye URL.')) return;
  try {
    const d = await _apiCall('rotateFeedToken', { bandId: OP_CFG._bandId });
    if (d && d.ok && d.token){
      OP_FEED_URL = opFeedUrl(d.token);
      const box = document.getElementById('opFeedBox');
      if (box) box.innerHTML = `<div class="input mono" style="word-break:break-all;font-size:11px">${escapeHtml(OP_FEED_URL)}</div>`;
      toast('Feed-token fornyet');
    } else toast((d&&d.error)||'Kunne ikke forny', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

async function opBackup(){
  const btn = document.getElementById('opBackupBtn');
  if (btn){ btn.disabled = true; btn.textContent = 'Laver backup…'; }
  try {
    const d = await _apiCall('backupBand', { bandId: OP_CFG._bandId });
    if (d && d.ok){
      toast('Backup oprettet');
      if (d.url) window.open(d.url, '_blank');
    } else toast((d&&d.error)||'Backup fejlede', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
  finally { if (btn){ btn.disabled = false; btn.textContent = 'Lav backup nu'; } }
}

function opPreviewColor(hex, soft, deep){
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft',
    _isHex(soft) ? soft : _hexLighten(hex, 22));
  document.documentElement.style.setProperty('--accent-deep',
    _isHex(deep) ? deep : _hexDarken(hex, 22));
}

// Farvefelt: synkroniseret color-swatch + HEX-tekstfelt. allowEmpty = må stå tomt (= følg tema).
function opColorField(label, key, fallback, allowEmpty){
  const v = OP_CFG[key] || '';
  const sw = (v && _isHex(v)) ? v : (fallback || '#888888');
  return `<div class="field" style="min-width:148px"><label>${label}</label>
    <div style="display:flex;gap:6px;align-items:center">
      <input type="color" id="op_sw_${key}" value="${sw}" oninput="opSyncColor('${key}',this.value)" style="width:38px;height:38px;padding:3px;flex:none;background:var(--field-bg);border:1px solid var(--ink-line);border-radius:var(--radius)">
      <input class="input mono" data-cfg="${key}" id="op_hex_${key}" value="${escapeHtml(v)}" placeholder="${allowEmpty ? 'Auto (tema)' : escapeHtml(fallback||'')}" oninput="opHexTyped('${key}',this.value)" style="text-transform:uppercase;min-width:96px">
    </div></div>`;
}

function opFontOptions(selected){
  const opt = (val, label) => `<option value="${val}" ${selected===val?'selected':''}>${label}</option>`;
  return opt('', 'Følg tema') + Object.keys(FONT_OPTIONS).map(k => opt(k, k)).join('');
}

// Color-picker → skriv HEX i tekstfeltet → preview.
function opSyncColor(key, val){
  const el = document.getElementById('op_hex_' + key);
  if (el) el.value = String(val).toUpperCase();
  opPreviewAppearance();
}

/**
 * HEX tastet eller indsat → opdatér farveprøven → preview.
 *
 * Synkroniseringen var envejs: farveprøven skrev til tekstfeltet, men ikke
 * omvendt. Indsatte man en palette som tekst — den normale måde at flytte et
 * bands farver over på — blev prøverne stående på de gamle farver, og det så
 * ud som om værdien ikke var taget imod. Kun preview'et afslørede at den var.
 *
 * Ugyldig eller tom værdi lader prøven stå: den har ingen meningsfuld farve at
 * vise, og at nulstille den til sort ville se ud som et valg brugeren har taget.
 */
function opHexTyped(key, val){
  const sw = document.getElementById('op_sw_' + key);
  if (sw && _isHex(val)) sw.value = String(val).toLowerCase();
  opPreviewAppearance();
}

// HEX-felter i udseende-formularen (ud over accent, som håndteres separat).
// Skal matche APPEARANCE_COLOR_KEYS i Code.gs og _applyAppearanceOverrides.
const OP_APPEARANCE_HEX = ['bgColor', 'bgColorCard', 'bgColorRaised', 'borderColor',
                           'textColor', 'textColorDim', 'textColorMute',
                           // Accentens to nuancer. De udledes som accent ±22%, men
                           // _hexDarken trækker fra hver kanal og dæmper dermed
                           // mætningen: en varm amber #E8A867 bliver til #b58350,
                           // hvor den håndplukkede er #C68642. Forskellen ses på
                           // hover- og tryk-tilstande, så farven skal kunne sættes.
                           'primaryColorSoft', 'primaryColorDeep'];

// Live-preview af HELE udseendet: tema + HEX-overrides + accent + fonte.
function opPreviewAppearance(){
  const g = k => { const el = opRoot() && opRoot().querySelector('[data-cfg="'+k+'"]'); return el ? el.value.trim() : ''; };
  _applyThemeVars(g('theme') || DEFAULT_THEME);
  const o = { fontUi:g('fontUi'), fontDisplay:g('fontDisplay') };
  OP_APPEARANCE_HEX.forEach(k => { o[k] = g(k); });
  _applyAppearanceOverrides(o);
  opPreviewColor(g('primaryColor') || '#8A8A8A',
                 g('primaryColorSoft'), g('primaryColorDeep'));
}

// Nulstil til operatør-stilen (neutralt tema + gylden accent) uden for editoren.
function opResetChrome(){
  _applyThemeVars(DEFAULT_THEME);
  document.documentElement.style.setProperty('--accent', '#C8A24B');
  document.documentElement.style.setProperty('--accent-soft', '#DBBE7C');
  document.documentElement.style.setProperty('--accent-deep', '#9C7B2E');
}

function opCollect(keys){
  const out = {};
  opRoot().querySelectorAll('[data-cfg]').forEach(el => {
    const k = el.getAttribute('data-cfg');
    if (!keys || keys.indexOf(k) !== -1) out[k] = el.value;
  });
  return out;
}

async function opWrite(changes, okMsg){
  try {
    const d = await _apiCall('adminWriteConfig', { bandId: OP_CFG._bandId, changes: changes });
    if (d && d.ok){ Object.assign(OP_CFG, changes); toast(okMsg||'Gemt'); }
    else toast((d&&d.error)||'Kunne ikke gemme', 'err');
  } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
}

async function opSaveAppearance(btn){
  const g = k => { const el = opRoot().querySelector('[data-cfg="'+k+'"]'); return el ? el.value.trim() : ''; };
  const accent = g('primaryColor') || '#8A8A8A';
  // Tomt nuancefelt = udled som hidtil. Sat felt vinder. Værdien SKRIVES altid
  // (aldrig tom), fordi applyBranding falder tilbage til udledningen ved tom
  // værdi — så et gemt tomt felt og en udledt værdi giver samme resultat.
  const changes = {
    theme: g('theme'),
    primaryColor: accent,
    primaryColorSoft: g('primaryColorSoft') || _hexLighten(accent, 22),
    primaryColorDeep: g('primaryColorDeep') || _hexDarken(accent, 22),
    fontUi: g('fontUi'), fontDisplay: g('fontDisplay')
  };
  for (const k of OP_APPEARANCE_HEX){
    const v = g(k);
    if (v && !_isHex(v)){ toast(k + ' skal være #RRGGBB (eller tom)', 'err'); return; }
    // Accentnuancerne er allerede sat ovenfor med udledning som reserve. Uden
    // dette ville løkken skrive dem tomme igen når felterne står tomme.
    if (k === 'primaryColorSoft' || k === 'primaryColorDeep') continue;
    changes[k] = v;
  }
  await withBusy(btn, 'Gemmer…', () => opWrite(changes, 'Udseende gemt — bandet ser det ved næste login'));
}

async function opSaveRetention(btn){
  const el = opRoot().querySelector('[data-cfg="retentionLoginLogMonths"]');
  await withBusy(btn, 'Gemmer…', () => opWrite({ retentionLoginLogMonths: el ? el.value.trim() : '' }, 'Opbevaringspolitik gemt'));
}

async function opRemoveRiderPdf(btn){
  await withBusy(btn, 'Fjerner…', async () => {
    await opWrite({ riderFileId: '' }, 'Rider-PDF fjernet');
    const st = document.getElementById('opRiderPdfStatus'); if (st) st.textContent = 'Ingen rider-PDF — skabelonerne nedenfor bruges';
  });
}

// Bandets gemte rider-skabeloner (parses fra OP_CFG). Tom/korrupt = {}.
function _opRiderTpl(){
  return _parseRiderTemplates(OP_CFG.riderTemplates);
}

// Editor-kort: per kontrakttype en intro + punkter (ét punkt pr. linje).
// Felterne forudfyldes med bandets egne skabeloner, ellers de indbyggede defaults.
function opRiderTemplatesCard(){
  const saved = _opRiderTpl();
  const blocks = CONTRACT_TYPES.map(type => {
    const def = DEFAULT_RIDER_TEMPLATES[type] || { intro:'', points:[] };
    const cur = saved[type] || {};
    const intro = (cur.intro != null && String(cur.intro).trim() !== '') ? cur.intro : def.intro;
    const points = (Array.isArray(cur.points) && cur.points.length) ? cur.points : def.points;
    const customised = !!(saved[type] && (String(cur.intro||'').trim() || (Array.isArray(cur.points) && cur.points.length)));
    return `
      <div style="margin-bottom:18px">
        <div class="flex" style="justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <h4 class="serif" style="margin:0;font-size:14px">${escapeHtml(type)}</h4>
          <span style="font-size:11px;color:var(--cream-mute)">${customised ? 'tilpasset' : 'bruger standard'}</span>
        </div>
        <label style="display:block;font-size:12px;color:var(--cream-mute);margin-bottom:4px">Intro</label>
        <textarea class="textarea" data-rtpl-intro="${escapeHtml(type)}" rows="5" style="width:100%;margin-bottom:10px">${escapeHtml(intro)}</textarea>
        <label style="display:block;font-size:12px;color:var(--cream-mute);margin-bottom:4px">Rider-punkter — ét pr. linje</label>
        <textarea class="textarea" data-rtpl-points="${escapeHtml(type)}" rows="10" style="width:100%">${escapeHtml(points.join('\n'))}</textarea>
        <button class="btn btn-text btn-sm" style="margin-top:6px" data-reset-rider-tpl="${escapeHtml(type)}">↺ Nulstil til standard</button>
        ${TYPES_WITH_SCENEPLAN.indexOf(type) !== -1 ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(245,237,224,.1)">
          <label style="display:block;font-size:12px;color:var(--cream-mute);margin-bottom:6px">Sceneplan (billede) — indlejres som side 4 på ${escapeHtml(type)}-kontrakter. Ignoreres hvis der er uploadet en rider-PDF ovenfor.</label>
          <div id="opSceneplanStatus" style="font-size:12px;color:var(--cream-mute);margin-bottom:8px">${OP_CFG.sceneplanFileId ? '✓ Sceneplan uploadet' : 'Ingen sceneplan uploadet endnu'}</div>
          <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
            <input id="opSceneplanFile" type="file" accept="image/*" style="font-size:13px;color:var(--cream-mute)">
            <button class="btn btn-ghost btn-sm" onclick="opUploadAsset('sceneplan', this)">Upload billede</button>
            <button class="btn btn-ghost btn-sm" onclick="opOpenSceneplanEditor()">${OP_CFG.sceneplanJson ? '✏️ Redigér i editor' : '✏️ Tegn i editor'}</button>
            <button class="btn btn-text btn-sm" onclick="opRemoveSceneplan(this)">Fjern</button>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="card" style="margin-bottom:16px">
      <h3 class="serif" style="margin:0 0 6px;font-size:16px">Rider-skabeloner (pr. kontrakttype)</h3>
      <p style="color:var(--cream-mute);font-size:12px;margin:0 0 14px">Teksten der genereres ind i kontrakt-PDF'en. Du kan bruge pladsholdere som <code>__BAND_NAME__</code>, <code>__TECH_NAME__</code>, <code>__TECH_PHONE__</code>, <code>__CONTACT_NAME__</code>, <code>__CONTACT_PHONE__</code> — de udfyldes automatisk. Tomme felter falder tilbage til standardteksten.</p>
      ${blocks}
      <button class="btn btn-primary" onclick="opSaveRiderTemplates(this)">Gem rider-skabeloner</button>
    </div>`;
}

// Nulstiller felterne for én type til de indbyggede defaults (gemmer ikke før der trykkes Gem).
function opResetRiderTemplate(type){
  const def = DEFAULT_RIDER_TEMPLATES[type]; if (!def) return;
  const introEl = opRoot().querySelector('[data-rtpl-intro="'+type+'"]');
  const pointsEl = opRoot().querySelector('[data-rtpl-points="'+type+'"]');
  if (introEl) introEl.value = def.intro;
  if (pointsEl) pointsEl.value = def.points.join('\n');
  toast(type + ' nulstillet — husk at gemme');
}

async function opSaveRiderTemplates(btn){
  const out = {};
  CONTRACT_TYPES.forEach(type => {
    const introEl = opRoot().querySelector('[data-rtpl-intro="'+type+'"]');
    const pointsEl = opRoot().querySelector('[data-rtpl-points="'+type+'"]');
    const intro = introEl ? introEl.value.trim() : '';
    const points = pointsEl ? pointsEl.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
    out[type] = { intro: intro, points: points };
  });
  await withBusy(btn, 'Gemmer…', () => opWrite({ riderTemplates: JSON.stringify(out) }, 'Rider-skabeloner gemt'));
}

async function opSaveConfig(btn){
  const keys = ['bandName','bandShortName','bandTagline','emailDomain','contactName','contactEmail','contactPhone','contactAddress','techContactName','techContactPhone'];
  await withBusy(btn, 'Gemmer…', () => opWrite(opCollect(keys), 'Gemt'));
}

function _fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const _ASSET_INPUT = { logo:'opLogoFile', rider:'opRiderFile', sceneplan:'opSceneplanFile' };
const _ASSET_KEY   = { logo:'logoFileId', rider:'riderFileId', sceneplan:'sceneplanFileId' };
const _ASSET_LABEL = { logo:'Logo', rider:'Rider-PDF', sceneplan:'Sceneplan' };

async function opUploadAsset(kind, btn){
  const input = document.getElementById(_ASSET_INPUT[kind]);
  const file = input && input.files && input.files[0];
  if (!file){ toast('Vælg en fil først', 'err'); return; }
  await withBusy(btn, 'Uploader…', async () => {
    try {
      const dataBase64 = await _fileToBase64(file);
      const up = await _apiCall('adminUploadAsset', {
        bandId: OP_CFG._bandId, kind: kind,
        filename: file.name, contentType: file.type, dataBase64: dataBase64
      });
      if (!up || !up.ok){ toast((up&&up.error)||'Upload fejlede', 'err'); return; }
      await opWrite({ [_ASSET_KEY[kind]]: up.fileId }, (_ASSET_LABEL[kind]||'Fil') + ' uploadet');
      if (input) input.value = ''; // ryd fil-feltet så man ikke uploader samme fil igen ved et uheld
      if (kind === 'logo'){
        const dataUrl = await _fileToBase64(file).then(b64 => 'data:'+(file.type||'image/png')+';base64,'+b64);
        const img = document.getElementById('opLogoPreview'); if (img) img.src = dataUrl;
        OP_CFG.logoDataUrl = dataUrl;
      }
      if (kind === 'sceneplan'){
        // Opdatér status uden full re-render (bevarer ugemte skabelon-edits).
        const st = document.getElementById('opSceneplanStatus'); if (st) st.textContent = '✓ Sceneplan uploadet';
      }
      if (kind === 'rider'){
        const st = document.getElementById('opRiderPdfStatus'); if (st) st.textContent = '✓ Rider-PDF uploadet — bruges i stedet for skabelonerne';
      }
    } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
  });
}

async function opRemoveSceneplan(btn){
  await withBusy(btn, 'Fjerner…', async () => {
    await opWrite({ sceneplanFileId: '', sceneplanJson: '' }, 'Sceneplan fjernet');
    const st = document.getElementById('opSceneplanStatus'); if (st) st.textContent = 'Ingen sceneplan uploadet endnu';
  });
}

// Åbner sceneplan-editoren (public/js/10-sceneplan-editor.js) forudfyldt med bandets
// tidligere gemte tegning (hvis nogen). "Gem & publicér" genbruger nøjagtig samme
// upload+config-skrivning som den manuelle billed-upload ovenfor, så begge veje
// (upload et billede / tegn det selv) lander i samme sceneplanFileId.
function opOpenSceneplanEditor(){
  let initialState = null;
  if (OP_CFG.sceneplanJson){
    try { initialState = JSON.parse(OP_CFG.sceneplanJson); } catch(e){ initialState = null; }
  }
  SceneplanEditor.open({
    state: initialState,
    bandName: OP_CFG.bandName,
    onPublish: async ({ dataBase64, contentType, filename, stateJson }) => {
      const up = await _apiCall('adminUploadAsset', {
        bandId: OP_CFG._bandId, kind: 'sceneplan',
        filename: filename, contentType: contentType, dataBase64: dataBase64
      });
      if (!up || !up.ok) throw new Error((up && up.error) || 'Upload fejlede');
      await opWrite({ sceneplanFileId: up.fileId, sceneplanJson: stateJson }, 'Sceneplan gemt & publiceret til rider');
      const st = document.getElementById('opSceneplanStatus'); if (st) st.textContent = '✓ Sceneplan uploadet';
    }
  });
}

async function opResetPassword(btn){
  const email = document.getElementById('opResetEmail').value.trim().toLowerCase();
  if (!email){ toast('Udfyld email', 'err'); return; }
  await withBusy(btn, 'Nulstiller…', async () => {
    try {
      const d = await _apiCall('adminResetMemberPassword', { bandId: OP_CFG._bandId, memberEmail: email });
      if (d && d.ok) toast('Kode nulstillet til: ' + d.seedPassword);
      else toast((d&&d.error)||'Kunne ikke nulstille', 'err');
    } catch(e){ toast('Netværksfejl: '+e.message, 'err'); }
  });
}

async function bootBranding(){
  try {
    const d = await _apiCall('getConfig', {});
    if (d && d.ok && d.config){
      BAND_CONFIG = Object.assign(BAND_CONFIG, d.config);
      DMD_LOGO_B64 = BAND_CONFIG.logoDataUrl || '';
    }
  } catch(e){
    console.warn('Kunne ikke hente band-config — bruger defaults:', e.message);
  }
  applyBranding();
}

function applyBranding(){
  const c = BAND_CONFIG;
  _applyThemeVars(c.theme || DEFAULT_THEME);
  const accent = c.primaryColor || '#8A8A8A';
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-soft', c.primaryColorSoft || _hexLighten(accent, 22));
  document.documentElement.style.setProperty('--accent-deep', c.primaryColorDeep || _hexDarken(accent, 22));
  _applyAppearanceOverrides(c);
  if (c.bandName){
    document.title = c.bandShortName ? (c.bandShortName + ' — ' + c.bandName) : c.bandName;
  }
  if (DMD_LOGO_B64){
    document.querySelectorAll('img.band-logo').forEach(el => {
      el.src = DMD_LOGO_B64;
      if (c.bandName) el.alt = c.bandName;
    });
  }
  // Booking & e-signatur: feature-flag operatøren slår til pr. band (Fase A).
  document.querySelectorAll('[data-route="bookings"]').forEach(el => { el.style.display = c.booking ? '' : 'none'; });
  const emailInput = document.getElementById('emailInput');
  if (emailInput && c.emailDomain) emailInput.placeholder = 'navn@' + c.emailDomain;
  document.querySelectorAll('[data-band-tagline]').forEach(el => {
    el.textContent = (c.bandName || '') + (c.bandTagline ? ' · ' + c.bandTagline : '') + ' · Medlem';
  });
  document.querySelectorAll('[data-band-name]').forEach(el => { el.textContent = c.bandName || ''; });
}

function _showBootError(title, msg) {
  document.body.innerHTML = '<div style="max-width:560px;margin:80px auto;padding:32px;background:#0F213C;border:1px solid #D97A6C;border-radius:8px;color:#F5EDE0;font-family:system-ui,sans-serif"><h1 style="margin:0 0 12px;color:#D97A6C">' + title + '</h1>' + msg + '</div>';
}
// (SCRIPT_URL-tjekket er fjernet — frontend kender ikke længere Apps Script-URL'en;
//  Worker'en holder den server-side.)
if (OPERATOR_MODE){
  // Samlet admin-/operatør-UI — springer band-validering over.
  opStart();
} else if (BOOKER_MODE){
  // Booker-portal (Fase B/C) — springer band-validering over, ligesom operatør.
  bkStart();
} else {
  if (!BAND_ID || !/^[a-z0-9-]+$/.test(BAND_ID)){
    _showBootError('Mangler band-id i URL', '<p>Tilføj <code>?band=&lt;bandId&gt;</code> til URL\'en for at åbne den korrekte band-app.</p><p style="color:#9A9285;font-size:13px">Eksempel: <code>' + location.origin + location.pathname + '?band=mit-band</code></p><p style="color:#9A9285;font-size:13px">Kontakt din administrator hvis du ikke kender bandets id.</p>');
    throw new Error('BAND_ID mangler i URL');
  }
  bootBranding().then(tryRestore);
}
