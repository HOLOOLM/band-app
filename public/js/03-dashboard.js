// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ── Dashboard ──────────────────────────────────────────────────
async function renderDashboard(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">${escapeHtml(SESSION.member.name||'')}</h1>
        <div class="lede">Her er status på ${escapeHtml(BAND_CONFIG.bandName || 'bandet')}.</div>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:28px" id="dashStats">
      ${[1,2,3,4].map(()=>'<div class="stat-tile"><div class="label">—</div><div class="value">—</div></div>').join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start">
      <div class="card">
        <div style="margin-bottom:14px">
          <div class="eyebrow warm">Næste op</div>
          <h2 class="serif" style="margin:6px 0 0;font-weight:400;font-size:24px">Kommende jobs</h2>
        </div>
        <div id="dashUpcoming" class="muted"><span class="spinner"></span>Henter...</div>
      </div>
      <div class="card">
        <div style="margin-bottom:14px">
          <div class="eyebrow warm">Oversigt</div>
          <h2 class="serif" style="margin:6px 0 0;font-weight:400;font-size:24px">Arrangører</h2>
        </div>
        <div id="dashArrangoere" class="muted"><span class="spinner"></span>Henter...</div>
      </div>
    </div>
  `;
  // Stale-while-revalidate: hvis vi har en gammel snapshot, render den straks
  // og hent friske data i baggrunden. Den friske data overskriver kun DOM
  // hvis brugeren stadig er på dashboardet.
  if (CACHE.dashboard) {
    _paintDashboard(CACHE.dashboard);
    if (cacheFresh('dashboard')) return;
    // Refresh in background
    apiGet('getDashboard').then(fresh => {
      if (fresh && fresh.ok){
        CACHE.dashboard = fresh; cacheTouch('dashboard');
        if (ADMIN_ROUTE === 'dashboard' && document.getElementById('dashStats')){
          _paintDashboard(fresh);
        }
      }
    }).catch(()=>{});
    return;
  }
  const fail = (m)=>{ _failInto('dashUpcoming', m, 'renderDashboard()'); _clearEl('dashStats'); _clearEl('dashArrangoere'); };
  try {
    const d = await apiGet('getDashboard');
    if (!d.ok){ fail(d.error || 'Kunne ikke hente dashboard'); return; }
    CACHE.dashboard = d; cacheTouch('dashboard');
    _paintDashboard(d);
  } catch(e){ fail(e.message); }
}

function _paintDashboard(d){
  try {
    const statsEl = document.getElementById('dashStats');
    const upcomingEl = document.getElementById('dashUpcoming');
    const arrangoereEl = document.getElementById('dashArrangoere');
    if (!statsEl || !upcomingEl) return; // bruger navigerede væk inden svar kom
    statsEl.innerHTML = `
      <div class="stat-tile"><div class="label">Aktive kontrakter</div><div class="value">${d.stats.aktiveKontrakter}</div></div>
      <div class="stat-tile"><div class="label">Booket honorar (total)</div><div class="value warm">${fmtMoney(d.stats.bookedHonorar)}</div></div>
      <div class="stat-tile"><div class="label">Dit honorar (kommende)</div><div class="value warm">${fmtMoney(d.stats.mitHonorar)}</div></div>
      <div class="stat-tile"><div class="label">Aktive medlemmer</div><div class="value">${d.stats.aktiveMedlemmer}</div></div>
    `;
    if (!d.upcoming.length){
      upcomingEl.innerHTML = '<div class="empty">Ingen kommende jobs.</div>';
    } else {
      upcomingEl.innerHTML = `
        <table class="table">
          <thead><tr><th>Dato</th><th>Spillested</th><th>Type</th><th style="text-align:right">Honorar</th><th>Status</th><th>Besætning</th></tr></thead>
          <tbody>
            ${d.upcoming.map((c,idx) => {
              const attCount = (c.attendees||[]).length;
              return `
              <tr class="clickable" data-contract-id="${escapeHtml(c.id)}">
                <td class="mono" style="color:var(--accent)">${fmtDate(c.date)}</td>
                <td><span class="serif" style="font-size:16px">${escapeHtml((c.venue&&c.venue.name)||'—')}</span> <span class="muted">· ${escapeHtml((c.venue&&c.venue.city)||'')}</span></td>
                <td>${escapeHtml(c.type||'')}</td>
                <td style="text-align:right" class="mono">${fmtMoney(c.honorar)}</td>
                <td>${statusBadge(c.status)}</td>
                <td data-attendees-idx="${idx}" style="cursor:pointer">
                  <span title="Vis besætning" style="display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid var(--ink-line);background:rgba(8,17,31,.4);font-family:var(--font-mono);font-size:12px;color:var(--cream)">
                    👥 ${attCount}
                  </span>
                </td>
              </tr>`}).join('')}
          </tbody>
        </table>`;
      upcomingEl.querySelectorAll('tr[data-contract-id]').forEach(row=>{
        row.onclick = ()=> setAdminRoute('contractEdit', { id: row.getAttribute('data-contract-id') });
      });
      upcomingEl.querySelectorAll('[data-attendees-idx]').forEach(cell=>{
        cell.onclick = (e)=>{ e.stopPropagation(); showAttendeesPopup(Number(cell.getAttribute('data-attendees-idx'))); };
      });
    }
    if (arrangoereEl) {
      const arr = d.arrangoere || [];
      if (!arr.length){
        arrangoereEl.innerHTML = '<div class="empty">Ingen arrangører endnu.</div>';
      } else {
        arrangoereEl.innerHTML = arr.map((a,idx) => `
          <div class="clickable" data-arrangoer-idx="${idx}"
            style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--ink-line-soft);gap:10px">
            <div>
              <div style="font-size:14px;color:var(--cream)">${escapeHtml(a.name)}</div>
              <div class="mono" style="font-size:10px;color:var(--cream-mute);margin-top:2px">
                Senest ${a.lastDate ? fmtDate(a.lastDate) : '—'}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div class="mono" style="font-size:12px;color:var(--accent)">${a.count} kontrakt${a.count!==1?'er':''}</div>
              <div class="mono" style="font-size:10px;color:var(--cream-mute)">${fmtMoney(a.honorar)}</div>
            </div>
          </div>`).join('');
        arrangoereEl.querySelectorAll('[data-arrangoer-idx]').forEach(el=>{
          el.onclick = ()=>{
            ADMIN_STATE.contractSearch = arr[Number(el.getAttribute('data-arrangoer-idx'))].name;
            setAdminRoute('contracts');
          };
        });
      }
    }
  } catch(e){ toast(e.message,'err'); }
}

function showAttendeesPopup(idx){
  const c = (CACHE.dashboard && CACHE.dashboard.upcoming && CACHE.dashboard.upcoming[idx]);
  if (!c) return;
  const atts = c.attendees || [];
  const head = document.getElementById('attendeesPopupHead');
  const body = document.getElementById('attendeesPopupBody');
  head.innerHTML = `
    <div class="eyebrow warm">${escapeHtml(c.type||'')} · ${fmtDate(c.date)}</div>
    <h3 style="font-family:var(--font-display);font-size:22px;margin:6px 0 4px;font-weight:400">${escapeHtml((c.venue&&c.venue.name)||'—')}</h3>
    <div class="muted" style="font-size:12px">${escapeHtml((c.venue&&c.venue.city)||'')}</div>
  `;
  if (!atts.length){
    body.innerHTML = `<div class="muted" style="text-align:center;padding:14px">Ingen besætning tilknyttet endnu.</div>
      <div style="text-align:center"><button class="btn btn-ghost btn-sm" data-edit-contract>Rediger kontrakt →</button></div>`;
  } else {
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:8px 12px;background:rgba(8,17,31,.4);border-radius:var(--radius);border:1px solid var(--ink-line)">
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--cream-mute)">Tilmeldt</div>
        <div style="font-family:var(--font-mono);font-size:14px;color:var(--cream)">${atts.length} pers.</div>
      </div>
      ${atts.map(m => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--ink-line-soft)">
          <div class="avatar" style="width:32px;height:32px;font-size:12px">${initials(m.name)}</div>
          <div style="flex:1">
            <div style="font-size:14px;color:var(--cream)">${escapeHtml(m.name)}</div>
            <div class="mono" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--cream-mute)">${escapeHtml(m.category||'')}${m.instrument?' · '+escapeHtml(m.instrument):''}</div>
          </div>
        </div>`).join('')}
      <div style="text-align:right;margin-top:14px"><button class="btn btn-ghost btn-sm" data-edit-contract>Rediger →</button></div>
    `;
  }
  body.querySelectorAll('[data-edit-contract]').forEach(btn=>{
    btn.onclick = ()=>{ closeAttendeesPopup(); setAdminRoute('contractEdit', { id: c.id }); };
  });
  document.getElementById('attendeesPopup').style.display = 'flex';
}

function closeAttendeesPopup(){
  document.getElementById('attendeesPopup').style.display = 'none';
}

function statusBadge(s){
  if (s === 'godkendt') return '<span class="badge ok"><span class="badge-dot"></span>Godkendt</span>';
  if (s === 'afventer') return '<span class="badge warn"><span class="badge-dot"></span>Afventer</span>';
  return '<span class="badge mute"><span class="badge-dot"></span>Udkast</span>';
}

