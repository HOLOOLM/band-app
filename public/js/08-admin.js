// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ─── Admin honorar ────────────────────────────────────────────────

async function renderAdminHonorar(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Honorar</h1>
        <div class="lede">Vis og download honoraroversigt for et enkelt medlem.</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="eyebrow warm" style="margin-bottom:14px">Vælg periode og medlem</div>
      <div class="row-3" style="margin-bottom:16px">
        <div class="field"><label>Fra</label><input id="ahFra" class="input" type="date" value="${new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10)}"></div>
        <div class="field"><label>Til</label><input id="ahTil" class="input" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="field"><label>Medlem</label>
          <select id="ahMember" class="select"><option value="">Henter...</option></select>
        </div>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" onclick="adminVisHonorar()">Vis oversigt</button>
        <button class="btn btn-ghost" id="ahDownloadBtn" style="display:none" onclick="adminDownloadHonorar()">↓ Download PDF</button>
      </div>
    </div>
    <div id="ahResult"></div>
  `;
  if (!CACHE.members || !cacheFresh('members')){
    try { const d = await apiGet('getMembers'); if(d.ok){ CACHE.members = d.members; cacheTouch('members'); } }
    catch(e){ toast('Kunne ikke hente medlemmer','err'); }
  }
  const sel = document.getElementById('ahMember');
  if (!sel) return;
  if (CACHE.members && CACHE.members.length){
    sel.innerHTML = CACHE.members.map(m=>`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} · ${escapeHtml(m.category||'')}</option>`).join('');
  } else {
    sel.innerHTML = '<option value="">Ingen medlemmer</option>';
  }
}

async function adminVisHonorar(){
  const mid = document.getElementById('ahMember').value;
  const fra = document.getElementById('ahFra').value;
  const til = document.getElementById('ahTil').value;
  if (!mid){ toast('Vælg et medlem','err'); return; }
  const resultEl = document.getElementById('ahResult');
  const dlBtn = document.getElementById('ahDownloadBtn');
  resultEl.innerHTML = '<div class="muted"><span class="spinner"></span>Henter...</div>';
  if (dlBtn) dlBtn.style.display = 'none';
  try {
    const d = await apiPost('getHonorarAdmin', { memberId: mid, fra, til });
    if (!document.getElementById('ahResult')) return;
    if (!d.ok){ resultEl.innerHTML = _errBox(d.error || 'Kunne ikke hente honorar', 'adminVisHonorar()'); return; }
    window._lastAdminHonorar = { rows: d.rows, total: d.total, totalKm: d.totalKm, member: d.member, fra, til };
    if (!d.rows.length){
      resultEl.innerHTML = '<div class="card"><div class="empty">Ingen jobs i den valgte periode.</div></div>';
      return;
    }
    if (dlBtn) dlBtn.style.display = '';
    resultEl.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div>
            <div class="eyebrow warm">Honoraroversigt</div>
            <h2 class="serif" style="margin:4px 0 0;font-weight:400;font-size:24px">${escapeHtml(d.member.name)}</h2>
            <div class="muted" style="font-size:13px;margin-top:2px">Periode: ${fmtDate(fra)} – ${fmtDate(til)}</div>
          </div>
          <div style="display:flex;gap:10px">
            <div class="stat-tile" style="text-align:right;min-width:120px">
              <div class="label">Total km</div>
              <div class="value">${escapeHtml(_kmLabel(d.totalKm)||'—')}</div>
            </div>
            <div class="stat-tile" style="text-align:right;min-width:160px">
              <div class="label">Total</div>
              <div class="value warm">${fmtMoney(d.total)}</div>
            </div>
          </div>
        </div>
        <table class="table">
          <thead><tr>
            <th>Dato</th>
            <th>Spillested</th>
            <th>Type</th>
            <th style="text-align:right">Km</th>
            <th style="text-align:right">Andel</th>
            <th>Status</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${d.rows.map((r,idx) => {
              const venue = r.venue || {};
              const times = [r.getIn&&(r.getIn+' get-in'), r.soundcheck&&(r.soundcheck+' lydprøve'), (r.showtimeFrom||r.showtimeTo)&&([r.showtimeFrom,r.showtimeTo].filter(Boolean).join('–'))].filter(Boolean).join(' · ');
              const crew = (r.besaetning||[]).join(', ');
              return `<tr>
                <td class="mono" style="color:var(--accent);white-space:nowrap">${fmtDate(r.date)}</td>
                <td>
                  <span class="serif" style="font-size:15px">${escapeHtml(venue.name||'—')}</span>
                  <span class="muted"> · ${escapeHtml(venue.city||'')}</span>
                  ${times?`<div style="font-size:11px;color:var(--cream-mute);margin-top:2px">${escapeHtml(times)}</div>`:''}
                  ${crew?`<div style="font-size:11px;color:var(--cream-mute)">${escapeHtml(crew)}</div>`:''}
                </td>
                <td>${escapeHtml(r.type||'')}</td>
                <td style="text-align:right" class="mono">${escapeHtml(_kmLabel(r.distanceKm)||'—')}</td>
                <td style="text-align:right" class="mono">${fmtMoney(r.share)}</td>
                <td>${statusBadge(r.status)}</td>
                <td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="adminDownloadHonorarRow(${idx})">↓ PDF</button></td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid var(--ink-line)">
              <td colspan="3" style="padding:12px;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--cream-mute)">Total</td>
              <td style="padding:12px;text-align:right;font-family:var(--font-mono);font-size:13px;color:var(--cream-mute)">${escapeHtml(_kmLabel(d.totalKm)||'—')}</td>
              <td style="padding:12px;text-align:right;font-family:var(--font-mono);font-size:16px;color:var(--accent)">${fmtMoney(d.total)}</td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  } catch(e){ const r = document.getElementById('ahResult'); if (r) r.innerHTML = _errBox(e.message, 'adminVisHonorar()'); }
}

// ─── Indstillinger ────────────────────────────────────────────────

async function renderAdminSettings(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <h1 class="serif">Indstillinger</h1>
    </div>
    <div style="max-width:580px;display:flex;flex-direction:column;gap:24px;padding-bottom:48px">

      <div class="card" style="padding:24px">
        <div class="eyebrow" style="margin-bottom:18px">Udseende</div>
        <div style="margin-bottom:20px">
          <div class="muted" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">Tema</div>
          <div id="set_themeGrid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px"></div>
        </div>
        <div style="margin-bottom:20px">
          <div class="muted" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">Accentfarve</div>
          <div style="display:flex;gap:10px;align-items:center">
            <input type="color" id="set_accentColor" style="width:44px;height:36px;border:1px solid var(--ink-line);border-radius:var(--radius-sm);cursor:pointer;background:transparent;padding:2px">
            <span id="set_accentHex" class="mono" style="font-size:13px;color:var(--cream-mute)"></span>
            <button class="btn btn-ghost btn-sm" onclick="_resetAccentToDefault()" style="margin-left:auto">Nulstil farve</button>
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveAppearance()">Gem udseende</button>
      </div>

      <div class="card" style="padding:24px">
        <div class="eyebrow" style="margin-bottom:16px">Faktureringsoplysninger</div>
        <p class="muted" style="font-size:13px;margin-bottom:16px">Disse oplysninger vises på honorarafregninger. CPR-nummeret krypteres og gemmes sikkert — det vises aldrig i klartekst.</p>
        <div class="field" style="margin-bottom:12px">
          <label>CPR-nummer</label>
          <input id="set_cpr" class="input" type="password" autocomplete="off" placeholder="DDMMYY-XXXX" style="letter-spacing:.1em">
          <div id="set_cprStatus" class="muted" style="font-size:12px;margin-top:4px"></div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Banknavn</label>
          <input id="set_bankName" class="input" placeholder="f.eks. Danske Bank" value="">
        </div>
        <div class="row-2" style="margin-bottom:16px">
          <div class="field">
            <label>Reg.nr.</label>
            <input id="set_bankReg" class="input" placeholder="1234">
          </div>
          <div class="field">
            <label>Kontonummer</label>
            <input id="set_bankKto" class="input" placeholder="1234567890">
          </div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Kontohaver (navn)</label>
          <input id="set_payeeName" class="input" placeholder="f.eks. Peter Hansen — kan afvige fra kontaktperson">
          <div class="muted" style="font-size:12px;margin-top:4px">Vises som "Kontohaver" på kontrakten og som afsender på honorarafregningen. Tom = bandnavnet bruges.</div>
        </div>
        <div class="field" style="margin-bottom:16px">
          <label>Kontohavers adresse</label>
          <textarea id="set_payeeAddress" class="textarea" rows="2" placeholder="Vejnavn 1&#10;1234 By" style="width:100%"></textarea>
        </div>
        <button class="btn btn-primary" onclick="saveBillingInfo(this)">Gem faktureringsoplysninger</button>
      </div>

      <div class="card" style="padding:24px">
        <div class="eyebrow" style="margin-bottom:12px">Band-info</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <span class="muted" style="width:100px;font-size:13px">Band-ID</span>
          <code class="mono" style="font-size:13px">${escapeHtml(BAND_ID||'')}</code>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="muted" style="width:100px;font-size:13px">Navn</span>
          <span style="font-size:13px">${escapeHtml(_b('bandName'))}</span>
        </div>
      </div>

      <div class="card" style="padding:24px;border:1px solid rgba(192,57,43,.2)">
        <div class="eyebrow" style="margin-bottom:8px;color:var(--danger)">Farezone</div>
        <p class="muted" style="font-size:13px;margin-bottom:16px">Sletter permanent alle data for dette band: sheet, Drive-mapper og faktureringsoplysninger. Handlingen kan ikke fortrydes.</p>
        <button class="btn btn-danger" onclick="confirmDeleteBand()">Slet dette band permanent</button>
      </div>

    </div>`;

  // Byg tema-swatches
  const currentTheme = BAND_CONFIG.theme || DEFAULT_THEME;
  const currentAccent = BAND_CONFIG.primaryColor || '#8A8A8A';
  const grid = document.getElementById('set_themeGrid');
  if (grid) {
    Object.entries(THEMES).forEach(([key, t]) => {
      const isSelected = key === currentTheme;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.themeKey = key;
      btn.style.cssText = `background:${t.inkDeep};border:2px solid ${isSelected ? t.cream : t.inkLine};border-radius:var(--radius);padding:10px 6px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:5px;transition:border-color .15s,transform .1s`;
      btn.innerHTML = `
        <div style="display:flex;gap:4px;margin-bottom:2px">
          <span style="width:14px;height:14px;border-radius:50%;background:${t.ink};display:inline-block;border:1px solid ${t.inkLine}"></span>
          <span style="width:14px;height:14px;border-radius:50%;background:${t.cream};display:inline-block;opacity:.85"></span>
        </div>
        <span style="font-size:9px;color:${t.creamMute};font-family:var(--font-mono);letter-spacing:.05em;text-transform:uppercase">${t.label}</span>`;
      btn.onclick = () => {
        BAND_CONFIG.theme = key;
        _applyThemeVars(key);
        grid.querySelectorAll('button[data-theme-key]').forEach(b => {
          const k = b.dataset.themeKey;
          b.style.borderColor = k === key ? THEMES[k].cream : THEMES[k].inkLine;
        });
      };
      grid.appendChild(btn);
    });
  }

  // Sæt accentfarve-picker
  const colorInput = document.getElementById('set_accentColor');
  const hexLabel   = document.getElementById('set_accentHex');
  if (colorInput) {
    colorInput.value = currentAccent;
    if (hexLabel) hexLabel.textContent = currentAccent.toUpperCase();
    colorInput.oninput = () => {
      const v = colorInput.value;
      if (hexLabel) hexLabel.textContent = v.toUpperCase();
      document.documentElement.style.setProperty('--accent', v);
      document.documentElement.style.setProperty('--accent-soft', _hexLighten(v, 22));
      document.documentElement.style.setProperty('--accent-deep', _hexDarken(v, 22));
    };
  }

  // Hent aktuelle billing-oplysninger
  try {
    const d = await apiPost('adminGetBillingInfo', {});
    if (d && d.ok && d.billing) {
      document.getElementById('set_bankName').value = d.billing.bankName || '';
      document.getElementById('set_bankReg').value  = d.billing.bankReg  || '';
      document.getElementById('set_bankKto').value  = d.billing.bankKto  || '';
      document.getElementById('set_payeeName').value    = d.billing.payeeName    || '';
      document.getElementById('set_payeeAddress').value = d.billing.payeeAddress || '';
      const cprStatus = document.getElementById('set_cprStatus');
      if (cprStatus) cprStatus.textContent = d.billing.hasCpr
        ? 'CPR er gemt og krypteret. Udfyld feltet for at opdatere det.'
        : 'CPR er ikke gemt endnu.';
    }
  } catch(e) { toast(e.message, 'err'); }
}

function _resetAccentToDefault(){
  const t = THEMES[BAND_CONFIG.theme || DEFAULT_THEME];
  const defaultAccent = '#8A8A8A';
  const colorInput = document.getElementById('set_accentColor');
  const hexLabel   = document.getElementById('set_accentHex');
  if (colorInput) colorInput.value = defaultAccent;
  if (hexLabel)   hexLabel.textContent = defaultAccent.toUpperCase();
  document.documentElement.style.setProperty('--accent', defaultAccent);
  document.documentElement.style.setProperty('--accent-soft', _hexLighten(defaultAccent, 22));
  document.documentElement.style.setProperty('--accent-deep', _hexDarken(defaultAccent, 22));
}

async function saveAppearance(){
  const colorInput = document.getElementById('set_accentColor');
  const accent = colorInput ? colorInput.value : (BAND_CONFIG.primaryColor || '#8A8A8A');
  const theme  = BAND_CONFIG.theme || DEFAULT_THEME;
  const soft   = _hexLighten(accent, 22);
  const deep   = _hexDarken(accent, 22);
  try {
    const d = await apiPost('adminSaveAppearance', { theme, primaryColor: accent, primaryColorSoft: soft, primaryColorDeep: deep });
    if (!d.ok) { toast(d.error, 'err'); return; }
    BAND_CONFIG.primaryColor     = accent;
    BAND_CONFIG.primaryColorSoft = soft;
    BAND_CONFIG.primaryColorDeep = deep;
    toast('Udseende gemt');
  } catch(e){ toast(e.message, 'err'); }
}

async function saveBillingInfo(btn){
  const cpr      = document.getElementById('set_cpr').value.trim();
  const bankName = document.getElementById('set_bankName').value.trim();
  const bankReg  = document.getElementById('set_bankReg').value.trim();
  const bankKto  = document.getElementById('set_bankKto').value.trim();
  const payeeName    = document.getElementById('set_payeeName').value.trim();
  const payeeAddress = document.getElementById('set_payeeAddress').value.trim();

  if (cpr && !/^\d{6}-?\d{4}$/.test(cpr)) {
    toast('Ugyldigt CPR-format — brug DDMMYY-XXXX', 'err');
    return;
  }
  const payload = { bankName, bankReg, bankKto, payeeName, payeeAddress };
  if (cpr) payload.cpr = cpr;
  await withBusy(btn, 'Gemmer…', async () => {
    try {
      const d = await apiPost('adminSaveBillingInfo', payload);
      if (!d.ok) { toast(d.error, 'err'); return; }
      // Opdatér lokal BAND_CONFIG så faktura-skabeloner bruger nye værdier
      BAND_CONFIG.bankName = bankName;
      BAND_CONFIG.bankReg  = bankReg;
      BAND_CONFIG.bankKto  = bankKto;
      BAND_CONFIG.payeeName    = payeeName;
      BAND_CONFIG.payeeAddress = payeeAddress;
      document.getElementById('set_cpr').value = '';
      const cprStatus = document.getElementById('set_cprStatus');
      if (cprStatus) cprStatus.textContent = d.hasCpr ? 'CPR er gemt og krypteret.' : '';
      toast('Faktureringsoplysninger gemt');
    } catch(e){ toast(e.message, 'err'); }
  });
}

async function confirmDeleteBand(){
  const bandId = BAND_ID || '';
  const input = prompt(`Dette sletter ALLE data for bandet permanent.\n\nSkriv band-ID'et "${bandId}" for at bekræfte:`);
  if (input === null) return;
  if (input.trim() !== bandId) { toast('Forkert band-ID — sletning annulleret', 'err'); return; }
  try {
    const d = await apiPost('adminDeleteBand', { confirm: bandId });
    if (!d.ok) { toast(d.error, 'err'); return; }
    toast('Band slettet — logger ud');
    setTimeout(() => logout(), 1500);
  } catch(e){ toast(e.message, 'err'); }
}

// ─── Invoice archive (Google Drive) ─────────────────────────────

async function renderInvoicesList(){
  const main = document.getElementById('adminMain');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Honorarafregninger</h1>
        <div class="lede">Arkiv på Google Drive · markér betalt når penge er på kontoen.</div>
      </div>
    </div>
    <div id="invoicesWrap" class="card" style="padding:0">
      <div class="muted" style="padding:24px"><span class="spinner"></span>Henter honorarafregninger…</div>
    </div>
  `;
  let invoices;
  if (CACHE.invoices && cacheFresh('invoices')){
    invoices = CACHE.invoices;
  } else {
    try {
      const d = await apiGet('getInvoices');
      if (!d.ok){ _failInto('invoicesWrap', d.error || 'Kunne ikke hente fakturaer', 'renderInvoicesList()'); return; }
      invoices = d.invoices || [];
      CACHE.invoices = invoices; cacheTouch('invoices');
    } catch(e){ _failInto('invoicesWrap', e.message, 'renderInvoicesList()'); return; }
  }
  drawInvoicesTable(invoices);
}

function drawInvoicesTable(invoices){
  const wrap = document.getElementById('invoicesWrap');
  if (!wrap) return;
  if (!invoices.length){
    wrap.innerHTML = '<div class="empty" style="padding:32px">Ingen honorarafregninger endnu — opret én fra en kontrakt via "↓ Honorarafregning"-knappen.</div>';
    return;
  }
  const totalUdest = invoices.filter(i => i.status === 'udestaaende').reduce((s,i)=>s+(Number(i.amount)||0),0);
  const totalBetalt = invoices.filter(i => i.status === 'betalt').reduce((s,i)=>s+(Number(i.amount)||0),0);
  wrap.innerHTML = `
    <div style="display:flex;gap:14px;padding:18px 22px;border-bottom:1px solid var(--ink-line);flex-wrap:wrap">
      <div class="stat-tile" style="flex:1;min-width:140px"><div class="label">Antal honorarafregninger</div><div class="value">${invoices.length}</div></div>
      <div class="stat-tile" style="flex:1;min-width:140px"><div class="label">Udestående</div><div class="value warm">${fmtMoney(totalUdest)}</div></div>
      <div class="stat-tile" style="flex:1;min-width:140px"><div class="label">Betalt</div><div class="value" style="color:var(--ok)">${fmtMoney(totalBetalt)}</div></div>
    </div>
    <table class="table">
      <thead><tr>
        <th>Afregnings-nr.</th>
        <th>Kontrakt</th>
        <th>Arrangør</th>
        <th>Dato</th>
        <th style="text-align:right">Beløb</th>
        <th>Status</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${invoices.map(i => {
          const arr = i.arrangoer || {};
          const venue = i.venue || {};
          const statusBadge = i.status === 'betalt'
            ? '<span class="badge ok"><span class="badge-dot"></span>Betalt</span>'
            : i.status === 'forsinket'
              ? '<span class="badge" style="color:var(--danger);border-color:rgba(220,90,90,.3)"><span class="badge-dot"></span>Forsinket</span>'
              : '<span class="badge warn"><span class="badge-dot"></span>Udestående</span>';
          const toggle = i.status === 'betalt'
            ? `<button class="btn btn-ghost btn-sm" onclick="setInvoiceStatus('${escapeHtml(i.id)}','udestaaende')">↺ Genåbn</button>`
            : `<button class="btn btn-primary btn-sm" onclick="setInvoiceStatus('${escapeHtml(i.id)}','betalt')">✓ Markér betalt</button>`;
          const contractLink = i.contractId
            ? `<button class="btn btn-text" onclick="setAdminRoute('contractEdit',{id:'${escapeHtml(i.contractId)}'})" style="padding:0;font-size:13px;text-align:left">
                 <span class="serif" style="color:var(--cream)">${escapeHtml(venue.name||'—')}</span>
                 <div class="mono" style="font-size:10px;color:var(--cream-mute);letter-spacing:.06em">#${escapeHtml(i.contractId)} ↗</div>
               </button>`
            : '<span class="muted">—</span>';
          return `<tr>
            <td class="mono" style="color:var(--accent)">${escapeHtml(i.invoiceNr)}</td>
            <td>${contractLink}</td>
            <td>${escapeHtml(arr.name||'—')}</td>
            <td class="mono" style="font-size:12px;color:var(--cream-mute)">${fmtDate(i.date)}</td>
            <td style="text-align:right" class="mono">${fmtMoney(i.amount)}</td>
            <td>${statusBadge}</td>
            <td style="text-align:right;white-space:nowrap">
              ${i.driveUrl
                ? `<a href="${escapeHtml(i.driveUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" style="text-decoration:none">↗ Drive</a>
                   <button class="btn btn-ghost btn-sm" onclick="uploadInvoicePdf('${escapeHtml(i.id)}','${escapeHtml(i.invoiceNr)}')" title="Genopret Drive-arkiv uden CPR">↻ Genopret Drive</button>`
                : `<button class="btn btn-primary btn-sm" onclick="uploadInvoicePdf('${escapeHtml(i.id)}','${escapeHtml(i.invoiceNr)}')" title="Arkiver til Drive uden CPR">☁ Arkivér til Drive</button>`}
              ${toggle}
              <button class="btn btn-danger btn-sm" onclick="deleteInvoice('${escapeHtml(i.id)}','${escapeHtml(i.invoiceNr)}')" title="Slet honorarafregning">🗑</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

/**
 * Arkivér honorarafregning på Drive — uden CPR.
 * Renderer HTML klientside og fjerner CPR-blokke før HTML sendes til server.
 * Server konverterer til PDF og erstatter Drive-filen.
 */
async function uploadInvoicePdf(invoiceId, invoiceNr){
  // Find faktura → kontrakt-id
  const inv = (CACHE.invoices||[]).find(x => String(x.id) === String(invoiceId));
  if (!inv){ toast('Honorarafregning ikke fundet','err'); return; }
  toast(`Arkiverer ${invoiceNr} til Drive…`);
  try {
    const d = await apiPost('getContract', { id: inv.contractId });
    if (!d.ok) throw new Error(d.error||'Kunne ikke hente kontrakt');
    const c = d.contract;
    // Render samme HTML som ved print, men fjern CPR-blokke før upload
    const body = _buildFakturaHtml(c, invoiceNr);
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${pdfPrintStyles()}</style></head><body>${body}</body></html>`;
    // DOM-baseret fjernelse — robust mod markup-ændringer i fakturaskabelonen
    const doc = new DOMParser().parseFromString(fullHtml, 'text/html');
    doc.querySelectorAll('.cpr-block').forEach(el => el.remove());
    // Post-condition: upload aldrig hvis noget CPR-lignende overlevede
    const plainText = (doc.body && doc.body.textContent) || '';
    // Bemærk: ciffer-tjekket kræver bindestreg, ellers ville fx 10-cifrede kontonumre false-positive.
    // Begge .cpr-block-varianter indeholder ordet "CPR", så /cpr/i fanger enhver overlevende blok.
    if (/\d{6}\s?-\s?\d{4}/.test(plainText) || /cpr/i.test(plainText)) {
      throw new Error('CPR-fjernelse fejlede — upload afbrudt af sikkerhedshensyn');
    }
    const stripped = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    const r = await apiPost('archiveInvoiceToDrive', { invoiceId: invoiceId, html: stripped });
    if (!r.ok) throw new Error(r.error||'Drive-fejl');
    cacheBust('invoices'); broadcastInvalidate(['invoices']);
    toast(`${invoiceNr} arkiveret på Drive (uden CPR)`);
    if (r.warning) toast(r.warning, 'err');
    renderInvoicesList();
  } catch(e){ toast('Fejl: '+(e.message||e), 'err'); }
}

function _legacyUploadInvoicePdfDisabled(invoiceId, invoiceNr){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = () => {
    const file = input.files && input.files[0];
    document.body.removeChild(input);
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf'){
      toast('Vælg venligst en PDF-fil','err');
      return;
    }
    if (file.size > 9 * 1024 * 1024){
      toast('Filen er for stor (>9 MB) — Apps Script-grænse','err');
      return;
    }
    toast(`Uploader ${invoiceNr}…`);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      apiPost('uploadInvoicePdf', { id: invoiceId, pdfBase64: base64 })
        .then(d => {
          if (d && d.ok){
            cacheBust('invoices'); broadcastInvalidate(['invoices']);
            toast(`Faktura ${invoiceNr} uploadet til Drive`);
            renderInvoicesList();
          } else {
            toast('Fejl: ' + ((d && d.error) || 'ukendt'), 'err');
          }
        })
        .catch(e => toast('Upload-fejl: ' + (e.message || e), 'err'));
    };
    reader.onerror = () => toast('Kunne ikke læse filen','err');
    reader.readAsDataURL(file);
  };
  input.click();
}

async function deleteInvoice(id, nr){
  if (!confirm(`Slet honorarafregning ${nr}?\n\nDrive-filen flyttes til papirkurv og nummeret frigives — næste nye honorarafregning genbruger det første ledige nummer.`)) return;
  try {
    const d = await apiPost('deleteInvoice', { id: id });
    if (!d.ok){ toast(d.error||'Fejl','err'); return; }
    if (d.warning) toast(d.warning, 'err');
    else toast('Honorarafregning slettet · Drive-fil flyttet til papirkurv');
    cacheBust('invoices'); broadcastInvalidate(['invoices']);
    renderInvoicesList();
  } catch(e){ toast(e.message,'err'); }
}

async function setInvoiceStatus(id, status){
  try {
    const d = await apiPost('updateInvoiceStatus', { id: id, status: status });
    if (!d.ok){ toast(d.error||'Fejl','err'); return; }
    toast(status === 'betalt' ? 'Markeret som betalt' : 'Genåbnet');
    cacheBust('invoices'); broadcastInvalidate(['invoices']);
    renderInvoicesList();
  } catch(e){ toast(e.message,'err'); }
}

async function adminDownloadHonorar(){
  const h = window._lastAdminHonorar;
  if (!h || !h.rows.length){ toast('Tryk "Vis oversigt" først','err'); return; }
  downloadHonorarPDF(h.rows, h.total, h.member, h.fra, h.til, h.totalKm);
}

function adminDownloadHonorarRow(idx){
  const h = window._lastAdminHonorar;
  if (!h || !h.rows[idx]) return;
  const row = h.rows[idx];
  downloadHonorarPDF([row], row.share||0, h.member, row.date, row.date, Number(row.distanceKm)||0);
}

