// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ── Contracts list ─────────────────────────────────────────────
async function renderContractsList(){
  const main = document.getElementById('adminMain');
  const s = ADMIN_STATE;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="serif">Kontrakter</h1>
        <div class="lede">Alle bookings.</div>
      </div>
      <button class="btn btn-primary" onclick="setAdminRoute('contractEdit',{id:'new'})">+ Ny kontrakt</button>
    </div>

    <!-- Status pills -->
    <div class="filter-bar" style="margin-bottom:10px">
      <div class="filter-pill" id="contractTimeframeFilter">
        ${[['kommende','Kommende'],['tidligere','Arkiv'],['alle','Alle']].map(([f,label])=>`<button data-tf="${f}" class="${s.contractTimeframe===f?'on':''}">${label}</button>`).join('')}
      </div>
      <div class="filter-pill" id="contractFilter">
        ${['alle','udkast','afventer','godkendt'].map(f=>`<button data-f="${f}" class="${s.contractFilter===f?'on':''}">${f==='alle'?'Alle statuser':f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
      </div>
      <div class="filter-pill" id="contractTypeFilter">
        ${['alle','Spillested','Festival'].map(f=>`<button data-t="${f}" class="${s.contractType===f?'on':''}">${f==='alle'?'Alle typer':f}</button>`).join('')}
      </div>
    </div>

    <!-- Text filters row -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
      <input id="contractSearch" class="input" style="flex:1;min-width:180px;max-width:240px" placeholder="Spillested eller by…" value="${escapeHtml(s.contractSearch)}">
      <input id="contractArrangoer" class="input" style="flex:1;min-width:180px;max-width:240px" placeholder="Arrangør…" value="${escapeHtml(s.contractArrangoer)}">
      <input id="contractFra" class="input" type="date" style="width:150px" value="${escapeHtml(s.contractFra)}" title="Dato fra">
      <input id="contractTil" class="input" type="date" style="width:150px" value="${escapeHtml(s.contractTil)}" title="Dato til">
      <input id="contractHonorarMin" class="input" type="number" style="width:110px" placeholder="Min honorar" value="${escapeHtml(String(s.contractHonorarMin))}">
      <input id="contractHonorarMax" class="input" type="number" style="width:110px" placeholder="Max honorar" value="${escapeHtml(String(s.contractHonorarMax))}">
      <button class="btn btn-ghost btn-sm" onclick="clearContractFilters()">✕ Ryd</button>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <div id="contractsTable" class="muted" style="padding:24px"><span class="spinner"></span>Henter...</div>
    </div>
  `;

  document.querySelectorAll('#contractTimeframeFilter button').forEach(b=>{
    b.onclick = ()=>{ ADMIN_STATE.contractTimeframe = b.getAttribute('data-tf'); drawContractsTable(); };
  });
  document.querySelectorAll('#contractFilter button').forEach(b=>{
    b.onclick = ()=>{ ADMIN_STATE.contractFilter = b.getAttribute('data-f'); drawContractsTable(); };
  });
  document.querySelectorAll('#contractTypeFilter button').forEach(b=>{
    b.onclick = ()=>{ ADMIN_STATE.contractType = b.getAttribute('data-t'); drawContractsTable(); };
  });
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.oninput = ()=>{ ADMIN_STATE[key] = el.value; drawContractsTable(); };
  };
  bind('contractSearch',      'contractSearch');
  bind('contractArrangoer',   'contractArrangoer');
  bind('contractFra',         'contractFra');
  bind('contractTil',         'contractTil');
  bind('contractHonorarMin',  'contractHonorarMin');
  bind('contractHonorarMax',  'contractHonorarMax');

  if (CACHE.contracts && cacheFresh('contracts')) {
    drawContractsTable();
    return;
  }
  try {
    const d = await apiGet('getContracts');
    if (!document.getElementById('contractsTable')) return;
    if (!d.ok){ _failInto('contractsTable', d.error || 'Kunne ikke hente kontrakter', 'renderContractsList()'); return; }
    CACHE.contracts = d.contracts; cacheTouch('contracts');
    drawContractsTable();
  } catch(e){ _failInto('contractsTable', e.message, 'renderContractsList()'); }
}

function clearContractFilters(){
  ADMIN_STATE.contractTimeframe = 'kommende';
  ADMIN_STATE.contractFilter   = 'alle';
  ADMIN_STATE.contractType     = 'alle';
  ADMIN_STATE.contractSearch   = '';
  ADMIN_STATE.contractArrangoer= '';
  ADMIN_STATE.contractFra      = '';
  ADMIN_STATE.contractTil      = '';
  ADMIN_STATE.contractHonorarMin = '';
  ADMIN_STATE.contractHonorarMax = '';
  renderContractsList();
}

async function quickChangeStatus(contractId, newStatus){
  const c = (CACHE.contracts||[]).find(x=>String(x.id)===String(contractId));
  if (!c){ toast('Ikke fundet','err'); return; }
  const prev = c.status;
  c.status = newStatus;
  try {
    const d = await apiPost('changeContractStatus', { id: contractId, status: newStatus });
    if (!d.ok){ c.status = prev; toast(d.error||'Fejl','err'); drawContractsTable(); return; }
    toast('Status opdateret');
  } catch(e){ c.status = prev; toast(e.message,'err'); drawContractsTable(); }
}

function drawContractsTable(){
  const wrap = document.getElementById('contractsTable');
  if (!wrap || !CACHE.contracts) return;
  const s = ADMIN_STATE;
  let rows = CACHE.contracts.slice();

  // Timeframe filter: kommende (>=today eller uden dato) / tidligere (<today) / alle
  if (s.contractTimeframe !== 'alle'){
    const today = new Date(); today.setHours(0,0,0,0);
    rows = rows.filter(c => {
      if (!c.date) return s.contractTimeframe === 'kommende';
      const d = new Date(c.date); d.setHours(0,0,0,0);
      return s.contractTimeframe === 'kommende' ? d >= today : d < today;
    });
  }

  if (s.contractFilter !== 'alle')
    rows = rows.filter(c => c.status === s.contractFilter);
  if (s.contractType !== 'alle')
    rows = rows.filter(c => c.type === s.contractType);

  const q = s.contractSearch.toLowerCase().trim();
  if (q) rows = rows.filter(c =>
    ((c.venue&&c.venue.name)||'').toLowerCase().includes(q) ||
    ((c.venue&&c.venue.city)||'').toLowerCase().includes(q));

  const aq = s.contractArrangoer.toLowerCase().trim();
  if (aq) rows = rows.filter(c =>
    ((c.arrangoer&&c.arrangoer.name)||'').toLowerCase().includes(aq));

  if (s.contractFra) rows = rows.filter(c => c.date && c.date >= s.contractFra);
  if (s.contractTil) rows = rows.filter(c => c.date && c.date <= s.contractTil);
  if (s.contractHonorarMin !== '') rows = rows.filter(c => (c.honorar||0) >= Number(s.contractHonorarMin));
  if (s.contractHonorarMax !== '') rows = rows.filter(c => (c.honorar||0) <= Number(s.contractHonorarMax));

  rows.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));

  // update filter pills to reflect current state
  document.querySelectorAll('#contractTimeframeFilter button').forEach(b=>
    b.classList.toggle('on', b.getAttribute('data-tf') === s.contractTimeframe));
  document.querySelectorAll('#contractFilter button').forEach(b=>
    b.classList.toggle('on', b.getAttribute('data-f') === s.contractFilter));
  document.querySelectorAll('#contractTypeFilter button').forEach(b=>
    b.classList.toggle('on', b.getAttribute('data-t') === s.contractType));
  if (!rows.length){
    wrap.innerHTML = '<div class="empty">Ingen kontrakter matcher.</div>';
    return;
  }
  const activeFilters = [s.contractFilter!=='alle', s.contractType!=='alle', s.contractSearch, s.contractArrangoer, s.contractFra, s.contractTil, s.contractHonorarMin!=='', s.contractHonorarMax!==''].filter(Boolean).length;
  wrap.innerHTML = `
    ${activeFilters ? `<div style="padding:10px 16px;font-family:var(--font-mono);font-size:11px;color:var(--cream-mute);border-bottom:1px solid var(--ink-line-soft)">${rows.length} kontrakt${rows.length!==1?'er':''} · ${activeFilters} filter${activeFilters!==1?'e':''} aktiv${activeFilters!==1?'e':''}</div>` : ''}
    <table class="table">
      <thead><tr><th>Nr</th><th>Spillested</th><th>Arrangør</th><th>Dato</th><th>Type</th><th style="text-align:right">Honorar</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(c=>`
          <tr class="clickable" onclick="setAdminRoute('contractEdit',{id:'${escapeHtml(c.id)}'})">
            <td class="mono muted">${escapeHtml(c.id)}</td>
            <td><span class="serif" style="font-size:16px">${escapeHtml((c.venue&&c.venue.name)||'—')}</span> <span class="muted">· ${escapeHtml((c.venue&&c.venue.city)||'')}</span></td>
            <td><span class="muted" style="font-size:13px">${escapeHtml((c.arrangoer&&c.arrangoer.name)||'—')}</span></td>
            <td class="mono" style="color:var(--accent)">${fmtDate(c.date)}</td>
            <td>${escapeHtml(c.type||'')}</td>
            <td style="text-align:right" class="mono">${fmtMoney(c.honorar)}</td>
            <td onclick="event.stopPropagation()">
              <select class="select" style="padding:4px 8px;font-size:12px;width:auto" onchange="quickChangeStatus('${escapeHtml(c.id)}',this.value)">
                <option value="udkast"${c.status==='udkast'?' selected':''}>Udkast</option>
                <option value="afventer"${c.status==='afventer'?' selected':''}>Afventer</option>
                <option value="godkendt"${c.status==='godkendt'?' selected':''}>Godkendt</option>
              </select>
            </td>
            <td class="muted">→</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Contract editor ────────────────────────────────────────────
let EDITING = null; // contract draft
let EDITING_ATTENDEES = []; // [{memberId, share}]

// Festival-sceneplan: lazy-loades én gang pr. session (kun admins der redigerer
// kontrakter har brug for billedet — derfor ikke i boot-config).
let SCENEPLAN_DATA_URL = null;   // data-URL når hentet
let SCENEPLAN_FETCHED = false;   // har vi forsøgt at hente?

async function ensureSceneplan(){
  if (SCENEPLAN_FETCHED) return;
  SCENEPLAN_FETCHED = true;
  if (!BAND_CONFIG.hasSceneplan) return; // intet uploadet — preview viser placeholder
  try {
    const d = await apiGet('getSceneplan');
    if (d && d.ok && d.dataUrl){
      SCENEPLAN_DATA_URL = d.dataUrl;
      if (EDITING) drawPreview(); // re-render hvis kontrakt-editor stadig er åben
    }
  } catch(e){ /* preview falder tilbage til placeholder */ }
}

// Rider-PDF: hvis bandet har uploadet en færdig rider-PDF, erstatter den de
// genererede rider-sider (2,3,4) i kontrakten. PDF'en kan ikke flettes direkte
// ind i en browser-genereret PDF, så vi renderer hver side til et billede med
// PDF.js og indlejrer dem som fuld-sides billeder.
let RIDER_PDF_PAGES = null;   // [dataUrl, …] når renderet
let RIDER_PDF_FETCHED = false;
let _pdfjsPromise = null;
const PDFJS_VERSION = '3.11.174';

function _loadPdfJs(){
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION + '/pdf.min.js';
    s.onload = ()=>{
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION + '/pdf.worker.min.js'; } catch(e){}
      resolve(window.pdfjsLib);
    };
    s.onerror = ()=> reject(new Error('Kunne ikke loade PDF.js'));
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

async function ensureRiderPdf(){
  if (RIDER_PDF_FETCHED) return;
  RIDER_PDF_FETCHED = true;
  if (!BAND_CONFIG.hasRiderPdf) return; // ingen rider-PDF — skabelonerne bruges
  try {
    const d = await apiGet('getRider');
    if (!d || !d.ok || d.kind !== 'pdf' || !d.dataUrl) return;
    const pdfjsLib = await _loadPdfJs();
    const b64 = d.dataUrl.split(',')[1] || '';
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++){
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      pages.push(canvas.toDataURL('image/jpeg', 0.85));
    }
    RIDER_PDF_PAGES = pages;
    if (EDITING) drawPreview(); // re-render kontrakten med de indlejrede PDF-sider
  } catch(e){ console.warn('Rider-PDF kunne ikke renderes:', e.message); }
}

async function renderContractEditor(id){
  const main = document.getElementById('adminMain');
  main.innerHTML = '<div class="muted"><span class="spinner"></span>Henter kontrakt...</div>';
  // Load members for attendee picker
  if (!CACHE.members || !cacheFresh('members')){
    try { const d = await apiGet('getMembers'); if (d.ok){ CACHE.members = d.members; cacheTouch('members'); } }
    catch(e){ toast('Kunne ikke hente medlemmer: '+(e.message||e),'err'); }
  }
  ensureSceneplan(); // prefetch festival-sceneplan (no-op hvis allerede hentet/ingen)
  ensureRiderPdf();  // prefetch + render rider-PDF override (no-op hvis ingen)
  if (id === 'new'){
    EDITING = blankContract();
    EDITING_ATTENDEES = [];
    drawContractEditor();
  } else {
    try {
      const d = await apiGet('getContract', { id: id });
      if (!d.ok){ _failInto('adminMain', d.error || 'Kunne ikke hente kontrakten', `renderContractEditor('${escapeHtml(String(id))}')`); return; }
      EDITING = d.contract;
      EDITING._originalId = d.contract.id;
      EDITING._loadedAt = d.contract.updatedAt || ''; // til conflict detection ved save
      EDITING_ATTENDEES = (d.attendees || []).map(a => ({ memberId: a.memberId, share: Number(a.share)||0 }));
      drawContractEditor();
    } catch(e){ _failInto('adminMain', e.message, `renderContractEditor('${escapeHtml(String(id))}')`); }
  }
}

function blankContract(){
  return {
    id:'', type:'Spillested', status:'udkast',
    arrangoer:{ name:'', address:'', postnr:'', city:'', contactName:'', phone:'', email:'', cvr:'' },
    venue:{ name:'', address:'', postnr:'', city:'' },
    date:'', getIn:'', soundcheck:'', showtimeFrom:'', showtimeTo:'',
    sets:2, setMinutes:45, musicianCount:5, crewCount:1, guestCount:6,
    honorar:0, paymentTerms:'Bankoverførsel 1 hverdag efter arrangementet', paymentTermsOther:'', notes:''
  };
}

function drawContractEditor(){
  const main = document.getElementById('adminMain');
  const isNew = !EDITING.id;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow warm">${isNew ? 'Ny kontrakt' : 'Kontrakt ' + escapeHtml(EDITING.id)}</div>
        <h1 class="serif">${escapeHtml(EDITING.venue.name || 'Uden spillested')}</h1>
      </div>
      <div class="flex">
        <button class="btn btn-ghost" onclick="setAdminRoute('contracts')">← Tilbage</button>
        ${isNew ? '' : '<button class="btn btn-ghost" onclick="copyContract()">Kopier</button>'}
        ${isNew ? '' : '<button class="btn btn-ghost btn-sm" onclick="downloadContractPDF()">↓ PDF med Rider</button>'}
        ${isNew ? '' : '<button class="btn btn-ghost btn-sm" onclick="downloadContractOverviewPDF()">↓ PDF uden Rider</button>'}
        ${isNew ? '' : '<button class="btn btn-ghost btn-sm" onclick="downloadFakturaPDF()">↓ Honorarafregning</button>'}
        ${isNew ? '' : '<button class="btn btn-danger btn-sm" onclick="deleteContract()">Slet</button>'}
        <button class="btn btn-primary" onclick="saveContract()">Gem</button>
      </div>
    </div>
    <div class="contract-split">
      <div class="contract-form" id="cForm"></div>
      <div class="contract-preview" id="cPreview"></div>
    </div>
  `;
  drawForm();
  drawPreview();
}

const PAYMENT_TERMS_OPTIONS = [
  'Kontant efter optræden',
  'Bankoverførsel 1 hverdag efter arrangementet',
  'Senest 3 dage før',
  'Andet'
];

function drawForm(){
  const c = EDITING;
  if (c.paymentTerms && !PAYMENT_TERMS_OPTIONS.includes(c.paymentTerms)) {
    c.paymentTermsOther = c.paymentTermsOther || c.paymentTerms;
    c.paymentTerms = 'Andet';
  }
  const sec = (n, title, body) => `
    <div class="form-section">
      <div class="form-section-head"><span class="form-section-num mono">${n}</span><h3 class="form-section-title">${title}</h3></div>
      <div class="form-section-body">${body}</div>
    </div>`;

  document.getElementById('cForm').innerHTML =
    sec('01', 'Type kontrakt', `
      <div class="seg">
        <button class="${c.type==='Spillested'?'on':''}" data-type="Spillested">Spillested</button>
        <button class="${c.type==='Festival'?'on':''}" data-type="Festival">Festival</button>
      </div>
      <div class="rider-note">→ ${c.type}-rider vedhæftes automatisk</div>
      <div class="row-2">
        <div class="field"><label>Status</label>
          <select class="select" data-bind="status">
            <option value="udkast"${c.status==='udkast'?' selected':''}>Udkast</option>
            <option value="afventer"${c.status==='afventer'?' selected':''}>Afventer godkendelse</option>
            <option value="godkendt"${c.status==='godkendt'?' selected':''}>Godkendt</option>
          </select>
        </div>
        <div class="field"><label>Kontrakt-nr</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="contractIdInput" data-bind="id" value="${escapeHtml(c.id)}" placeholder="${'fx ' + (BAND_CONFIG.bandShortName || 'BAND') + '-2026-001'}"${c.id ? ' readonly' : ''} style="flex:1${c.id ? ';opacity:.7;cursor:default' : ''}">
            ${c.id ? '<button type="button" class="btn btn-ghost btn-sm" onclick="toggleContractIdEdit()" title="Rediger kontraktnummer" style="padding:0 12px">✎</button>' : ''}
          </div>
        </div>
      </div>
    `) +
    sec('02', 'Arrangør', `
      <div class="row-2">
        <div class="field"><label>Navn</label><input class="input" data-bind="arrangoer.name" value="${escapeHtml(c.arrangoer.name)}"></div>
        <div class="field"><label>Kontaktperson</label><input class="input" data-bind="arrangoer.contactName" value="${escapeHtml(c.arrangoer.contactName)}"></div>
      </div>
      <div class="field"><label>Adresse</label><input class="input" data-bind="arrangoer.address" value="${escapeHtml(c.arrangoer.address)}"></div>
      <div class="row-3">
        <div class="field"><label>Postnr</label><input class="input" data-bind="arrangoer.postnr" value="${escapeHtml(c.arrangoer.postnr)}"></div>
        <div class="field"><label>By</label><input class="input" data-bind="arrangoer.city" value="${escapeHtml(c.arrangoer.city)}"></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Email</label><input class="input" data-bind="arrangoer.email" value="${escapeHtml(c.arrangoer.email)}"></div>
        <div class="field"><label>Telefon</label><input class="input" data-bind="arrangoer.phone" value="${escapeHtml(c.arrangoer.phone)}"></div>
      </div>
    `) +
    sec('03', 'Spillested', `
      <div class="field"><label>Navn</label><input class="input" data-bind="venue.name" value="${escapeHtml(c.venue.name)}"></div>
      <div class="field"><label>Adresse</label><input class="input" data-bind="venue.address" value="${escapeHtml(c.venue.address)}"></div>
      <div class="row-2">
        <div class="field"><label>Postnr</label><input class="input" data-bind="venue.postnr" value="${escapeHtml(c.venue.postnr)}"></div>
        <div class="field"><label>By</label><input class="input" data-bind="venue.city" value="${escapeHtml(c.venue.city)}"></div>
      </div>
    `) +
    sec('04', 'Tidspunkter', `
      <div class="row-2">
        <div class="field"><label>Dato</label><input class="input" type="date" data-bind="date" value="${escapeHtml(toDateInput(c.date))}"></div>
        <div class="field"><label>Get-in</label><input class="input" data-bind="getIn" value="${escapeHtml(c.getIn)}" placeholder="kl. 16.00"></div>
      </div>
      <div class="row-3">
        <div class="field"><label>Lydprøve færdig kl.</label><input class="input" data-bind="soundcheck" value="${escapeHtml(c.soundcheck)}" placeholder="kl. 18.00"></div>
        <div class="field"><label>Spilletid fra</label><input class="input" data-bind="showtimeFrom" value="${escapeHtml(c.showtimeFrom)}" placeholder="kl. 21.00"></div>
        <div class="field"><label>Spilletid til</label><input class="input" data-bind="showtimeTo" value="${escapeHtml(c.showtimeTo)}" placeholder="kl. 23.00"></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Antal sæt</label><input class="input" type="number" data-bind="sets" value="${c.sets}"></div>
        <div class="field"><label>Sæt-længde (min)</label><input class="input" type="number" data-bind="setMinutes" value="${c.setMinutes}"></div>
      </div>
    `) +
    sec('05', 'Honorar', `
      <div class="row-2">
        <div class="field"><label>Total honorar (kr)</label><div style="display:flex;gap:8px"><input class="input" type="number" data-bind="honorar" value="${c.honorar}" style="flex:1"><button class="btn btn-ghost" type="button" onclick="openHonorarCalc()" title="Fordel honorar" style="padding:10px 13px;font-size:17px;flex-shrink:0">🧮</button></div></div>
        <div class="field"><label>Betalingsbetingelse</label>
          <select class="select" data-bind="paymentTerms">
            ${PAYMENT_TERMS_OPTIONS.map(opt =>
              `<option value="${opt}"${c.paymentTerms===opt?' selected':''}>${opt}</option>`).join('')}
          </select>
        </div>
      </div>
      ${c.paymentTerms==='Andet' ? `<div class="field"><label>Specificér</label><input class="input" data-bind="paymentTermsOther" value="${escapeHtml(c.paymentTermsOther)}"></div>` : ''}
      <div class="eyebrow" style="margin-top:10px;margin-bottom:6px">Auto-fordeling pr. kategori</div>
      <div class="row-3" style="margin-bottom:8px">
        <div class="field"><label>Rate Musiker (kr)</label><input class="input" type="number" id="rateMusiker" value="${EDITING._rateMusiker||0}"></div>
        <div class="field"><label>Rate Afløser (kr)</label><input class="input" type="number" id="rateAfloser" value="${EDITING._rateAfloser||0}"></div>
        <div class="field"><label>Rate Crew (kr)</label><input class="input" type="number" id="rateCrew" value="${EDITING._rateCrew||0}"></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="autoDistBtn" type="button" style="margin-bottom:10px">⟳ Auto-fordel honorar på besætning</button>
      <div class="field"><label>Noter</label><textarea class="textarea" data-bind="notes">${escapeHtml(c.notes)}</textarea></div>
    `) +
    sec('06', 'Besætning', `
      <div class="row-3">
        <div class="field"><label>Antal musikere</label><input class="input" type="number" data-bind="musicianCount" value="${c.musicianCount}"></div>
        <div class="field"><label>Antal crew</label><input class="input" type="number" data-bind="crewCount" value="${c.crewCount}"></div>
        <div class="field"><label>Gæsteliste (max 10)</label><input class="input" type="number" data-bind="guestCount" value="${c.guestCount}"></div>
      </div>
      <div class="eyebrow" style="margin-top:6px">Vælg medlemmer på dette job</div>
      <div class="attendees-grid" id="attendeesGrid">${renderAttendeesPicker()}</div>
    `);

  // Bind type pill
  document.querySelectorAll('#cForm .seg button').forEach(b=>{
    b.onclick = ()=>{ EDITING.type = b.getAttribute('data-type'); drawForm(); drawPreview(); };
  });
  // Bind inputs
  document.querySelectorAll('#cForm [data-bind]').forEach(el=>{
    el.addEventListener('input', ()=>{
      const path = el.getAttribute('data-bind');
      let v = el.type === 'number' ? Number(el.value) : el.value;
      setPath(EDITING, path, v);
      drawPreview();
    });
    el.addEventListener('change', ()=>{
      // selects fire 'change' reliably; also handles paymentTerms re-render
      const path = el.getAttribute('data-bind');
      let v = el.type === 'number' ? Number(el.value) : el.value;
      setPath(EDITING, path, v);
      drawPreview();
      if (path === 'paymentTerms') drawForm();
    });
  });
  // Bind attendee chips
  document.querySelectorAll('#attendeesGrid .attend-chip').forEach(chip=>{
    chip.onclick = (e)=>{
      if (e.target.tagName === 'INPUT') return;
      const mid = chip.getAttribute('data-mid');
      const idx = EDITING_ATTENDEES.findIndex(a => a.memberId === mid);
      if (idx >= 0) EDITING_ATTENDEES.splice(idx,1);
      else EDITING_ATTENDEES.push({ memberId: mid, share: 0 });
      drawForm(); drawPreview();
    };
  });
  document.querySelectorAll('#attendeesGrid .chip-share input').forEach(inp=>{
    inp.oninput = ()=>{
      const mid = inp.getAttribute('data-mid');
      const a = EDITING_ATTENDEES.find(x=>x.memberId===mid);
      if (a){ a.share = Number(inp.value)||0; drawPreview(); }
    };
  });
  // Bind rate fields
  ['rateMusiker','rateAfloser','rateCrew'].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.oninput = ()=>{ EDITING['_'+id] = Number(el.value)||0; };
  });
  const autoDistBtn = document.getElementById('autoDistBtn');
  if (autoDistBtn) autoDistBtn.onclick = autoDistributeHonorar;
}

