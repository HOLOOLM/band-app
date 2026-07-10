// Del af band-app frontend. Sceneplan-editor — selvstændigt modul (namespacet,
// lækker ingen globals ud over window.SceneplanEditor) så det kan leve i samme
// globale scope som resten af 01-09-filerne uden at kollidere med deres variabler.
//
// Bruges af operatør-panelet (09-boot.js): SceneplanEditor.open({ state, bandName, onPublish, onClose }).
// Datamodel (JSON — det samme objekt gemmes i Settings-nøglen `sceneplanJson`
// så en sceneplan kan genåbnes og redigeres videre):
//   { stage:{w,h}, elements:[...], strokes:[...], lines:[...], rects:[...], circles:[...], texts:[...] }
// Koordinater i SVG-enheder; 1 meter = 100 enheder.

const SceneplanEditor = (function(){
  'use strict';

  const M = 100;            // enheder pr. meter
  const INK = '#1F3D5F';    // "blæk" på det lyse scene-papir
  const PAPER = '#F3EFE7';
  const GRID = '#D9D2C2';
  const SEL = '#E8A867';
  let injected = false;

  function injectStyle(){
    if (injected) return;
    injected = true;
    const css = `
.se-overlay{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;
  background:#08111F;color:#F5EDE0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px}
.se-overlay *{box-sizing:border-box}
.se-overlay button{font-family:inherit;cursor:pointer}
.se-overlay input,.se-overlay select,.se-overlay textarea{font-family:inherit}
.se-header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid #1F3D5F;flex-wrap:wrap;flex:none}
.se-header h1{font-family:"Instrument Serif","Times New Roman",serif;font-weight:400;font-size:20px;margin:0}
.se-eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#9A9285}
.se-spacer{flex:1}
.se-badge{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:3px 10px;border-radius:99px;border:1px solid #1F3D5F;color:#9A9285}
.se-badge.ok{color:#7FB985;border-color:rgba(127,185,133,.35)}
.se-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border-radius:8px;font-size:12.5px;font-weight:500;border:1px solid transparent;background:transparent;color:#F5EDE0;transition:all 120ms}
.se-btn:hover{transform:translateY(-1px)}
.se-btn-primary{background:#8A8A8A;color:#08111F;font-weight:600}
.se-btn-primary:hover{background:#A8A8A8}
.se-btn-ghost{border-color:rgba(245,237,224,.18)}
.se-btn-ghost:hover{background:rgba(245,237,224,.06)}
.se-btn-danger{border-color:rgba(217,122,108,.4);color:#D97A6C}
.se-btn-danger:hover{background:rgba(217,122,108,.1)}
.se-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.se-btn-sm{padding:5px 9px;font-size:11.5px}
.se-main{flex:1;display:grid;grid-template-columns:220px 1fr 240px;gap:0;min-height:0}
.se-palette{border-right:1px solid #1F3D5F;padding:14px 12px;overflow-y:auto}
.se-palette .se-eyebrow{margin-bottom:10px;display:block}
.se-pal-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 9px;margin-bottom:6px;border:1px solid #1F3D5F;border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.02));color:#F5EDE0;text-align:left;user-select:none;touch-action:none}
.se-pal-item:hover{border-color:#8A8A8A}
.se-pal-item svg{flex:none;width:34px;height:28px;overflow:visible}
.se-pal-item .se-nm{font-size:12.5px}
.se-pal-hint{font-size:11px;color:#9A9285;margin-top:10px;line-height:1.5}
.se-canvascol{display:flex;flex-direction:column;min-width:0;min-height:0}
.se-tools{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #1F3D5F;flex-wrap:wrap}
.se-pill{display:inline-flex;background:rgba(8,17,31,.6);border:1px solid #1F3D5F;border-radius:99px;padding:3px;flex-wrap:wrap}
.se-pill button{padding:5px 11px;border:0;background:transparent;color:#D9CFBE;font-size:10.5px;font-family:"JetBrains Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;border-radius:99px}
.se-pill button.on{background:#8A8A8A;color:#08111F;font-weight:600}
.se-tgroup{display:flex;align-items:center;gap:6px}
.se-tgroup label{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#9A9285}
.se-num{width:52px;background:rgba(0,0,0,.28);border:1px solid #1F3D5F;border-radius:6px;color:#F5EDE0;padding:5px 7px;font-size:13px}
.se-overlay input[type=color]{width:30px;height:26px;border:1px solid #1F3D5F;border-radius:6px;background:rgba(0,0,0,.28);padding:2px}
.se-overlay input[type=range]{accent-color:#8A8A8A}
.se-holder{flex:1;overflow:auto;padding:22px;min-height:0}
.se-svgbox{margin:0 auto;transition:width 80ms}
.se-svg{display:block;width:100%;height:auto;user-select:none;touch-action:none}
.se-props{border-left:1px solid #1F3D5F;padding:14px;overflow-y:auto}
.se-props .se-card{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.02));border:1px solid #1F3D5F;border-radius:14px;padding:14px}
.se-props h3{margin:0 0 10px;font-family:"Instrument Serif","Times New Roman",serif;font-weight:400;font-size:17px}
.se-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px}
.se-field label{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#9A9285}
.se-field .se-input{background:rgba(0,0,0,.28);border:1px solid #1F3D5F;border-radius:8px;padding:8px 10px;color:#F5EDE0;font-size:13px;outline:none;width:100%;resize:vertical}
.se-field .se-input:focus{border-color:#8A8A8A}
.se-field .se-rowval{display:flex;align-items:center;gap:8px}
.se-field .se-rowval output{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;color:#D9CFBE;min-width:40px;text-align:right}
.se-field .se-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#F5EDE0}
.se-props-empty{color:#9A9285;font-size:12.5px;line-height:1.6}
.se-textfloat{position:fixed;z-index:9050;display:none;background:#fff;color:#111;border:2px solid #8A8A8A;border-radius:6px;padding:6px 8px;font-size:14px;min-width:180px;min-height:44px;outline:none}
.se-ghost{position:fixed;z-index:9060;display:none;pointer-events:none;background:#16304F;border:1px solid #8A8A8A;color:#F5EDE0;border-radius:8px;padding:5px 11px;font-size:12px;transform:translate(-50%,-120%)}
@media (max-width:980px){
  .se-main{display:flex;flex-direction:column}
  .se-palette{flex:none;border-right:0;border-bottom:1px solid #1F3D5F;display:flex;align-items:center;gap:8px;overflow-x:auto;padding:8px 10px}
  .se-palette > .se-eyebrow{display:none}
  .se-pallist{display:flex;gap:6px}
  .se-pallist .se-pal-item{flex:none;width:auto;margin-bottom:0;padding:6px 8px}
  .se-pallist .se-pal-item .se-nm{white-space:nowrap}
  .se-pal-hint{display:none}
  .se-canvascol{flex:1 0 auto;min-height:420px}
  .se-props{flex:none;border-left:0;border-top:1px solid #1F3D5F}
}`;
    const style = document.createElement('style');
    style.id = 'se-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function amp(w,h,txt){ return `
    <rect x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="6" fill="none" stroke="${INK}" stroke-width="3"/>
    <line x1="${-w/2+8}" y1="${-h/2+10}" x2="${w/2-8}" y2="${-h/2+10}" stroke="${INK}" stroke-width="2" opacity=".55"/>
    <line x1="${-w/2+8}" y1="${-h/2+17}" x2="${w/2-8}" y2="${-h/2+17}" stroke="${INK}" stroke-width="2" opacity=".35"/>
    <text y="${h/2-9}" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}">${txt}</text>`; }

  const DEFS = {
    drums:{ name:'Trommesæt', w:190, h:160, draw:()=>`
      <circle cx="0" cy="18" r="42" fill="none" stroke="${INK}" stroke-width="3.5"/>
      <circle cx="-52" cy="8" r="22" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="-26" cy="-32" r="19" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="14" cy="-38" r="19" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="56" cy="16" r="26" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="-72" cy="-46" r="24" fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="5 5"/>
      <circle cx="62" cy="-46" r="24" fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="5 5"/>
      <circle cx="0" cy="66" r="9" fill="${INK}" opacity=".6"/>` },
    gtramp:{ name:'Guitar-amp', w:90, h:62, draw:()=>amp(90,62,'GTR') },
    bassamp:{ name:'Bas-amp', w:100, h:82, draw:()=>amp(100,82,'BASS') },
    keys:{ name:'Keyboard', w:170, h:46, draw:()=>`
      <rect x="-85" y="-23" width="170" height="46" rx="5" fill="none" stroke="${INK}" stroke-width="3"/>
      ${Array.from({length:9},(_,i)=>`<line x1="${-70+i*17}" y1="-23" x2="${-70+i*17}" y2="-2" stroke="${INK}" stroke-width="2" opacity=".5"/>`).join('')}
      <text y="16" text-anchor="middle" font-size="13" font-weight="700" fill="${INK}">KEYS</text>` },
    mic:{ name:'Mikrofonstativ', w:44, h:44, draw:()=>`
      <circle cx="0" cy="-8" r="11" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="0" cy="-8" r="4" fill="${INK}"/>
      <line x1="0" y1="3" x2="0" y2="20" stroke="${INK}" stroke-width="3"/>
      <line x1="-12" y1="20" x2="12" y2="20" stroke="${INK}" stroke-width="3"/>` },
    monitor:{ name:'Monitor (wedge)', w:70, h:50, draw:()=>`
      <polygon points="-35,25 35,25 22,-25 -22,-25" fill="none" stroke="${INK}" stroke-width="3"/>
      <line x1="-22" y1="8" x2="22" y2="8" stroke="${INK}" stroke-width="2" opacity=".5"/>
      <text y="21" text-anchor="middle" font-size="11" font-weight="700" fill="${INK}">MON</text>` },
    di:{ name:'DI-boks', w:34, h:34, draw:()=>`
      <rect x="-17" y="-17" width="34" height="34" rx="4" fill="none" stroke="${INK}" stroke-width="3"/>
      <text y="5" text-anchor="middle" font-size="13" font-weight="700" fill="${INK}">DI</text>` },
    power:{ name:'Strøm 230 V', w:42, h:42, draw:()=>`
      <rect x="-21" y="-21" width="42" height="42" rx="6" fill="none" stroke="${INK}" stroke-width="3"/>
      <path d="M 3,-14 L -7,2 L 0,2 L -3,14 L 8,-2 L 1,-2 Z" fill="${INK}"/>` },
    musician:{ name:'Musiker', w:56, h:56, draw:()=>`
      <circle cx="0" cy="0" r="26" fill="none" stroke="${INK}" stroke-width="3"/>
      <circle cx="0" cy="-6" r="8" fill="${INK}" opacity=".7"/>
      <path d="M -13,14 Q 0,2 13,14" fill="none" stroke="${INK}" stroke-width="3"/>` },
    riser:{ name:'Riser / podie', w:200, h:200, draw:()=>`
      <rect x="-100" y="-100" width="200" height="200" rx="4" fill="none" stroke="${INK}" stroke-width="3" stroke-dasharray="10 7"/>
      <text y="5" text-anchor="middle" font-size="14" fill="${INK}" opacity=".7">RISER 2×2 m</text>` },
  };

  function esc(x){ return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
  function uid(){ return Math.random().toString(36).slice(2,9); }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function r1(v){ return Math.round(v*10)/10; }
  function fmtM(v){ return (Math.round(v*10)/10).toString().replace('.',','); }

  function sampleState(){
    return { stage:{w:8,h:6},
      elements:[
        {id:uid(),type:'riser',x:400,y:130,rot:0,scale:1,label:''},
        {id:uid(),type:'drums',x:400,y:125,rot:0,scale:1,label:'Trommer'},
        {id:uid(),type:'gtramp',x:120,y:150,rot:15,scale:1,label:'Guitar'},
        {id:uid(),type:'bassamp',x:680,y:150,rot:-15,scale:1,label:'Bas'},
        {id:uid(),type:'mic',x:400,y:430,rot:0,scale:1,label:'Vokal'},
        {id:uid(),type:'monitor',x:400,y:520,rot:0,scale:1,label:''},
      ], strokes:[], lines:[], rects:[], circles:[], texts:[] };
  }

  function normalizeState(s){
    const base = sampleState();
    if (!s || typeof s !== 'object') return base;
    const out = {
      stage: (s.stage && s.stage.w && s.stage.h) ? {w:+s.stage.w, h:+s.stage.h} : base.stage,
      elements: Array.isArray(s.elements) ? s.elements : [],
      strokes: Array.isArray(s.strokes) ? s.strokes : [],
      lines: Array.isArray(s.lines) ? s.lines : [],
      rects: Array.isArray(s.rects) ? s.rects : [],
      circles: Array.isArray(s.circles) ? s.circles : [],
      texts: Array.isArray(s.texts) ? s.texts : [],
    };
    return out;
  }

  // ---------- Instans-fabrik ----------
  // Hver open() laver en frisk instans med sin egen lukning, så flere kald
  // efter hinanden (fx åbn → luk → åbn igen) aldrig deler mutable state.
  function createInstance(opts){
    opts = opts || {};
    let state = normalizeState(opts.state);
    let history = [JSON.stringify(state)], hIdx = 0;
    let selected = null;
    let tool = 'select';
    let zoom = 1;
    let snap = false;
    let closed = false;

    const overlay = document.createElement('div');
    overlay.className = 'se-overlay';
    overlay.innerHTML = `
      <div class="se-header">
        <div>
          <span class="se-eyebrow">Sceneplan${opts.bandName ? ' · ' + esc(opts.bandName) : ''}</span>
          <h1>Byg sceneplan</h1>
        </div>
        <span class="se-badge" id="seSaveBadge">Ugemte ændringer gemmes ved publicering</span>
        <div class="se-spacer"></div>
        <button class="se-btn se-btn-ghost se-btn-sm" id="seUndo" title="Ctrl+Z">↶ Fortryd</button>
        <button class="se-btn se-btn-ghost se-btn-sm" id="seRedo" title="Ctrl+Y">↷ Gendan</button>
        <button class="se-btn se-btn-ghost se-btn-sm" id="seJson">↓ JSON</button>
        <button class="se-btn se-btn-ghost se-btn-sm" id="sePng">↓ PNG</button>
        <button class="se-btn se-btn-danger se-btn-sm" id="seClear">Ryd alt</button>
        <button class="se-btn se-btn-ghost se-btn-sm" id="seCancel">Luk</button>
        <button class="se-btn se-btn-primary se-btn-sm" id="sePublish">✓ Gem &amp; publicér til rider</button>
      </div>
      <div class="se-main">
        <aside class="se-palette">
          <span class="se-eyebrow">Elementer</span>
          <div class="se-pallist" id="sePalList"></div>
          <div class="se-pal-hint">Klik for at placere midt på scenen — eller træk elementet direkte derhen, hvor det skal stå.</div>
        </aside>
        <section class="se-canvascol">
          <div class="se-tools">
            <div class="se-pill" id="seToolPill">
              <button data-tool="select" class="on">Vælg</button>
              <button data-tool="pen">Frihånd</button>
              <button data-tool="line">Linje</button>
              <button data-tool="rect">Rektangel</button>
              <button data-tool="circle">Cirkel</button>
              <button data-tool="text">Tekstboks</button>
            </div>
            <div class="se-tgroup" id="seDrawOpts" style="display:none">
              <label>Farve</label><input type="color" id="sePenColor" value="#1F3D5F">
              <label>Tykkelse</label><input type="range" id="sePenWidth" min="2" max="14" value="4" style="width:70px">
              <label id="seArrowLbl" style="display:none"><input type="checkbox" id="seArrow" style="vertical-align:middle;margin-right:4px">Pil</label>
              <label id="seFillLbl" style="display:none"><input type="checkbox" id="seFill" style="vertical-align:middle;margin-right:4px">Fyld</label>
            </div>
            <div class="se-tgroup">
              <label>Scene</label>
              <input class="se-num" type="number" id="seStageW" min="2" max="24" step="0.5"> ×
              <input class="se-num" type="number" id="seStageH" min="2" max="20" step="0.5">
              <label>meter</label>
            </div>
            <div class="se-tgroup">
              <label class="se-field-check" style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="seSnap">Snap 0,5 m</label>
            </div>
            <div class="se-spacer" style="flex:1"></div>
            <div class="se-tgroup">
              <button class="se-btn se-btn-ghost se-btn-sm" id="seZoomOut">−</button>
              <button class="se-btn se-btn-ghost se-btn-sm" id="seZoomFit">Tilpas</button>
              <button class="se-btn se-btn-ghost se-btn-sm" id="seZoomIn">+</button>
            </div>
          </div>
          <div class="se-holder"><div class="se-svgbox" id="seSvgBox"><svg class="se-svg" id="seScene" xmlns="http://www.w3.org/2000/svg"></svg></div></div>
        </section>
        <aside class="se-props"><div class="se-card" id="sePropsCard"></div></aside>
      </div>
      <textarea class="se-textfloat" id="seTextFloat" placeholder="Skriv tekst… (Enter = ny linje, Ctrl+Enter = gem)"></textarea>
      <div class="se-ghost" id="seGhost"></div>`;

    const $ = sel => overlay.querySelector(sel);
    const svg = $('#seScene');
    const svgBox = $('#seSvgBox');
    const holder = $('.se-holder');
    const ghost = $('#seGhost');
    const textFloat = $('#seTextFloat');
    const propsCard = $('#sePropsCard');
    const toolPill = $('#seToolPill');
    const btnUndo = $('#seUndo'), btnRedo = $('#seRedo');

    function commit(){
      history = history.slice(0, hIdx+1);
      history.push(JSON.stringify(state));
      if (history.length > 100) history.shift();
      hIdx = history.length - 1;
      updateUndoBtns();
    }
    function undo(){ if (hIdx>0){ hIdx--; state = JSON.parse(history[hIdx]); selected=null; render(); updateUndoBtns(); } }
    function redo(){ if (hIdx<history.length-1){ hIdx++; state = JSON.parse(history[hIdx]); selected=null; render(); updateUndoBtns(); } }
    function updateUndoBtns(){ btnUndo.disabled = hIdx<=0; btnRedo.disabled = hIdx>=history.length-1; }

    function snapv(v){ return snap ? Math.round(v/(M/2))*(M/2) : v; }

    // ---------- Dimension-visning (altid synlig, ikke redigerbar) ----------
    function dimMarkup(W,H){
      const off = 46;
      let s = '';
      // bredde (bund)
      s += `<g opacity=".85">
        <line x1="0" y1="${H+off}" x2="${W}" y2="${H+off}" stroke="${INK}" stroke-width="1.5"/>
        <line x1="0" y1="${H+off-8}" x2="0" y2="${H+off+8}" stroke="${INK}" stroke-width="1.5"/>
        <line x1="${W}" y1="${H+off-8}" x2="${W}" y2="${H+off+8}" stroke="${INK}" stroke-width="1.5"/>
        <rect x="${W/2-46}" y="${H+off-13}" width="92" height="22" fill="${PAPER}"/>
        <text x="${W/2}" y="${H+off+4}" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}" font-family="monospace">${fmtM(W/M)} m bred</text>
      </g>`;
      // højde (venstre)
      s += `<g opacity=".85">
        <line x1="${-off}" y1="0" x2="${-off}" y2="${H}" stroke="${INK}" stroke-width="1.5"/>
        <line x1="${-off-8}" y1="0" x2="${-off+8}" y2="0" stroke="${INK}" stroke-width="1.5"/>
        <line x1="${-off-8}" y1="${H}" x2="${-off+8}" y2="${H}" stroke="${INK}" stroke-width="1.5"/>
        <rect x="${-off-13}" y="${H/2-46}" width="22" height="92" fill="${PAPER}"/>
        <text x="${-off+4}" y="${H/2}" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}" font-family="monospace" transform="rotate(-90 ${-off+4} ${H/2})">${fmtM(H/M)} m høj</text>
      </g>`;
      return s;
    }

    function sceneMarkup(withSelection){
      const W = state.stage.w*M, H = state.stage.h*M;
      let s = '';
      s += `<rect x="0" y="0" width="${W}" height="${H}" fill="${PAPER}" stroke="${INK}" stroke-width="4" rx="2"/>`;
      for(let x=1; x<state.stage.w; x++) s += `<line x1="${x*M}" y1="0" x2="${x*M}" y2="${H}" stroke="${GRID}" stroke-width="1.5"/>`;
      for(let y=1; y<state.stage.h; y++) s += `<line x1="0" y1="${y*M}" x2="${W}" y2="${y*M}" stroke="${GRID}" stroke-width="1.5"/>`;
      s += `<text x="${W/2}" y="-16" text-anchor="middle" font-size="14" fill="${INK}" opacity=".55" letter-spacing="4" font-family="monospace">BAGSCENE</text>`;
      s += `<rect x="0" y="${H+90}" width="${W}" height="60" fill="${PAPER}" opacity=".5" rx="8"/>`;
      s += `<text x="${W/2}" y="${H+128}" text-anchor="middle" font-size="18" fill="${INK}" opacity=".65" letter-spacing="8" font-family="monospace">PUBLIKUM ↓</text>`;
      s += dimMarkup(W,H);

      // frihåndsstreger
      for(const st of state.strokes){
        const d = 'M ' + st.pts.map(p=>p[0]+','+p[1]).join(' L ');
        const sel = withSelection && selected && selected.kind==='stroke' && selected.id===st.id;
        s += `<g class="se-stroke" data-id="${st.id}" style="cursor:pointer">
          <path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(st.width+12,16)}" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="${d}" fill="none" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"/>
          ${sel?`<path d="${d}" fill="none" stroke="${SEL}" stroke-width="${st.width+6}" opacity=".35" stroke-linecap="round"/>`:''}
        </g>`;
      }
      // lige linjer / pile
      for(const ln of (state.lines||[])){
        const sel = withSelection && selected && selected.kind==='line' && selected.id===ln.id;
        let arrowHead = '';
        if (ln.arrow){
          const ang = Math.atan2(ln.y2-ln.y1, ln.x2-ln.x1);
          const len = 16, spread = 0.45;
          const ax = ln.x2 - len*Math.cos(ang-spread), ay = ln.y2 - len*Math.sin(ang-spread);
          const bx = ln.x2 - len*Math.cos(ang+spread), by = ln.y2 - len*Math.sin(ang+spread);
          arrowHead = `<polygon points="${ln.x2},${ln.y2} ${ax},${ay} ${bx},${by}" fill="${ln.color}"/>`;
        }
        s += `<g class="se-line" data-id="${ln.id}" style="cursor:pointer">
          <line x1="${ln.x1}" y1="${ln.y1}" x2="${ln.x2}" y2="${ln.y2}" stroke="transparent" stroke-width="${Math.max(ln.width+12,16)}" stroke-linecap="round"/>
          <line x1="${ln.x1}" y1="${ln.y1}" x2="${ln.x2}" y2="${ln.y2}" stroke="${ln.color}" stroke-width="${ln.width}" stroke-linecap="round"/>
          ${arrowHead}
          ${sel?`<line x1="${ln.x1}" y1="${ln.y1}" x2="${ln.x2}" y2="${ln.y2}" stroke="${SEL}" stroke-width="${ln.width+6}" opacity=".35" stroke-linecap="round"/>`:''}
        </g>`;
      }
      // rektangler
      for(const rc of (state.rects||[])){
        const sel = withSelection && selected && selected.kind==='rect' && selected.id===rc.id;
        s += `<g class="se-rect" data-id="${rc.id}" style="cursor:pointer">
          <rect x="${rc.x}" y="${rc.y}" width="${rc.w}" height="${rc.h}" fill="${rc.fill?rc.color:'transparent'}" fill-opacity="${rc.fill?0.22:1}" stroke="${rc.color}" stroke-width="${rc.width}"/>
          ${sel?`<rect x="${rc.x-3}" y="${rc.y-3}" width="${rc.w+6}" height="${rc.h+6}" fill="none" stroke="${SEL}" stroke-width="2" stroke-dasharray="7 5"/>`:''}
        </g>`;
      }
      // cirkler
      for(const c of (state.circles||[])){
        const sel = withSelection && selected && selected.kind==='circle' && selected.id===c.id;
        s += `<g class="se-circle" data-id="${c.id}" style="cursor:pointer">
          <circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="${c.fill?c.color:'transparent'}" fill-opacity="${c.fill?0.22:1}" stroke="${c.color}" stroke-width="${c.width}"/>
          ${sel?`<circle cx="${c.x}" cy="${c.y}" r="${c.r+4}" fill="none" stroke="${SEL}" stroke-width="2" stroke-dasharray="7 5"/>`:''}
        </g>`;
      }
      // elementer
      for(const el of state.elements){
        const def = DEFS[el.type]; if(!def) continue;
        const sel = withSelection && selected && selected.kind==='el' && selected.id===el.id;
        const bw = def.w+26, bh = def.h+26;
        s += `<g class="se-el" data-id="${el.id}" transform="translate(${el.x} ${el.y}) rotate(${el.rot}) scale(${el.scale})" style="cursor:grab">
          <rect x="${-bw/2}" y="${-bh/2}" width="${bw}" height="${bh}" fill="transparent"/>
          ${def.draw()}
          ${el.label?`<text y="${bh/2+16}" text-anchor="middle" font-size="15" font-weight="600" fill="${INK}">${esc(el.label)}</text>`:''}
          ${sel?`<rect x="${-bw/2}" y="${-bh/2}" width="${bw}" height="${bh}" fill="none" stroke="${SEL}" stroke-width="2.5" stroke-dasharray="7 5" rx="6"/>
                 <line x1="0" y1="${-bh/2}" x2="0" y2="${-bh/2-34}" stroke="${SEL}" stroke-width="2"/>
                 <circle class="se-rot" cx="0" cy="${-bh/2-42}" r="11" fill="${SEL}" style="cursor:crosshair"/>
                 <text y="${-bh/2-37}" text-anchor="middle" font-size="12" fill="#08111F" style="pointer-events:none">⟳</text>`:''}
        </g>`;
      }
      // tekstbokse (multi-linje)
      for(const t of state.texts){
        const sel = withSelection && selected && selected.kind==='text' && selected.id===t.id;
        const lines = String(t.text).split('\n');
        const lh = t.size*1.25;
        const maxLen = Math.max(...lines.map(l=>l.length), 1);
        const bw = maxLen*t.size*0.6 + 20, bh = lines.length*lh + 14;
        const tspans = lines.map((l,i)=>`<tspan x="0" y="${i*lh}">${esc(l)}</tspan>`).join('');
        s += `<g class="se-txt" data-id="${t.id}" transform="translate(${t.x} ${t.y})" style="cursor:grab">
          ${t.border?`<rect x="${-bw/2}" y="${-lh*0.8-7}" width="${bw}" height="${bh}" fill="#fff" fill-opacity=".55" stroke="${t.color}" stroke-width="1.5" rx="5"/>`:''}
          <text text-anchor="middle" font-size="${t.size}" font-weight="600" fill="${t.color}">${tspans}</text>
          ${sel?`<rect x="${-bw/2}" y="${-lh*0.8-7}" width="${bw}" height="${bh}" fill="none" stroke="${SEL}" stroke-width="2" stroke-dasharray="6 4"/>`:''}
        </g>`;
      }
      return s;
    }

    function render(){
      const W = state.stage.w*M, H = state.stage.h*M;
      svg.setAttribute('viewBox', `-90 -50 ${W+180} ${H+220}`);
      svg.innerHTML = sceneMarkup(true);
      $('#seStageW').value = state.stage.w;
      $('#seStageH').value = state.stage.h;
      renderProps();
    }
    function softRender(){ svg.innerHTML = sceneMarkup(true); }

    // ---------- Palette ----------
    const palList = $('#sePalList');
    for (const [type,def] of Object.entries(DEFS)){
      const b = document.createElement('button');
      b.className = 'se-pal-item'; b.dataset.type = type;
      const vb = Math.max(def.w,def.h)+30;
      b.innerHTML = `<svg viewBox="${-vb/2} ${-vb/2} ${vb} ${vb}">${def.draw().replaceAll(INK,'#D9CFBE')}</svg><span class="se-nm">${def.name}</span>`;
      palList.appendChild(b);
    }
    let palDrag = null;
    palList.addEventListener('pointerdown', e=>{
      const item = e.target.closest('.se-pal-item'); if(!item) return;
      palDrag = { type:item.dataset.type, x0:e.clientX, y0:e.clientY, moved:false };
      item.setPointerCapture(e.pointerId);
    });
    function onWinMove(e){
      if(!palDrag) return;
      if (Math.hypot(e.clientX-palDrag.x0, e.clientY-palDrag.y0) > 6) palDrag.moved = true;
      if (palDrag.moved){
        ghost.style.display='block'; ghost.textContent = DEFS[palDrag.type].name;
        ghost.style.left = e.clientX+'px'; ghost.style.top = e.clientY+'px';
      }
    }
    function onWinUp(e){
      if(!palDrag) return;
      ghost.style.display='none';
      const t = palDrag; palDrag = null;
      if (t.moved){
        const r = svg.getBoundingClientRect();
        if (e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom){
          const p = svgPt(e.clientX, e.clientY);
          addElement(t.type, clamp(p.x,0,state.stage.w*M), clamp(p.y,0,state.stage.h*M));
        }
      } else {
        addElement(t.type, state.stage.w*M/2, state.stage.h*M/2);
      }
    }
    function addElement(type,x,y){
      const el = {id:uid(), type, x:Math.round(snapv(x)), y:Math.round(snapv(y)), rot:0, scale:1, label:''};
      state.elements.push(el);
      selected = {kind:'el', id:el.id};
      commit(); render();
    }

    function svgPt(cx,cy){
      const pt = svg.createSVGPoint(); pt.x=cx; pt.y=cy;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }

    // ---------- Interaktion ----------
    let drag = null;
    let drawPrev = null;
    function removeDrawPreview(){ if(drawPrev){ drawPrev.remove(); drawPrev=null; } }

    svg.addEventListener('pointerdown', e=>{
      const p = svgPt(e.clientX, e.clientY);
      const sp = {x:snapv(p.x), y:snapv(p.y)};
      if (tool === 'pen'){
        const st = {id:uid(), color:$('#sePenColor').value, width:+$('#sePenWidth').value, pts:[[r1(p.x),r1(p.y)]]};
        drag = {kind:'pen', st};
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === 'line'){
        drag = {kind:'line', x1:sp.x, y1:sp.y};
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === 'rect'){
        drag = {kind:'rect', x0:sp.x, y0:sp.y};
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === 'circle'){
        drag = {kind:'circle', cx:sp.x, cy:sp.y};
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === 'text'){ placeTextInput(e.clientX, e.clientY, p); return; }
      // select-værktøj
      const rot = e.target.closest('.se-rot');
      if (rot){
        const g = e.target.closest('.se-el');
        const el = state.elements.find(x=>x.id===g.dataset.id);
        drag = {kind:'rotate', el};
        svg.setPointerCapture(e.pointerId);
        return;
      }
      const gEl = e.target.closest('.se-el');
      if (gEl){
        const el = state.elements.find(x=>x.id===gEl.dataset.id);
        selected = {kind:'el', id:el.id};
        drag = {kind:'el', el, dx:p.x-el.x, dy:p.y-el.y, moved:false};
        svg.setPointerCapture(e.pointerId);
        render(); return;
      }
      const gTxt = e.target.closest('.se-txt');
      if (gTxt){
        const t = state.texts.find(x=>x.id===gTxt.dataset.id);
        selected = {kind:'text', id:t.id};
        drag = {kind:'text', t, dx:p.x-t.x, dy:p.y-t.y, moved:false};
        svg.setPointerCapture(e.pointerId);
        render(); return;
      }
      const gLine = e.target.closest('.se-line');
      if (gLine){
        const ln = state.lines.find(x=>x.id===gLine.dataset.id);
        selected = {kind:'line', id:ln.id};
        drag = {kind:'moveline', ln, dx:p.x-ln.x1, dy:p.y-ln.y1, moved:false};
        svg.setPointerCapture(e.pointerId);
        render(); return;
      }
      const gRect = e.target.closest('.se-rect');
      if (gRect){
        const rc = state.rects.find(x=>x.id===gRect.dataset.id);
        selected = {kind:'rect', id:rc.id};
        drag = {kind:'moverect', rc, dx:p.x-rc.x, dy:p.y-rc.y, moved:false};
        svg.setPointerCapture(e.pointerId);
        render(); return;
      }
      const gCirc = e.target.closest('.se-circle');
      if (gCirc){
        const c = state.circles.find(x=>x.id===gCirc.dataset.id);
        selected = {kind:'circle', id:c.id};
        drag = {kind:'movecircle', c, dx:p.x-c.x, dy:p.y-c.y, moved:false};
        svg.setPointerCapture(e.pointerId);
        render(); return;
      }
      const gStroke = e.target.closest('.se-stroke');
      if (gStroke){ selected = {kind:'stroke', id:gStroke.dataset.id}; render(); return; }
      if (selected){ selected = null; render(); }
    });

    svg.addEventListener('pointermove', e=>{
      if(!drag) return;
      const p = svgPt(e.clientX, e.clientY);
      const sp = {x:snapv(p.x), y:snapv(p.y)};
      if (drag.kind==='pen'){
        const last = drag.st.pts[drag.st.pts.length-1];
        if (Math.hypot(p.x-last[0], p.y-last[1]) > 4) drag.st.pts.push([r1(p.x),r1(p.y)]);
        drawPenPreview(drag.st);
      } else if (drag.kind==='line'){
        let x2 = sp.x, y2 = sp.y;
        if (e.shiftKey){
          const ang = Math.atan2(y2-drag.y1, x2-drag.x1);
          const snapAng = Math.round(ang/(Math.PI/12))*(Math.PI/12);
          const len = Math.hypot(x2-drag.x1, y2-drag.y1);
          x2 = drag.x1 + len*Math.cos(snapAng); y2 = drag.y1 + len*Math.sin(snapAng);
        }
        drag.x2 = x2; drag.y2 = y2;
        drawShapePreview(`<line x1="${drag.x1}" y1="${drag.y1}" x2="${x2}" y2="${y2}" stroke="${$('#sePenColor').value}" stroke-width="${$('#sePenWidth').value}" stroke-linecap="round" stroke-dasharray="6 4"/>`);
      } else if (drag.kind==='rect'){
        let x1=drag.x0, y1=drag.y0, x2=sp.x, y2=sp.y;
        if (e.shiftKey){ const s = Math.max(Math.abs(x2-x1), Math.abs(y2-y1)); x2 = x1 + s*Math.sign(x2-x1||1); y2 = y1 + s*Math.sign(y2-y1||1); }
        drag.x2=x2; drag.y2=y2;
        const rx=Math.min(x1,x2), ry=Math.min(y1,y2), rw=Math.abs(x2-x1), rh=Math.abs(y2-y1);
        drawShapePreview(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${$('#sePenColor').value}" stroke-width="${$('#sePenWidth').value}" stroke-dasharray="6 4"/>`);
      } else if (drag.kind==='circle'){
        const rad = Math.hypot(sp.x-drag.cx, sp.y-drag.cy);
        drag.r = rad;
        drawShapePreview(`<circle cx="${drag.cx}" cy="${drag.cy}" r="${rad}" fill="none" stroke="${$('#sePenColor').value}" stroke-width="${$('#sePenWidth').value}" stroke-dasharray="6 4"/>`);
      } else if (drag.kind==='el'){
        drag.moved = true;
        drag.el.x = Math.round(snapv(clamp(p.x-drag.dx, -40, state.stage.w*M+40)));
        drag.el.y = Math.round(snapv(clamp(p.y-drag.dy, -40, state.stage.h*M+40)));
        const g = svg.querySelector(`.se-el[data-id="${drag.el.id}"]`);
        if (g) g.setAttribute('transform', `translate(${drag.el.x} ${drag.el.y}) rotate(${drag.el.rot}) scale(${drag.el.scale})`);
      } else if (drag.kind==='text'){
        drag.moved = true;
        drag.t.x = r1(p.x-drag.dx); drag.t.y = r1(p.y-drag.dy);
        const g = svg.querySelector(`.se-txt[data-id="${drag.t.id}"]`);
        if (g) g.setAttribute('transform', `translate(${drag.t.x} ${drag.t.y})`);
      } else if (drag.kind==='moveline'){
        drag.moved = true;
        const dx0 = p.x-drag.dx-drag.ln.x1, dy0 = p.y-drag.dy-drag.ln.y1;
        drag.ln.x1 += dx0; drag.ln.y1 += dy0; drag.ln.x2 += dx0; drag.ln.y2 += dy0;
        softRender();
      } else if (drag.kind==='moverect'){
        drag.moved = true;
        drag.rc.x = r1(p.x-drag.dx); drag.rc.y = r1(p.y-drag.dy);
        softRender();
      } else if (drag.kind==='movecircle'){
        drag.moved = true;
        drag.c.x = r1(p.x-drag.dx); drag.c.y = r1(p.y-drag.dy);
        softRender();
      } else if (drag.kind==='rotate'){
        const el = drag.el;
        const a = Math.atan2(p.y-el.y, p.x-el.x)*180/Math.PI + 90;
        el.rot = Math.round(((a%360)+360)%360);
        if (e.shiftKey) el.rot = Math.round(el.rot/15)*15;
        const g = svg.querySelector(`.se-el[data-id="${el.id}"]`);
        if (g) g.setAttribute('transform', `translate(${el.x} ${el.y}) rotate(${el.rot}) scale(${el.scale})`);
        syncPropsLive();
      }
    });

    svg.addEventListener('pointerup', e=>{
      if(!drag) return;
      const d = drag; drag = null;
      if (d.kind==='pen'){
        removeDrawPreview();
        if (d.st.pts.length > 1){ state.strokes.push(d.st); selected={kind:'stroke',id:d.st.id}; commit(); }
        render(); return;
      }
      if (d.kind==='line'){
        removeDrawPreview();
        if (d.x2!=null && Math.hypot(d.x2-d.x1, d.y2-d.y1) > 3){
          const ln = {id:uid(), x1:r1(d.x1), y1:r1(d.y1), x2:r1(d.x2), y2:r1(d.y2), color:$('#sePenColor').value, width:+$('#sePenWidth').value, arrow:$('#seArrow').checked};
          state.lines.push(ln); selected = {kind:'line', id:ln.id}; commit();
        }
        render(); return;
      }
      if (d.kind==='rect'){
        removeDrawPreview();
        if (d.x2!=null){
          const rw = Math.abs(d.x2-d.x0), rh = Math.abs(d.y2-d.y0);
          if (rw > 3 && rh > 3){
            const rc = {id:uid(), x:r1(Math.min(d.x0,d.x2)), y:r1(Math.min(d.y0,d.y2)), w:r1(rw), h:r1(rh), color:$('#sePenColor').value, width:+$('#sePenWidth').value, fill:$('#seFill').checked};
            state.rects.push(rc); selected = {kind:'rect', id:rc.id}; commit();
          }
        }
        render(); return;
      }
      if (d.kind==='circle'){
        removeDrawPreview();
        if (d.r > 3){
          const c = {id:uid(), x:r1(d.cx), y:r1(d.cy), r:r1(d.r), color:$('#sePenColor').value, width:+$('#sePenWidth').value, fill:$('#seFill').checked};
          state.circles.push(c); selected = {kind:'circle', id:c.id}; commit();
        }
        render(); return;
      }
      if (d.kind==='rotate' || ((d.kind==='el'||d.kind==='text'||d.kind==='moveline'||d.kind==='moverect'||d.kind==='movecircle') && d.moved)){ commit(); render(); return; }
      render();
    });

    let penPrev = null;
    function drawPenPreview(st){
      const d = 'M ' + st.pts.map(p=>p[0]+','+p[1]).join(' L ');
      if (!penPrev){
        penPrev = document.createElementNS('http://www.w3.org/2000/svg','path');
        penPrev.setAttribute('fill','none'); penPrev.setAttribute('stroke-linecap','round'); penPrev.setAttribute('stroke-linejoin','round');
        svg.appendChild(penPrev);
      }
      penPrev.setAttribute('stroke', st.color); penPrev.setAttribute('stroke-width', st.width);
      penPrev.setAttribute('d', d);
    }
    function removeDrawPreview2(){ if(penPrev){ penPrev.remove(); penPrev=null; } }
    const _origRemoveDrawPreview = removeDrawPreview;
    removeDrawPreview = function(){ _origRemoveDrawPreview(); removeDrawPreview2(); };

    function drawShapePreview(markup){
      removeDrawPreview();
      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('id','seDrawPrev');
      g.innerHTML = markup;
      svg.appendChild(g);
      drawPrev = g;
    }

    // ---------- Tekst-værktøj ----------
    let pendingText = null;
    function placeTextInput(cx,cy,p){
      pendingText = {x:r1(p.x), y:r1(p.y)};
      textFloat.style.display='block';
      textFloat.style.left = cx+'px'; textFloat.style.top = cy+'px';
      textFloat.value=''; textFloat.focus();
    }
    function commitText(){
      if (pendingText && textFloat.value.trim()){
        state.texts.push({id:uid(), x:pendingText.x, y:pendingText.y, text:textFloat.value.trim(), size:22, color:$('#sePenColor').value, border:false});
        selected = {kind:'text', id:state.texts[state.texts.length-1].id};
        commit();
      }
      pendingText=null; textFloat.style.display='none'; render();
    }
    textFloat.addEventListener('keydown', e=>{
      if (e.key==='Enter' && (e.ctrlKey||e.metaKey)) commitText();
      if (e.key==='Escape'){ pendingText=null; textFloat.style.display='none'; }
    });
    textFloat.addEventListener('blur', commitText);

    // ---------- Egenskabspanel ----------
    function findSel(){
      if(!selected) return null;
      if(selected.kind==='el') return state.elements.find(x=>x.id===selected.id);
      if(selected.kind==='text') return state.texts.find(x=>x.id===selected.id);
      if(selected.kind==='stroke') return state.strokes.find(x=>x.id===selected.id);
      if(selected.kind==='line') return state.lines.find(x=>x.id===selected.id);
      if(selected.kind==='rect') return state.rects.find(x=>x.id===selected.id);
      if(selected.kind==='circle') return state.circles.find(x=>x.id===selected.id);
      return null;
    }
    function renderProps(){
      const obj = findSel();
      if(!obj){
        propsCard.innerHTML = `<h3>Egenskaber</h3><div class="se-props-empty">Vælg et element på scenen for at redigere det.<br><br>
        <b>Linje</b> tegnes med klik-og-træk (hold <b>Shift</b> for 15°-vinkler). <b>Rektangel</b>/<b>Cirkel</b> trækkes ud fra første klik. <b>Tekstboks</b> understøtter flere linjer (Enter = ny linje, Ctrl+Enter = gem).<br><br>
        Genveje: <b>Delete</b> sletter valgte · <b>Ctrl+Z/Y</b> fortryd/gendan · <b>Ctrl+D</b> duplikér.</div>`;
        return;
      }
      if (selected.kind==='el'){
        const def = DEFS[obj.type];
        propsCard.innerHTML = `<h3>${def.name}</h3>
          <div class="se-field"><label>Navn / label</label><input class="se-input" id="pLabel" value="${esc(obj.label)}" placeholder="fx Jonas — vokal"></div>
          <div class="se-field"><label>Rotation</label><div class="se-rowval"><input type="range" id="pRot" min="0" max="359" value="${obj.rot}" style="flex:1"><output id="pRotOut">${obj.rot}°</output></div></div>
          <div class="se-field"><label>Størrelse</label><div class="se-rowval"><input type="range" id="pScale" min="0.5" max="2.5" step="0.05" value="${obj.scale}" style="flex:1"><output id="pScaleOut">${Math.round(obj.scale*100)}%</output></div></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet element</button>`;
        $('#pLabel').addEventListener('input', ()=>{ obj.label = $('#pLabel').value; softRender(); });
        $('#pLabel').addEventListener('change', ()=>commit());
        $('#pRot').addEventListener('input', ()=>{ obj.rot=+$('#pRot').value; $('#pRotOut').textContent=obj.rot+'°'; softRender(); });
        $('#pRot').addEventListener('change', ()=>commit());
        $('#pScale').addEventListener('input', ()=>{ obj.scale=+$('#pScale').value; $('#pScaleOut').textContent=Math.round(obj.scale*100)+'%'; softRender(); });
        $('#pScale').addEventListener('change', ()=>commit());
        $('#pDel').addEventListener('click', ()=>{ state.elements = state.elements.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      } else if (selected.kind==='text'){
        propsCard.innerHTML = `<h3>Tekstboks</h3>
          <div class="se-field"><label>Tekst</label><textarea class="se-input" id="pText" rows="3">${esc(obj.text)}</textarea></div>
          <div class="se-field"><label>Størrelse</label><div class="se-rowval"><input type="range" id="pSize" min="12" max="60" value="${obj.size}" style="flex:1"><output id="pSizeOut">${obj.size}</output></div></div>
          <div class="se-field"><label>Farve</label><input type="color" id="pColor" value="${obj.color}"></div>
          <div class="se-field"><label class="se-check"><input type="checkbox" id="pBorder" ${obj.border?'checked':''}> Vis boks-ramme</label></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet tekstboks</button>`;
        $('#pText').addEventListener('input', ()=>{ obj.text=$('#pText').value; softRender(); });
        $('#pText').addEventListener('change', ()=>commit());
        $('#pSize').addEventListener('input', ()=>{ obj.size=+$('#pSize').value; $('#pSizeOut').textContent=obj.size; softRender(); });
        $('#pSize').addEventListener('change', ()=>commit());
        $('#pColor').addEventListener('input', ()=>{ obj.color=$('#pColor').value; softRender(); });
        $('#pColor').addEventListener('change', ()=>commit());
        $('#pBorder').addEventListener('change', ()=>{ obj.border=$('#pBorder').checked; softRender(); commit(); });
        $('#pDel').addEventListener('click', ()=>{ state.texts = state.texts.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      } else if (selected.kind==='stroke'){
        propsCard.innerHTML = `<h3>Frihåndsstreg</h3>
          <div class="se-field"><label>Farve</label><input type="color" id="pColor" value="${obj.color}"></div>
          <div class="se-field"><label>Tykkelse</label><div class="se-rowval"><input type="range" id="pWidth" min="2" max="14" value="${obj.width}" style="flex:1"><output id="pWOut">${obj.width}</output></div></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet streg</button>`;
        $('#pColor').addEventListener('input', ()=>{ obj.color=$('#pColor').value; softRender(); });
        $('#pColor').addEventListener('change', ()=>commit());
        $('#pWidth').addEventListener('input', ()=>{ obj.width=+$('#pWidth').value; $('#pWOut').textContent=obj.width; softRender(); });
        $('#pWidth').addEventListener('change', ()=>commit());
        $('#pDel').addEventListener('click', ()=>{ state.strokes = state.strokes.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      } else if (selected.kind==='line'){
        propsCard.innerHTML = `<h3>Linje</h3>
          <div class="se-field"><label>Farve</label><input type="color" id="pColor" value="${obj.color}"></div>
          <div class="se-field"><label>Tykkelse</label><div class="se-rowval"><input type="range" id="pWidth" min="2" max="14" value="${obj.width}" style="flex:1"><output id="pWOut">${obj.width}</output></div></div>
          <div class="se-field"><label class="se-check"><input type="checkbox" id="pArrow" ${obj.arrow?'checked':''}> Pilespids</label></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet linje</button>`;
        $('#pColor').addEventListener('input', ()=>{ obj.color=$('#pColor').value; softRender(); });
        $('#pColor').addEventListener('change', ()=>commit());
        $('#pWidth').addEventListener('input', ()=>{ obj.width=+$('#pWidth').value; $('#pWOut').textContent=obj.width; softRender(); });
        $('#pWidth').addEventListener('change', ()=>commit());
        $('#pArrow').addEventListener('change', ()=>{ obj.arrow=$('#pArrow').checked; softRender(); commit(); });
        $('#pDel').addEventListener('click', ()=>{ state.lines = state.lines.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      } else if (selected.kind==='rect'){
        propsCard.innerHTML = `<h3>Rektangel</h3>
          <div class="se-field"><label>Farve</label><input type="color" id="pColor" value="${obj.color}"></div>
          <div class="se-field"><label>Kantlinje</label><div class="se-rowval"><input type="range" id="pWidth" min="1" max="14" value="${obj.width}" style="flex:1"><output id="pWOut">${obj.width}</output></div></div>
          <div class="se-field"><label class="se-check"><input type="checkbox" id="pFill" ${obj.fill?'checked':''}> Fyld med farve</label></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet rektangel</button>`;
        $('#pColor').addEventListener('input', ()=>{ obj.color=$('#pColor').value; softRender(); });
        $('#pColor').addEventListener('change', ()=>commit());
        $('#pWidth').addEventListener('input', ()=>{ obj.width=+$('#pWidth').value; $('#pWOut').textContent=obj.width; softRender(); });
        $('#pWidth').addEventListener('change', ()=>commit());
        $('#pFill').addEventListener('change', ()=>{ obj.fill=$('#pFill').checked; softRender(); commit(); });
        $('#pDel').addEventListener('click', ()=>{ state.rects = state.rects.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      } else if (selected.kind==='circle'){
        propsCard.innerHTML = `<h3>Cirkel</h3>
          <div class="se-field"><label>Farve</label><input type="color" id="pColor" value="${obj.color}"></div>
          <div class="se-field"><label>Kantlinje</label><div class="se-rowval"><input type="range" id="pWidth" min="1" max="14" value="${obj.width}" style="flex:1"><output id="pWOut">${obj.width}</output></div></div>
          <div class="se-field"><label class="se-check"><input type="checkbox" id="pFill" ${obj.fill?'checked':''}> Fyld med farve</label></div>
          <button class="se-btn se-btn-danger se-btn-sm" id="pDel" style="width:100%">Slet cirkel</button>`;
        $('#pColor').addEventListener('input', ()=>{ obj.color=$('#pColor').value; softRender(); });
        $('#pColor').addEventListener('change', ()=>commit());
        $('#pWidth').addEventListener('input', ()=>{ obj.width=+$('#pWidth').value; $('#pWOut').textContent=obj.width; softRender(); });
        $('#pWidth').addEventListener('change', ()=>commit());
        $('#pFill').addEventListener('change', ()=>{ obj.fill=$('#pFill').checked; softRender(); commit(); });
        $('#pDel').addEventListener('click', ()=>{ state.circles = state.circles.filter(x=>x.id!==obj.id); selected=null; commit(); render(); });
      }
    }
    function syncPropsLive(){
      const obj = findSel();
      if (obj && selected.kind==='el'){
        const r = $('#pRot'), o = $('#pRotOut');
        if (r){ r.value = obj.rot; o.textContent = obj.rot+'°'; }
      }
    }

    // ---------- Værktøjsskift ----------
    toolPill.addEventListener('click', e=>{
      const b = e.target.closest('button'); if(!b) return;
      tool = b.dataset.tool;
      toolPill.querySelectorAll('button').forEach(x=>x.classList.toggle('on', x===b));
      const drawTools = ['pen','line','rect','circle'];
      $('#seDrawOpts').style.display = drawTools.indexOf(tool)!==-1 ? 'flex' : 'none';
      $('#seArrowLbl').style.display = tool==='line' ? 'inline-flex' : 'none';
      $('#seFillLbl').style.display = (tool==='rect'||tool==='circle') ? 'inline-flex' : 'none';
      svg.style.cursor = tool==='pen' ? 'crosshair' : (tool==='text' ? 'text' : (drawTools.indexOf(tool)!==-1 ? 'crosshair' : 'default'));
    });

    // ---------- Scene-størrelse ----------
    $('#seStageW').addEventListener('change', ()=>{ state.stage.w = clamp(+$('#seStageW').value||8, 2, 24); commit(); render(); });
    $('#seStageH').addEventListener('change', ()=>{ state.stage.h = clamp(+$('#seStageH').value||6, 2, 20); commit(); render(); });
    $('#seSnap').addEventListener('change', ()=>{ snap = $('#seSnap').checked; });

    // ---------- Zoom ----------
    function applyZoom(){ svgBox.style.width = Math.round((holder.clientWidth-44)*zoom)+'px'; }
    $('#seZoomIn').addEventListener('click', ()=>{ zoom = Math.min(zoom*1.25, 4); applyZoom(); });
    $('#seZoomOut').addEventListener('click', ()=>{ zoom = Math.max(zoom/1.25, .4); applyZoom(); });
    $('#seZoomFit').addEventListener('click', ()=>{ zoom = 1; applyZoom(); });
    function onWinResize(){ applyZoom(); }

    // ---------- Topbar ----------
    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);
    $('#seClear').addEventListener('click', ()=>{
      if (confirm('Ryd hele sceneplanen? (Kan fortrydes med Ctrl+Z)')){
        state = {stage:{...state.stage}, elements:[], strokes:[], lines:[], rects:[], circles:[], texts:[]};
        selected=null; commit(); render();
      }
    });
    $('#seJson').addEventListener('click', ()=>{
      const blob = new Blob([JSON.stringify(state,null,2)], {type:'application/json'});
      dl(URL.createObjectURL(blob), 'sceneplan.json');
    });
    $('#sePng').addEventListener('click', ()=> renderPng().then(({url})=> dl(url,'sceneplan.png')));
    function dl(url,name){ const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000); }

    function svgString(){
      const W = state.stage.w*M, H = state.stage.h*M;
      const vb = `-90 -50 ${W+180} ${H+220}`;
      const keep = selected; selected = null;
      const body = sceneMarkup(false);
      selected = keep;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${(W+180)*2}" height="${(H+220)*2}" font-family="Arial, sans-serif"><rect x="-90" y="-50" width="${W+180}" height="${H+220}" fill="#FBF9F4"/>${body}</svg>`;
    }
    function renderPng(){
      return new Promise((resolve, reject)=>{
        const str = svgString();
        const img = new Image();
        const url = URL.createObjectURL(new Blob([str],{type:'image/svg+xml;charset=utf-8'}));
        img.onload = ()=>{
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          c.getContext('2d').drawImage(img,0,0);
          URL.revokeObjectURL(url);
          c.toBlob(b=>{
            const durl = URL.createObjectURL(b);
            resolve({blob:b, url:durl});
          },'image/png');
        };
        img.onerror = reject;
        img.src = url;
      });
    }
    function blobToBase64(blob){
      return new Promise((resolve,reject)=>{
        const r = new FileReader();
        r.onload = ()=> resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    }

    function destroy(){
      if (closed) return;
      closed = true;
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    $('#seCancel').addEventListener('click', ()=>{
      destroy();
      if (typeof opts.onClose === 'function') opts.onClose();
    });

    $('#sePublish').addEventListener('click', async ()=>{
      const btn = $('#sePublish');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Gemmer…';
      try {
        const { blob } = await renderPng();
        const dataBase64 = await blobToBase64(blob);
        const stateJson = JSON.stringify(state);
        if (typeof opts.onPublish === 'function'){
          await opts.onPublish({ dataBase64, contentType:'image/png', filename:'sceneplan.png', stateJson });
        }
        destroy();
      } catch(e){
        btn.disabled = false; btn.textContent = orig;
        alert('Kunne ikke publicere sceneplan: ' + (e && e.message || e));
      }
    });

    function onKeyDown(e){
      if (e.target && e.target.matches && e.target.matches('input,textarea')) return;
      if ((e.key==='Delete'||e.key==='Backspace') && selected){
        if(selected.kind==='el') state.elements = state.elements.filter(x=>x.id!==selected.id);
        if(selected.kind==='text') state.texts = state.texts.filter(x=>x.id!==selected.id);
        if(selected.kind==='stroke') state.strokes = state.strokes.filter(x=>x.id!==selected.id);
        if(selected.kind==='line') state.lines = state.lines.filter(x=>x.id!==selected.id);
        if(selected.kind==='rect') state.rects = state.rects.filter(x=>x.id!==selected.id);
        if(selected.kind==='circle') state.circles = state.circles.filter(x=>x.id!==selected.id);
        selected=null; commit(); render(); e.preventDefault();
      }
      if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.shiftKey){ undo(); e.preventDefault(); }
      if ((e.ctrlKey||e.metaKey) && (e.key.toLowerCase()==='y' || (e.key.toLowerCase()==='z' && e.shiftKey))){ redo(); e.preventDefault(); }
      if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='d' && selected){
        e.preventDefault();
        const obj = findSel(); if (!obj) return;
        const copy = JSON.parse(JSON.stringify(obj));
        copy.id = uid();
        if ('x' in copy) copy.x = (copy.x||0) + 20;
        if ('y' in copy) copy.y = (copy.y||0) + 20;
        if ('x1' in copy){ copy.x1+=20; copy.y1+=20; copy.x2+=20; copy.y2+=20; }
        if (selected.kind==='el') state.elements.push(copy);
        if (selected.kind==='text') state.texts.push(copy);
        if (selected.kind==='line') state.lines.push(copy);
        if (selected.kind==='rect') state.rects.push(copy);
        if (selected.kind==='circle') state.circles.push(copy);
        selected = {kind:selected.kind, id:copy.id};
        commit(); render();
      }
      if (e.key==='Escape' && !document.getElementById('seTextFloat')){ /* no-op, modal has own close btn */ }
    }

    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('resize', onWinResize);
    window.addEventListener('keydown', onKeyDown);

    return { overlay, render, applyZoom, updateUndoBtns, destroy };
  }

  function open(opts){
    injectStyle();
    const inst = createInstance(opts || {});
    document.body.appendChild(inst.overlay);
    inst.render();
    inst.applyZoom();
    inst.updateUndoBtns();
    return { close: inst.destroy };
  }

  return { open };
})();
