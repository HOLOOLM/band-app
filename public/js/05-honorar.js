// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ── Honorar calculator ─────────────────────────────────────────
let CALC_METHOD = 'individual';
let CALC_INDIVIDUAL = [];
let CALC_PROVISION_PCT = 20;

function openHonorarCalc(){
  if (!EDITING_ATTENDEES.length){ toast('Vælg besætning i sektion 06 først','err'); return; }
  // Filtrér slettede medlemmer fra (de findes ikke længere i CACHE.members og ville ellers vises som "?")
  const known = new Set((CACHE.members||[]).map(m => m.id));
  const validAttendees = EDITING_ATTENDEES.filter(a => known.has(a.memberId));
  const skipped = EDITING_ATTENDEES.length - validAttendees.length;
  if (skipped > 0) toast(`${skipped} slettet${skipped===1?'':'e'} medlem${skipped===1?'':'mer'} ekskluderet fra fordelingen`);
  CALC_INDIVIDUAL = validAttendees.map(a=>({ memberId: a.memberId, share: a.share||0, excluded: false }));
  CALC_METHOD = 'individual';
  document.getElementById('honorarCalcBackdrop').style.display = 'flex';
  drawCalc();
}

function closeHonorarCalc(){
  document.getElementById('honorarCalcBackdrop').style.display = 'none';
}

function drawCalc(){
  const total = EDITING.honorar || 0;
  const n = CALC_INDIVIDUAL.length;
  const nActive = CALC_INDIVIDUAL.filter(x=>!x.excluded).length;
  const memById = id => (CACHE.members||[]).find(m=>m.id===id);

  const provKr = Math.round(total * (CALC_PROVISION_PCT||0) / 100);
  const sumInd = CALC_INDIVIDUAL.filter(x=>!x.excluded).reduce((s,x)=>s+(x.share||0),0);
  const rest = total - provKr - sumInd;
  const tomCount = CALC_INDIVIDUAL.filter(x => !x.excluded && !((x.share||0) > 0)).length;

  const rows = CALC_INDIVIDUAL.map((ci,i) => {
    const m = memById(ci.memberId);
    const ex = !!ci.excluded;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--ink-line-soft);${ex?'opacity:.45':''}">
      <label title="Inkludér i fordelingen" style="display:flex;align-items:center;cursor:pointer">
        <input type="checkbox" ${ex?'':'checked'} onchange="CALC_INDIVIDUAL[${i}].excluded=!this.checked;drawCalc()" style="margin:0">
      </label>
      <div style="flex:1"><div style="font-size:13px;color:var(--cream);${ex?'text-decoration:line-through':''}">${escapeHtml(m?m.name:'?')}</div>
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cream-mute)">${escapeHtml(m?m.instrument||m.category:'')}${ex?' · ekskluderet':''}</div></div>
      <input type="number" class="input no-spinner" style="width:120px;text-align:right" value="${ci.share||0}" ${ex?'disabled':''}
        oninput="CALC_INDIVIDUAL[${i}].share=Number(this.value)||0;updateCalcDerived()">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--cream-mute);width:20px">kr</span>
    </div>`;
  }).join('');

  document.getElementById('honorarCalcBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;background:color-mix(in srgb, var(--accent) 6%, transparent);border:1px solid color-mix(in srgb, var(--accent) 20%, transparent);border-radius:var(--radius);padding:10px 12px">
      <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);white-space:nowrap">Total honorar</div>
      <input type="number" class="input no-spinner" id="calcTotalInput" value="${total||''}" placeholder="Indtast beløb…"
        style="flex:1;text-align:right;font-family:var(--font-mono);font-size:15px;color:var(--accent);border-color:color-mix(in srgb, var(--accent) 30%, transparent);background:rgba(8,17,31,.4)"
        oninput="EDITING.honorar=Number(this.value)||0;const hb=document.querySelector('#cForm [data-bind=honorar]');if(hb)hb.value=EDITING.honorar;updateCalcDerived()">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--cream-mute)">kr · ${nActive}${nActive!==n?` af ${n}`:''} pers.</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--ink-line-soft)">
      <div style="flex:1"><div style="font-size:13px;color:var(--cream)">Provision</div>
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cream-mute)">Trækkes fra toppen · <span class="calc-prov-kr">${provKr.toLocaleString('da-DK')}</span> kr</div></div>
      <input type="number" class="input no-spinner" style="width:90px;text-align:right" step="0.1" value="${CALC_PROVISION_PCT||0}"
        oninput="CALC_PROVISION_PCT=Number(this.value)||0;updateCalcDerived()">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--cream-mute);width:20px">%</span>
    </div>
    <div style="margin:10px 0 4px;font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--cream-mute)">Mandskab</div>
    ${rows}
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:10px">
      <button class="btn btn-ghost btn-sm" type="button" onclick="distributeRest()">⟳ Fordel resten ligeligt</button>
      <div id="calcSumLine" style="font-family:var(--font-mono);font-size:11px;text-align:right;color:${Math.abs(rest)<1?'var(--ok)':(rest<0?'var(--danger)':'var(--cream-mute)')}">
        Sum mandskab: ${sumInd.toLocaleString('da-DK')} kr · Provision ${provKr.toLocaleString('da-DK')} kr · Rest ${rest.toLocaleString('da-DK')} kr${tomCount?` · ${tomCount} tom`:''}
      </div>
    </div>
  `;
}

function distributeRest(){
  const total = EDITING.honorar || 0;
  const provKr = Math.round(total * (CALC_PROVISION_PCT||0) / 100);
  const aktive = CALC_INDIVIDUAL.filter(x => !x.excluded);
  const fyldt = aktive.filter(x => (x.share||0) > 0);
  const tomme = aktive.filter(x => !((x.share||0) > 0));
  const rest = total - provKr - fyldt.reduce((s,x)=>s+(x.share||0),0);
  if (tomme.length === 0){ toast('Ingen tomme felter at fordele til','err'); return; }
  if (rest <= 0){ toast('Intet rest at fordele','err'); return; }
  const base = Math.floor(rest / tomme.length);
  const rem = rest - base * tomme.length;
  tomme.forEach((x,i) => { x.share = base + (i < rem ? 1 : 0); });
  drawCalc();
}

function updateCalcDerived(){
  const total = EDITING.honorar || 0;
  const provKr = Math.round(total * (CALC_PROVISION_PCT||0) / 100);
  const sumInd = CALC_INDIVIDUAL.filter(x=>!x.excluded).reduce((s,x)=>s+(x.share||0),0);
  const rest = total - provKr - sumInd;
  const tomCount = CALC_INDIVIDUAL.filter(x => !x.excluded && !((x.share||0) > 0)).length;
  const provEl = document.querySelector('#honorarCalcBody .calc-prov-kr');
  if (provEl) provEl.textContent = provKr.toLocaleString('da-DK');
  const sumEl = document.getElementById('calcSumLine');
  if (sumEl) {
    sumEl.style.color = Math.abs(rest)<1 ? 'var(--ok)' : (rest<0 ? 'var(--danger)' : 'var(--cream-mute)');
    sumEl.textContent = 'Sum mandskab: ' + sumInd.toLocaleString('da-DK') + ' kr · Provision ' + provKr.toLocaleString('da-DK') + ' kr · Rest ' + rest.toLocaleString('da-DK') + ' kr' + (tomCount?` · ${tomCount} tom`:'');
  }
}

function applyHonorarCalc(){
  EDITING_ATTENDEES.forEach(a => {
    const ci = CALC_INDIVIDUAL.find(x=>x.memberId===a.memberId);
    if (ci) a.share = ci.excluded ? 0 : (ci.share || 0);
  });
  closeHonorarCalc();
  drawForm(); drawPreview();
  toast('Honorar fordelt');
}

function autoDistributeHonorar(){
  const rates = {
    Musiker: EDITING._rateMusiker || 0,
    Afløser: EDITING._rateAfloser || 0,
    Crew:    EDITING._rateCrew    || 0
  };
  let changed = false;
  EDITING_ATTENDEES.forEach(a => {
    const m = (CACHE.members || []).find(x => x.id === a.memberId);
    if (m && rates[m.category] > 0) { a.share = rates[m.category]; changed = true; }
  });
  if (!changed) { toast('Ingen besætning valgt eller ingen rater angivet', 'err'); return; }
  drawForm(); drawPreview();
}

async function retryLoadMembers(){
  const grid = document.getElementById('attendeesGrid');
  if (grid) grid.innerHTML = '<div class="muted"><span class="spinner"></span>Henter medlemmer...</div>';
  try {
    const d = await apiGet('getMembers');
    if (d.ok){ CACHE.members = d.members; if (grid) grid.innerHTML = renderAttendeesPicker(); }
    else toast(d.error||'Fejl','err');
  } catch(e){ toast('Stadig fejl: '+(e.message||e),'err'); if (grid) grid.innerHTML = renderAttendeesPicker(); }
}

function renderAttendeesPicker(){
  if (!CACHE.members) return `<div class="muted" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span>❌ Kunne ikke hente medlemmer.</span>
    <button class="btn btn-ghost btn-sm" type="button" onclick="retryLoadMembers()">🔄 Prøv igen</button>
  </div>`;
  return CACHE.members.map(m=>{
    const a = EDITING_ATTENDEES.find(x=>x.memberId===m.id);
    const on = !!a;
    return `<div class="attend-chip ${on?'on':''}" data-mid="${escapeHtml(m.id)}">
      <div class="avatar" style="width:28px;height:28px;font-size:13px">${initials(m.name)}</div>
      <div>
        <div class="chip-name">${escapeHtml(m.name)}</div>
        <div class="chip-role">${escapeHtml(m.category||'')} · ${escapeHtml(m.instrument||'')}</div>
      </div>
      ${on ? `<div class="chip-share"><input class="input" type="number" data-mid="${escapeHtml(m.id)}" value="${a.share||0}" placeholder="andel"></div>` : ''}
      <div class="attend-tick">✓</div>
    </div>`;
  }).join('');
}

function setPath(obj, path, val){
  const parts = path.split('.');
  let cur = obj;
  for (let i=0; i<parts.length-1; i++){
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length-1]] = val;
}

function toDateInput(v){
  if (!v) return '';
  const d = new Date(v); if (isNaN(d)) return '';
  return d.toISOString().slice(0,10);
}

// Kontrakttyper der har en rider-skabelon. Tilføj en type her + en post i
// DEFAULT_RIDER_TEMPLATES for at udvide (kontrakt-type-vælgeren skal også opdateres).
const CONTRACT_TYPES = ['Spillested', 'Festival'];

// Kontrakttyper der får en indlejret sceneplan (side 4). Spillested er ren fritekst.
const TYPES_WITH_SCENEPLAN = ['Festival'];

// Indbyggede default-skabeloner. Bruges som fallback når bandet ikke har gemt
// egne skabeloner i operatør-UI'et. Placeholders (__BAND_NAME__ osv.)
// substitueres af _brandify() ved render/print.
const DEFAULT_RIDER_TEMPLATES = {
  Spillested: {
    intro: 'Kære arrangør\n\nHermed teknisk/praktisk rider, som du bedes læse grundigt samt tage stilling til inden du godkender kontrakten.\n\nFor os er det rigtig vigtigt at vide i god tid, hvis nogle af riderens punkter ikke kan opfyldes, således at vi har muligheden for at forberede os og tilpasse vores setup.\n\nAlt dette for at vi giver vores fælles publikum den bedste oplevelse.\n\nEr der spørgsmål til den tekniske del kontaktes __TECH_NAME__ på tel. __TECH_PHONE__\nØvrige spørgsmål rettes til __CONTACT_NAME__ på tel. __CONTACT_PHONE__',
    points: [
      'Load In/Out: Bandet skal som minimum have adgang til scene 2 timer inden lydprøven. Arrangøren stiller 2 frivillige stagehands til rådighed under load in og load out.',
      'Plads: Scenen skal som udgangspunkt være minimum 6x4 meter. Der skal være 2 stk. podier på D:2m B:3m H:30-50cm. Der skal være sort bagvæg, samt bagbro eller lign. så vi kan montere scenetæppe 2x3 meter.',
      'Strøm: Bandet skal bruge et 230 V 10/A. Et trestik placeres på scenen.',
      'Arrangøren leverer lyd og lys med mindre andet er aftalt under særlige aftaler i hovedkontrakten. PA-systemet skal være af professionel kvalitet, hjemmebyggede eller diskoteksanlæg accepteres ikke. Der skal være en tekniker til stede, med indgående kendskab til systemet under hele arrangementet.',
      'Lys: Anlægget skal bestå af min. 4 barer med 4 lamper på hver, to placeres til frontlys og 2 bagerst på scenen.',
      '__BAND_NAME__ kommer selv med IEM system/mix, samt FOH mixer. Hvis ikke stedet har en FOH plads, afsættes 1x1 meter bagerst i salen. Der skal være et bord til rådighed til placering af mixer.',
      'Forplejning: Mad og drikke skal finde sted til ethvert arrangement til både optrædende og teknikere. Drikkevarer (kolde) 1 kasse øl + 1 kasse blandet vand, som placeres backstage.',
      'Backstage: Der skal være et aflåseligt backstage lokale med et Spejl, samt adgang til toilet faciliteter som ikke bruges af publikum. Der skal være borde og stole til 8 pers.',
      'Afbestilling kan ikke finde sted, medmindre begge parter skriftligt samtykker.',
      '__BAND_NAME__ sender i god tid en gæsteliste, med gæster som skal have fri adgang til koncerten, dog max. 10 pers.'
    ]
  },
  Festival: {
    intro: 'Kære arrangør\n\nHermed teknisk rider som du bedes videregive til scene/lydansvarlig.\n\nFor os er det rigtig vigtigt at vide i god tid, hvis nogle af riderens punkter ikke kan opfyldes, således at vi har muligheden for at forberede os.\n\nEr der spørgsmål til den tekniske del kontaktes __TECH_NAME__ på tel. __TECH_PHONE__\nØvrige spørgsmål rettes til __CONTACT_NAME__ på tel. __CONTACT_PHONE__\n\nIndholdsfortegnelse:\n1. Festival Rider\n2. Sceneplan',
    points: [
      'Load In/Out: Bandet skal som minimum have scene/bagscene til rådighed til opstilling min. 45 min. inden lydprøve. Arrangøren stiller 2 frivillige stagehands til rådighed under load in og load out.',
      'Plads: Scenen skal som udgangspunkt være minimum 8x4 meter. Der skal være 2 stk. podier på D:2m B:3m H:30-50cm. Der skal være sort bagvæg, samt bagbro eller lign. så vi kan montere scenetæppe 2x3 meter.',
      'Strøm: Bandet skal bruge et 230 V 10/A. Fordelerdåser placeres og fordeles på scenen, jfr. sceneplanen. El-kredsen skal være jordet hele vejen igennem.',
      'Lyd og lys: Arrangøren leverer lyd og lys. PA-systemet skal være af professionel kvalitet, hjemmebyggede eller diskoteksanlæg accepteres ikke. Der skal være en tekniker til stede, med indgående kendskab til systemet under hele arrangementet.',
      'Lys: Anlægget skal bestå af min. 4 barer med 4 lamper på hver, to placeres til frontlys og 2 bagerst på scenen.',
      'FOH: Der leveres 2 stk. Cat5/6 kabler mellem scene og FOH. L/R leveres i FOH.',
      '__BAND_NAME__ kommer selv med IEM system/mix, samt FOH mixer.',
      'Forplejning: Mad og drikke skal finde sted til ethvert arrangement til både optrædende og teknikere. Drikkevarer (kolde) 1 kasse øl + 1 kasse blandet vand, som placeres backstage.',
      'Backstage: Der skal være et aflåseligt backstage lokale med et Spejl, samt adgang til toilet faciliteter som ikke bruges af publikum. Der skal være borde og stole til 8 pers.',
      'Afbestilling kan ikke finde sted, medmindre begge parter skriftligt samtykker.',
      '__BAND_NAME__ sender i god tid en gæsteliste, med gæster som skal have fri adgang til koncerten, dog max. 10 pers.'
    ]
  }
};

// Parser bandets gemte skabeloner (JSON i Settings.riderTemplates). Tom/korrupt = {}.
function _parseRiderTemplates(raw){
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
  catch(e){ return {}; }
}

// Returnerer { intro, points } for en kontrakttype: bandets egne skabeloner hvis
// sat, ellers de indbyggede defaults. Falder tilbage til Spillested for ukendt type.
function riderFor(type){
  const def = DEFAULT_RIDER_TEMPLATES[type] || DEFAULT_RIDER_TEMPLATES.Spillested;
  const band = _parseRiderTemplates(BAND_CONFIG.riderTemplates)[type] || {};
  const intro = (band.intro != null && String(band.intro).trim() !== '') ? band.intro : def.intro;
  const points = (Array.isArray(band.points) && band.points.length) ? band.points : def.points;
  return { intro: intro, points: points };
}

function drawPreview(){
  const c = EDITING;
  const el = document.getElementById('cPreview');
  if (!el) return;
  const memById = (id)=> (CACHE.members||[]).find(m=>m.id===id);
  const _rider = riderFor(c.type);
  const riderPoints = _rider.points;
  const riderIntro = _rider.intro;

  // ─── Rider-sektion (side 2,3,4) — præcedens ───
  // 1) uploadet rider-PDF (renderet til billeder via PDF.js) erstatter HELE rideren
  // 2) ellers genereret: intro (side 2) + punkter (side 3) + sceneplan (side 4, kun festival)
  const _genRiderPages =
    `<!-- Side 2: Rider intro -->
    <div class="pdf-page" style="margin-bottom:24px">
      <div style="text-align:center;margin-bottom:24px">
        <img src="${DMD_LOGO_B64}" alt="" style="height:80px;object-fit:contain">
      </div>
      <div style="text-align:center;font-size:22px;font-weight:700;color:#0F213C;margin-bottom:20px;font-family:'Inter',sans-serif">
        Rider ${escapeHtml(c.type).toLowerCase()}
      </div>
      <div style="font-size:12px;color:#2A2A2A;line-height:1.8;white-space:pre-line">${escapeHtml(riderIntro)}</div>
    </div>
    <!-- Side 3: Rider punkter -->
    <div class="pdf-page" style="margin-bottom:24px">
      <div style="text-align:center;font-size:20px;font-weight:700;color:#0F213C;margin-bottom:16px;font-family:'Inter',sans-serif">Rider ${escapeHtml(c.type).toLowerCase()}</div>
      <ol style="margin:0;padding-left:18px;font-size:12px;color:#2A2A2A;line-height:1.8">
        ${riderPoints.map(p => `<li style="margin-bottom:8px">${escapeHtml(p)}</li>`).join('')}
      </ol>
      <div class="pdf-foot">__BAND_NAME__ · Rider godkendes ved kontraktgodkendelse</div>
    </div>` +
    (c.type === 'Festival' ?
    `<!-- Side 4: Sceneplan (Festival) -->
    <div class="pdf-page" style="font-family:'Inter',sans-serif;color:#1A1A1A">
      <div style="text-align:center;font-size:28px;font-weight:700;margin-bottom:24px">Sceneplan</div>
      ${SCENEPLAN_DATA_URL
        ? `<div style="text-align:center"><img src="${SCENEPLAN_DATA_URL}" alt="Sceneplan" style="max-width:100%;max-height:920px;object-fit:contain"></div>`
        : (BAND_CONFIG.hasSceneplan
            ? `<div style="text-align:center;padding:32px;color:#8A6F4D;font-size:13px">Indlæser sceneplan…</div>`
            : `<div style="text-align:center;padding:32px;border:1px dashed #D97A6C;background:#F8E5E0;color:#7A2A1A;line-height:1.6">
                 <div style="font-size:14px;font-weight:600;margin-bottom:8px">Ingen sceneplan uploadet endnu</div>
                 <div style="font-size:12px">Upload bandets sceneplan i operatør-UI'et under "Rider-skabeloner".</div>
               </div>`)}
      <div class="pdf-foot">__BAND_NAME__ · Sceneplan · Festival</div>
    </div>` : '');

  let riderPagesHtml;
  if (RIDER_PDF_PAGES && RIDER_PDF_PAGES.length){
    riderPagesHtml = RIDER_PDF_PAGES.map(url =>
      `<div class="pdf-page" style="margin-bottom:24px;padding:0;overflow:hidden"><img src="${url}" alt="" style="width:100%;display:block"></div>`
    ).join('');
  } else if (BAND_CONFIG.hasRiderPdf){
    riderPagesHtml = `<div class="pdf-page" style="margin-bottom:24px;text-align:center;padding:48px;color:#8A6F4D;font-size:13px">Indlæser rider-PDF…</div>`;
  } else {
    riderPagesHtml = _genRiderPages;
  }

  // ─── Helpers for contract table rows ───
  const tr = (label, val, label2, val2) =>
    `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A;width:50%"><span style="color:#8A6F4D">${label}</span> ${val}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A"><span style="color:#8A6F4D">${label2||''}</span> ${val2||''}</td>
    </tr>`;
  const thRow = (left, right) =>
    `<tr>
      <th style="background:#555;color:#fff;text-align:left;padding:5px 8px;font-size:11px;font-weight:600;width:50%">${left}</th>
      <th style="background:#555;color:#fff;text-align:left;padding:5px 8px;font-size:11px;font-weight:600">${right}</th>
    </tr>`;

  const besaetningChips = EDITING_ATTENDEES.length === 0
    ? '<span style="color:#8A6F4D;font-size:11px">— ingen valgt endnu —</span>'
    : EDITING_ATTENDEES.map(a => {
        const m = memById(a.memberId);
        return m ? `<span style="display:inline-block;background:#EFE3CC;padding:2px 8px;border-radius:3px;font-size:10px;color:#0F213C;margin:2px">${escapeHtml(m.name)} · ${escapeHtml(m.instrument||'')}</span>` : '';
      }).join('');

  el.innerHTML = _brandify(`
    <div class="preview-toolbar">
      <div class="eyebrow">Live forhåndsvisning · PDF</div>
      <button class="btn btn-ghost btn-sm" onclick="downloadContractPDF()">↓ Download PDF</button>
    </div>

    <!-- ══ Side 1: Kontrakt ══ -->
    <div class="pdf-page" style="margin-bottom:24px;font-family:'Inter',sans-serif">

      <!-- Header -->
      <div style="background:#0F213C;margin:-36px -40px 0;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:4px 4px 0 0">
        <img src="${DMD_LOGO_B64}" alt="" style="height:48px;object-fit:contain">
        <div style="color:#fff;font-size:26px;font-weight:700;font-family:'Inter',sans-serif;letter-spacing:.02em">${escapeHtml(c.venue.name||'Kontrakt')}</div>
        <div style="text-align:right;color:rgba(255,255,255,.65);font-size:10px;font-family:'JetBrains Mono',monospace;line-height:1.4">
          Kontrakt nr. <strong style="color:#fff;font-size:12px">${escapeHtml(c.id||'—')}</strong>
        </div>
      </div>

      <!-- Arrangør / Optrædende -->
      <table style="width:100%;border-collapse:collapse;margin-top:0">
        ${thRow('Arrangør', 'Optrædende <em style="font-weight:400;font-size:10px">(repræsenteret ved)</em>')}
        ${tr('Navn', escapeHtml(c.arrangoer.name||''), 'Kontaktperson:', '__CONTACT_NAME__')}
        ${tr('Adresse', escapeHtml(c.arrangoer.address||''), 'Adresse:', '__CONTACT_ADDR1__')}
        ${tr('Postnr.', escapeHtml((c.arrangoer.postnr||'')+' '+(c.arrangoer.city||'')).trim(), 'Postnr.:', '6840, Oksbøl')}
        ${tr('Kontaktperson', escapeHtml(c.arrangoer.contactName||''), 'Mob.:', '__CONTACT_PHONE__')}
        ${tr('Kontaktperson tlf.', escapeHtml(c.arrangoer.phone||''), 'Mail:', '__CONTACT_EMAIL__')}
        ${tr('Mail', escapeHtml(c.arrangoer.email||''), '', '')}
      </table>

      <!-- Spillested / Bandnavn -->
      <table style="width:100%;border-collapse:collapse;margin-top:0">
        <tr>
          <th style="background:#555;color:#fff;text-align:left;padding:5px 8px;font-size:11px;font-weight:600;width:50%">Spillested</th>
          <th style="background:#555;color:#fff;text-align:left;padding:5px 8px;font-size:11px;font-weight:600">Bandnavn: __BAND_NAME__</th>
        </tr>
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Adresse</span> ${escapeHtml(c.venue.address||'')}${c.venue.postnr||c.venue.city ? ', '+escapeHtml((c.venue.postnr||'')+' '+(c.venue.city||'')).trim() : ''}
          </td>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Antal musikere</span> ${c.musicianCount}&nbsp;&nbsp;
            <span style="color:#8A6F4D">Crew</span> ${c.crewCount}&nbsp;&nbsp;
            <span style="color:#8A6F4D">Gæster</span> ${c.guestCount}
          </td>
        </tr>
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Dato</span> ${escapeHtml(c.date ? new Date(c.date).toLocaleDateString('da-DK') : '')}
          </td>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Spilletid fra kl.</span> ${escapeHtml(c.showtimeFrom||'')}
            &nbsp;&nbsp;<span style="color:#8A6F4D">til kl.</span> ${escapeHtml(c.showtimeTo||'')}
          </td>
        </tr>
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Get in kl.</span> ${escapeHtml(c.getIn||'')}
          </td>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Antal set</span> ${c.sets} <span style="color:#8A6F4D">á</span> ${c.setMinutes} <span style="color:#8A6F4D">min.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <span style="color:#8A6F4D">Lydprøve færdig kl.</span> ${escapeHtml(c.soundcheck||'')}
          </td>
          <td style="padding:4px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;font-weight:700;color:#0F213C">
            Honorar kr. ${c.honorar ? c.honorar.toLocaleString('da-DK') : '—'}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding:5px 8px;border-bottom:1px solid #D9CFBE;font-size:11px;color:#4A4A4A">
            <strong>Særlige aftaler:</strong> ${escapeHtml(c.notes||'')}
          </td>
        </tr>
      </table>

      <!-- Betalingsbetingelser -->
      <div style="padding:8px;border-bottom:2px solid #B8A88A;font-size:11px;color:#2A2A2A">
        <div style="margin-bottom:4px">Betalings betingelser: <strong>${escapeHtml(c.paymentTerms||'')}${c.paymentTerms==='Andet'&&c.paymentTermsOther ? ' — '+escapeHtml(c.paymentTermsOther) : ''}</strong></div>
        <div style="display:flex;gap:24px">
          <div>Reg/Kontonr: <u>${escapeHtml(_b('bankReg')||'—')}</u> / <u>${escapeHtml(_b('bankKto')||'—')}</u><br>Oplysninger til skat udleveres på dagen.</div>
          <div><strong>Kontohaver:</strong><br>${escapeHtml(_b('payeeName')||_b('bandName'))}${_b('payeeAddress') ? ', '+escapeHtml(_b('payeeAddress')).replace(/\n/g,', ') : ''}</div>
        </div>
      </div>

      <!-- Betingelser header -->
      <div style="background:#666;color:#fff;text-align:center;padding:5px 8px;font-size:12px;font-weight:600;margin-bottom:8px">Betingelser</div>

      <div style="font-size:11px;color:#2A2A2A;padding:0 4px">
        <p style="font-weight:700;margin:0 0 6px">Kontrakten er en bindende aftale mellem optrædende og arrangør.</p>
        <ul style="margin:0;padding-left:14px;line-height:1.7">
          <li><strong>Honorar</strong> Forhandles mellem arrangør og orkester</li>
          <li><strong>Koda/Gramex</strong> Ved offentlig adgang til arrangementet skal arrangøren betale vederlag til Koda og Gramex.</li>
          <li><strong>Godkendelse af denne kontrakt</strong> Ved godkendelse af denne kontrakt godkender arrangør ligeledes rider</li>
          <li><strong>Afbestilling kan ikke finde sted</strong></li>
        </ul>
      </div>

      <!-- Godkendelse bjælke -->
      <div style="background:#666;color:#fff;text-align:center;padding:5px 8px;font-size:12px;font-weight:600;margin-top:14px">Gensidig godkendelse</div>

      <!-- Acceptance tekst -->
      <div style="margin-top:12px;font-size:11px;color:#2A2A2A;line-height:1.6;padding:0 4px">
        __BAND_NAME__ har ved fremsendelse af denne kontrakt godkendt og accepteret indholdet.<br><br>
        Denne kontrakt godkendes af arrangøren ved fremsendelse af mail til <strong>__CONTACT_EMAIL__</strong><br>
        <strong>Emne:</strong> "kontrakt nr."<br>
        <strong>tekst i mail:</strong> Godkendt
      </div>
    </div>

    ${riderPagesHtml}
  `);
}

function toggleContractIdEdit(){
  const inp = document.getElementById('contractIdInput');
  if (!inp) return;
  if (inp.readOnly) {
    if (!EDITING._originalId) EDITING._originalId = EDITING.id;
    inp.readOnly = false;
    inp.style.opacity = '';
    inp.style.cursor = '';
    inp.focus();
    inp.select();
  } else {
    inp.readOnly = true;
    inp.style.opacity = '.7';
    inp.style.cursor = 'default';
  }
}

let SAVING_CONTRACT = false;
async function saveContract(){
  if (SAVING_CONTRACT) return;
  SAVING_CONTRACT = true;
  const btns = document.querySelectorAll('button[onclick="saveContract()"]');
  const originalLabels = [];
  btns.forEach(b => {
    originalLabels.push(b.innerHTML);
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span> Gemmer…';
  });
  try {
    const payload = { contract: EDITING, attendees: EDITING_ATTENDEES };
    if (EDITING._originalId) payload.originalId = EDITING._originalId;
    // Conflict detection: send den updatedAt vi så da kontrakten blev indlæst.
    // Backend afviser hvis serveren har en nyere version (en anden admin har gemt imens).
    if (EDITING._loadedAt) payload.expectedUpdatedAt = EDITING._loadedAt;
    const d = await apiPost('saveContract', payload);
    if (d && d.conflict){
      if (confirm((d.error||'Konflikt') + '\n\nVil du genindlæse for at se den nyeste version?')){
        setAdminRoute('contractEdit', { id: EDITING.id });
      }
      return;
    }
    if (!d.ok){ toast(d.error,'err'); return; }
    toast('Gemt');
    EDITING.id = d.id;
    EDITING._originalId = d.id;
    cacheBust('contracts'); cacheBust('dashboard'); broadcastInvalidate(['contracts','dashboard']);
    setAdminRoute('contractEdit', { id: d.id });
  } catch(e){ toast(e.message,'err'); }
  finally {
    SAVING_CONTRACT = false;
    btns.forEach((b, i) => { b.disabled = false; b.innerHTML = originalLabels[i]; });
  }
}

async function deleteContract(){
  if (!confirm('Slet denne kontrakt? Tilknyttede deltagelser slettes også.')) return;
  try {
    const d = await apiPost('deleteContract', { id: EDITING.id });
    if (!d.ok){ toast(d.error,'err'); return; }
    toast('Slettet');
    cacheBust('contracts'); cacheBust('dashboard'); broadcastInvalidate(['contracts','dashboard']);
    setAdminRoute('contracts');
  } catch(e){ toast(e.message,'err'); }
}

function copyContract(){
  EDITING = JSON.parse(JSON.stringify(EDITING));
  EDITING.id = '';
  EDITING.status = 'udkast';
  EDITING.date = '';
  toast('Kopi oprettet — gem for at gemme den.');
  drawContractEditor();
}

