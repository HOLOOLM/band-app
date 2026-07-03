// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ── Members ────────────────────────────────────────────────────
async function renderMembers(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Medlemmer</h1>
        <div class="lede">Musikere, afløsere og crew.</div>
      </div>
      <button class="btn btn-primary" onclick="openMemberDrawer(null)">+ Nyt medlem</button>
    </div>
    <div class="filter-bar">
      <div class="filter-pill" id="memberFilter">
        ${['alle','Musiker','Afløser','Crew'].map(f=>`<button data-f="${f}" class="${ADMIN_STATE.memberFilter===f?'on':''}">${f==='alle'?'Alle':f}</button>`).join('')}
      </div>
    </div>
    <div id="membersGrid" class="muted"><span class="spinner"></span>Henter...</div>
  `;
  document.querySelectorAll('#memberFilter button').forEach(b=>{
    b.onclick = ()=>{ ADMIN_STATE.memberFilter = b.getAttribute('data-f'); drawMembersGrid(); };
  });
  if (CACHE.members && cacheFresh('members')) { drawMembersGrid(); return; }
  try {
    const d = await apiGet('getMembers');
    if (!document.getElementById('membersGrid')) return; // navigerede væk
    if (!d.ok){ _failInto('membersGrid', d.error || 'Kunne ikke hente medlemmer', 'renderMembers()'); return; }
    CACHE.members = d.members; cacheTouch('members');
    drawMembersGrid();
  } catch(e){ _failInto('membersGrid', e.message, 'renderMembers()'); }
}

function drawMembersGrid(){
  const wrap = document.getElementById('membersGrid');
  if (!wrap || !CACHE.members) return;
  document.querySelectorAll('#memberFilter button').forEach(b =>
    b.classList.toggle('on', b.getAttribute('data-f') === ADMIN_STATE.memberFilter));
  let rows = CACHE.members.slice();
  if (ADMIN_STATE.memberFilter !== 'alle') rows = rows.filter(m=>m.category===ADMIN_STATE.memberFilter);
  if (!rows.length){ wrap.innerHTML = '<div class="empty">Ingen medlemmer.</div>'; return; }
  wrap.innerHTML = '<div class="member-grid">' + rows.map(m=>`
    <div class="card member-card" onclick="openMemberDrawer('${escapeHtml(m.id)}')">
      <div class="avatar">${initials(m.name)}</div>
      <div class="info">
        <div class="role-line">${escapeHtml(m.category||'')} · ${escapeHtml(m.instrument||'')}</div>
        <h3 class="name serif">${escapeHtml(m.name)}</h3>
        <div class="meta">${escapeHtml(m.phone||'')}<br>${escapeHtml(m.email||'')}</div>
        ${m.role==='admin'?'<div style="margin-top:8px"><span class="badge amber"><span class="badge-dot"></span>Admin</span></div>':''}
      </div>
    </div>`).join('') + '</div>';
}

function openMemberDrawer(id){
  const m = id ? (CACHE.members||[]).find(x=>x.id===id) : null;
  const isNew = !m;
  document.getElementById('drawer').innerHTML = `
    <div class="drawer-head">
      <h2>${isNew ? 'Nyt medlem' : 'Rediger medlem'}</h2>
      <button class="btn btn-text" onclick="closeDrawer()">✕</button>
    </div>
    <div class="drawer-body">
      <div class="field"><label>Navn</label><input id="md_name" class="input" value="${escapeHtml((m&&m.name)||'')}"></div>
      <div class="row-2">
        <div class="field"><label>Kategori</label>
          <select id="md_category" class="select">
            ${['Musiker','Afløser','Crew'].map(c=>`<option value="${c}"${m&&m.category===c?' selected':''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Rolle</label>
          <select id="md_role" class="select">
            <option value="member"${!m||m.role==='member'?' selected':''}>Medlem</option>
            <option value="admin"${m&&m.role==='admin'?' selected':''}>Admin</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Instrument</label><input id="md_instrument" class="input" value="${escapeHtml((m&&m.instrument)||'')}"></div>
      <div class="row-2">
        <div class="field"><label>Telefon</label><input id="md_phone" class="input" value="${escapeHtml((m&&m.phone)||'')}"></div>
        <div class="field"><label>Email</label><input id="md_email" class="input" type="email" value="${escapeHtml((m&&m.email)||'')}">
          ${m?`<div class="muted" style="font-size:11px;margin-top:3px">Bruges til login — ændring træder i kraft ved næste login.</div>`:''}</div>
      </div>
      <div class="field"><label>Reg. + konto</label><input id="md_regAccount" class="input" value="${escapeHtml((m&&m.regAccount)||'')}" placeholder="1234-5678901234"></div>
      ${m ? `<div class="card" style="padding:14px;margin-top:6px">
        <div class="eyebrow" style="margin-bottom:6px">Adgangskode</div>
        <div class="muted" style="font-size:13px;margin-bottom:10px">Nulstiller til en midlertidig adgangskode — den vises efter nulstilling, og medlemmet tvinges til at vælge en ny ved næste login.</div>
        <button class="btn btn-ghost btn-sm" onclick="resetMemberPw('${escapeHtml(m.id)}')">Nulstil adgangskode</button>
      </div>` : ''}
    </div>
    <div class="drawer-foot">
      ${m && m.id !== SESSION.member.id ? `<button class="btn btn-danger btn-sm" onclick="deleteMember('${escapeHtml(m.id)}')">Slet</button>` : '<span></span>'}
      <button class="btn btn-primary" onclick="saveMember(${m?`'${escapeHtml(m.id)}'`:'null'})">Gem</button>
    </div>
  `;
  document.getElementById('drawer').classList.add('show');
  document.getElementById('drawerBackdrop').classList.add('show');
}

function closeDrawer(){
  document.getElementById('drawer').classList.remove('show');
  document.getElementById('drawerBackdrop').classList.remove('show');
}

async function saveMember(id){
  const member = {
    id: id || undefined,
    name: document.getElementById('md_name').value.trim(),
    category: document.getElementById('md_category').value,
    role: document.getElementById('md_role').value,
    instrument: document.getElementById('md_instrument').value.trim(),
    phone: document.getElementById('md_phone').value.trim(),
    email: document.getElementById('md_email').value.trim(),
    regAccount: document.getElementById('md_regAccount').value.trim()
  };
  if (!member.name || !member.email){ toast('Navn og email er påkrævet','err'); return; }
  try {
    const d = await apiPost('saveMember', { member: member });
    if (!d.ok){ toast(d.error,'err'); return; }
    toast(id ? 'Opdateret' : 'Oprettet — initial password: ' + (d.seedPassword || '(se backend)'));
    cacheBust('members'); cacheBust('dashboard'); broadcastInvalidate(['members','dashboard']);
    closeDrawer();
    renderMembers();
  } catch(e){ toast(e.message,'err'); }
}

async function deleteMember(id){
  if (!confirm('Slet medlem? Eksisterende job-tildelinger bevares.')) return;
  try {
    const d = await apiPost('deleteMember', { id: id });
    if (!d.ok){ toast(d.error,'err'); return; }
    toast('Slettet');
    cacheBust('members'); cacheBust('dashboard'); broadcastInvalidate(['members','dashboard']);
    closeDrawer();
    renderMembers();
  } catch(e){ toast(e.message,'err'); }
}

async function resetMemberPw(id){
  if (!confirm('Nulstil adgangskoden til en midlertidig adgangskode? Den vises efter nulstilling, og medlemmet skal vælge en ny ved næste login.')) return;
  try {
    const d = await apiPost('resetPassword', { id: id });
    if (!d.ok){ toast(d.error,'err'); return; }
    toast('Nulstillet — midlertidig adgangskode: ' + (d.seedPassword || '(se backend)'));
  } catch(e){ toast(e.message,'err'); }
}

// ──────────────────────────────────────────────────────────────────
//                          MEMBER ROUTES
// ──────────────────────────────────────────────────────────────────
let MEMBER_VIEW = 'jobs';
let MEMBER_JOB = null;

function setMemberView(v, params){
  MEMBER_VIEW = v;
  document.querySelectorAll('#memberApp .mode-pill button').forEach(b=>{
    b.classList.toggle('on', b.getAttribute('data-mview') === (v === 'jobDetail' ? 'jobs' : v));
  });
  if (v === 'jobs') return renderMyJobs();
  if (v === 'jobDetail') return renderJobDetail(params && params.attendanceId, params && params.bandId);
  if (v === 'honorar') return renderMyHonorar();
  if (v === 'profil') return renderMyProfile();
}

let MEMBER_JOBS_FILTER = 'upcoming';
let MEMBER_JOBS_SCOPE = 'this';     // 'this' = dette band · 'all' = alle bands (betalt feature)
let MEMBER_JOBS_CACHE = null;       // dette band: { jobs, homeAddr, fetchedAt }
let MEMBER_JOBS_CACHE_ALL = null;   // alle bands: { jobs, scope:'all', bandCount, fetchedAt }
async function renderMyJobs(opts){
  const force = opts && opts.force;
  const main = document.getElementById('memberMain');
  const cache = MEMBER_JOBS_SCOPE === 'all' ? MEMBER_JOBS_CACHE_ALL : MEMBER_JOBS_CACHE;
  // Brug cache hvis vi har det — så filter-/scope-skift er øjeblikkeligt.
  if (!force && cache) {
    _renderMyJobsFrom(cache);
    return;
  }
  main.innerHTML = '<div class="muted"><span class="spinner"></span>Henter...</div>';
  try {
    if (MEMBER_JOBS_SCOPE === 'all') {
      const d = await apiGet('getAllJobs');
      const mainEl = document.getElementById('memberMain');
      if (!mainEl) return;
      if (!d.ok){ _failInto('memberMain', d.error || 'Kunne ikke hente jobs på tværs', 'renderMyJobs()'); return; }
      MEMBER_JOBS_CACHE_ALL = { jobs: d.jobs || [], scope: 'all', bandCount: d.bandCount || 0, fetchedAt: Date.now() };
      _renderMyJobsFrom(MEMBER_JOBS_CACHE_ALL);
      return;
    }
    const d = await apiGet('getJobs');
    const mainEl = document.getElementById('memberMain');
    if (!mainEl) return;
    if (!d.ok){ _failInto('memberMain', d.error || 'Kunne ikke hente dine jobs', 'renderMyJobs()'); return; }
    const jobs = d.jobs || [];
    const homeAddr = (d.member && d.member.address) || (SESSION.member && SESSION.member.address) || '';
    if (SESSION.member) SESSION.member.address = homeAddr;
    MEMBER_JOBS_CACHE = { jobs, homeAddr, fetchedAt: Date.now() };
    _renderMyJobsFrom(MEMBER_JOBS_CACHE);
  } catch(e){ _failInto('memberMain', e.message, 'renderMyJobs()'); }
}

// Skift mellem "dette band" og "alle bands" i jobvisningen.
function setJobsScope(scope){
  if (scope === MEMBER_JOBS_SCOPE) return;
  MEMBER_JOBS_SCOPE = scope;
  renderMyJobs();
}

function _scopeToggleHtml(){
  if (!BAND_CONFIG.crossBand) return ''; // featuren er ikke slået til for dette band
  const all = MEMBER_JOBS_SCOPE === 'all';
  return `
    <div class="job-scope-row" style="display:flex;gap:6px;margin-bottom:12px">
      <button class="job-filter-pill${!all?' active':''}" onclick="setJobsScope('this')">Dette band</button>
      <button class="job-filter-pill${all?' active':''}" onclick="setJobsScope('all')" title="Se dine jobs på tværs af alle bands med funktionen slået til">🌐 Alle bands</button>
    </div>`;
}

function _renderMyJobsFrom(cache){
  const mainEl = document.getElementById('memberMain');
  if (!mainEl) return;
  const jobs = cache.jobs;
  const crossBand = cache.scope === 'all';
  const homeAddr = cache.homeAddr;
  {
    const upcoming = jobs.filter(j => !_isJobArchived(j));
    const archived = jobs.filter(j => _isJobArchived(j)).sort((a,b)=> new Date(b.date)-new Date(a.date));
    const filter = MEMBER_JOBS_FILTER;
    const shown = filter === 'archived' ? archived : filter === 'all' ? [...upcoming, ...archived] : upcoming;
    const heading = filter === 'archived'
      ? `${archived.length} arkiveret${archived.length===1?'':'e'} koncert${archived.length===1?'':'er'}.`
      : filter === 'all'
        ? `${jobs.length} koncert${jobs.length===1?'':'er'} i alt.`
        : `Du er booket på ${upcoming.length} koncert${upcoming.length===1?'':'er'}.`;
    const lede = crossBand
      ? `På tværs af ${cache.bandCount||0} band${(cache.bandCount===1)?'':'s'}.`
      : (filter === 'archived' ? 'Tidligere spillede jobs.' : 'Gi´ gas — nyd jobbet');
    const emptyMsg = crossBand
      ? (cache.bandCount ? 'Ingen jobs på tværs lige nu.' : 'Du spiller ikke i andre bands med denne funktion slået til.')
      : (filter==='archived'?'Ingen arkiverede jobs endnu.':'Ingen kommende jobs.');
    mainEl.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="serif">${heading}</h1>
          <div class="lede">${lede}</div>
        </div>
        ${upcoming.length ? `<button class="btn btn-ghost btn-sm" onclick="downloadMyCalendar()" title="Læg dine kommende koncerter i din kalender">📅 Føj til kalender</button>` : ''}
      </div>
      ${_scopeToggleHtml()}
      ${crossBand ? '' : homeAddressCardHtml(homeAddr)}
      <div class="job-filter-row">
        <button class="job-filter-pill${filter==='upcoming'?' active':''}" data-filter="upcoming">Kommende (${upcoming.length})</button>
        <button class="job-filter-pill${filter==='archived'?' active':''}" data-filter="archived">Arkiveret (${archived.length})</button>
        <button class="job-filter-pill${filter==='all'?' active':''}" data-filter="all">Alle (${jobs.length})</button>
        <button class="job-filter-pill" id="memberJobsRefresh" title="Hent jobs igen" style="margin-left:auto">↻ Opdater</button>
      </div>
      ${shown.length === 0 ? `<div class="card"><div class="empty">${emptyMsg}</div></div>` : shown.map(j => jobCardHtml(j)).join('')}
    `;
    document.querySelectorAll('.job-filter-pill[data-filter]').forEach(btn => {
      btn.onclick = () => { MEMBER_JOBS_FILTER = btn.getAttribute('data-filter'); renderMyJobs(); };
    });
    bindJobCards(shown);
    if (!crossBand) bindHomeAddressCard();
    const refreshBtn = document.getElementById('memberJobsRefresh');
    if (refreshBtn) refreshBtn.onclick = ()=>{ if (crossBand) MEMBER_JOBS_CACHE_ALL = null; else MEMBER_JOBS_CACHE = null; renderMyJobs({force:true}); };
  }
}

