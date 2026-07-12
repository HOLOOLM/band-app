// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// Band branding/config (henter via actGetConfig ved boot). DMD_LOGO_B64 fyldes ud før første render.
let BAND_CONFIG = { bandName: '', bandShortName: '', bandTagline: '', emailDomain: '', theme: 'kul', primaryColor: '#8A8A8A', primaryColorSoft: '#A8A8A8', primaryColorDeep: '#5C5C5C', bgColor: '', textColor: '', fontUi: '', fontDisplay: '', contactName: '', contactEmail: '', contactPhone: '', contactAddress: '', techContactName: '', techContactPhone: '', bankName: '', bankReg: '', bankKto: '', payeeName: '', payeeAddress: '', logoDataUrl: '', hasRider: false, hasSceneplan: false };
function _b(k){ return (BAND_CONFIG && BAND_CONFIG[k]) || ''; }
let DMD_LOGO_B64 = '';

// Fem neutrale temaer. Hvert tema styrer baggrund (ink*), tekst (cream*),
// panel-/feltbaggrunde OG fonten (fontUi = brødtekst/UI, fontDisplay = overskrifter).
// Accentfarven sættes uafhængigt af bandets primaryColor, så ethvert band kan
// kombinere sin egen farve med et hvilket som helst tema.
const THEMES = {
  kul:    { label:'Kul (sort)',        inkDeep:'#0A0A0A', ink:'#141414', inkSoft:'#1E1E1E', inkLine:'#2C2C2C', inkLineSoft:'rgba(255,255,255,.06)', inkLineStrong:'rgba(255,255,255,.16)', cream:'#F2F2F2', creamDim:'#C9C9C9', creamMute:'#8A8A8A', panel:'rgba(255,255,255,.05)', panel2:'rgba(255,255,255,.02)', fieldBg:'rgba(0,0,0,.35)', shadowCard:'0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.5)', fontUi:'"Inter",-apple-system,BlinkMacSystemFont,sans-serif', fontDisplay:'"Instrument Serif","Times New Roman",serif' },
  grafit: { label:'Grafit (kølig grå)', inkDeep:'#101316', ink:'#181C20', inkSoft:'#22272C', inkLine:'#313840', inkLineSoft:'rgba(232,235,238,.06)', inkLineStrong:'rgba(232,235,238,.16)', cream:'#E8EBEE', creamDim:'#BCC2C8', creamMute:'#7E868E', panel:'rgba(255,255,255,.045)', panel2:'rgba(255,255,255,.018)', fieldBg:'rgba(0,0,0,.3)', shadowCard:'0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.45)', fontUi:'"Space Grotesk",sans-serif', fontDisplay:'"Space Grotesk",sans-serif' },
  beton:  { label:'Beton (varm grå)',  inkDeep:'#161513', ink:'#201E1B', inkSoft:'#2B2825', inkLine:'#3A3633', inkLineSoft:'rgba(238,234,228,.06)', inkLineStrong:'rgba(238,234,228,.16)', cream:'#EEEAE4', creamDim:'#C8C2B8', creamMute:'#8C857A', panel:'rgba(255,255,255,.04)', panel2:'rgba(255,255,255,.016)', fieldBg:'rgba(0,0,0,.28)', shadowCard:'0 1px 0 rgba(255,255,255,.035) inset, 0 8px 24px rgba(0,0,0,.45)', fontUi:'"IBM Plex Sans",sans-serif', fontDisplay:'"IBM Plex Serif",Georgia,serif' },
  stål:   { label:'Stål (blågrå)',     inkDeep:'#0E1214', ink:'#161B1E', inkSoft:'#1F262A', inkLine:'#2D363B', inkLineSoft:'rgba(230,234,236,.06)', inkLineStrong:'rgba(230,234,236,.16)', cream:'#E6EAEC', creamDim:'#BAC1C5', creamMute:'#7C858B', panel:'rgba(255,255,255,.045)', panel2:'rgba(255,255,255,.018)', fieldBg:'rgba(0,0,0,.3)', shadowCard:'0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.45)', fontUi:'"Inter",-apple-system,BlinkMacSystemFont,sans-serif', fontDisplay:'"Fraunces",Georgia,serif' },
  tåge:   { label:'Tåge (lys koldgrå)', inkDeep:'#1A1C1E', ink:'#242729', inkSoft:'#2F3336', inkLine:'#3E4347', inkLineSoft:'rgba(236,238,240,.06)', inkLineStrong:'rgba(236,238,240,.16)', cream:'#ECEEF0', creamDim:'#C2C6C9', creamMute:'#868B8F', panel:'rgba(255,255,255,.05)', panel2:'rgba(255,255,255,.022)', fieldBg:'rgba(0,0,0,.25)', shadowCard:'0 1px 0 rgba(255,255,255,.045) inset, 0 8px 24px rgba(0,0,0,.4)', fontUi:'"Space Grotesk",sans-serif', fontDisplay:'"Instrument Serif","Times New Roman",serif' }
};
const DEFAULT_THEME = 'kul';

function _applyThemeVars(themeName) {
  const t = THEMES[themeName] || THEMES[DEFAULT_THEME];
  const r = document.documentElement;
  r.style.setProperty('--ink-deep', t.inkDeep);
  r.style.setProperty('--ink', t.ink);
  r.style.setProperty('--ink-soft', t.inkSoft);
  r.style.setProperty('--ink-line', t.inkLine);
  r.style.setProperty('--ink-line-soft', t.inkLineSoft);
  r.style.setProperty('--ink-line-strong', t.inkLineStrong);
  r.style.setProperty('--cream', t.cream);
  r.style.setProperty('--cream-dim', t.creamDim);
  r.style.setProperty('--cream-mute', t.creamMute);
  r.style.setProperty('--panel', t.panel);
  r.style.setProperty('--panel-2', t.panel2);
  r.style.setProperty('--field-bg', t.fieldBg);
  r.style.setProperty('--shadow-card', t.shadowCard);
  r.style.setProperty('--font-ui', t.fontUi);
  r.style.setProperty('--font-display', t.fontDisplay);
}

// Font-valg der kan overstyre temaets font. Keys skal matche VALID_FONTS i Code.gs.
const FONT_OPTIONS = {
  'Inter':            '"Inter",-apple-system,BlinkMacSystemFont,sans-serif',
  'Space Grotesk':    '"Space Grotesk",sans-serif',
  'IBM Plex Sans':    '"IBM Plex Sans",sans-serif',
  'Instrument Serif': '"Instrument Serif","Times New Roman",serif',
  'IBM Plex Serif':   '"IBM Plex Serif",Georgia,serif',
  'Fraunces':         '"Fraunces",Georgia,serif'
};
const _isHex = v => /^#[0-9A-Fa-f]{6}$/.test(String(v||''));

/**
 * Lægger bandets frie HEX-/font-overrides oven på det valgte tema.
 * Tomme felter = behold temaets værdi. Baggrunds-/tekstnuancer udledes
 * automatisk (ligesom accent-soft/deep), så man kun behøver angive én farve.
 */
function _applyAppearanceOverrides(c){
  const r = document.documentElement;
  if (_isHex(c.bgColor)){
    r.style.setProperty('--ink-deep', c.bgColor);
    r.style.setProperty('--ink', _hexLighten(c.bgColor, 6));
    r.style.setProperty('--ink-soft', _hexLighten(c.bgColor, 12));
    r.style.setProperty('--ink-line', _hexLighten(c.bgColor, 22));
  }
  if (_isHex(c.textColor)){
    r.style.setProperty('--cream', c.textColor);
    r.style.setProperty('--cream-dim', _hexDarken(c.textColor, 15));
    r.style.setProperty('--cream-mute', _hexDarken(c.textColor, 38));
  }
  if (c.fontUi && FONT_OPTIONS[c.fontUi]) r.style.setProperty('--font-ui', FONT_OPTIONS[c.fontUi]);
  if (c.fontDisplay && FONT_OPTIONS[c.fontDisplay]) r.style.setProperty('--font-display', FONT_OPTIONS[c.fontDisplay]);
}

function _hexLighten(hex, pct) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const nr = Math.min(255, r + Math.round((255-r)*pct/100));
  const ng = Math.min(255, g + Math.round((255-g)*pct/100));
  const nb = Math.min(255, b + Math.round((255-b)*pct/100));
  return '#'+[nr,ng,nb].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function _hexDarken(hex, pct) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const nr = Math.max(0, r - Math.round(r*pct/100));
  const ng = Math.max(0, g - Math.round(g*pct/100));
  const nb = Math.max(0, b - Math.round(b*pct/100));
  return '#'+[nr,ng,nb].map(v=>v.toString(16).padStart(2,'0')).join('');
}
// ──────────────────────────────────────────────────────────────────────
// CONFIG — Frontend taler KUN med Cloudflare Worker'en på samme origin (/api/...).
// SCRIPT_URL (Apps Script /exec) og APP_TOKEN er flyttet server-side ind i
// Worker'en og findes bevidst IKKE længere i browseren. Auth holdes af en
// httpOnly session-cookie, som JavaScript ikke kan læse.
// ──────────────────────────────────────────────────────────────────────

// Multi-tenant: bandId læses fra URL'en (?band=mit-band). Samme HTML serverer N bands.
const BAND_ID = new URLSearchParams(location.search).get('band') || '';

// Operatør-mode: ?band=__operator åbner det samlede admin-/operatør-UI.
// Det ægte operatør-token lever nu server-side i Worker'en (gemt i KV, bundet til
// den httpOnly session-cookie). OPERATOR_TOKEN her er kun en boolean-sentinel der
// siger "logget ind" til UI-logikken — selve tokenet findes aldrig i browseren.
const OPERATOR_MODE = (BAND_ID === '__operator');
let OPERATOR_TOKEN = null;

// Booker-mode: ?band=__booker åbner booking-agent-portalen (Fase B/C). Samme
// mønster som OPERATOR_MODE — bt:-tokenet lever server-side i Worker'ens KV,
// bundet til den httpOnly session-cookie; BOOKER_SESSION her er kun en
// klient-side sentinel/profil-cache, aldrig selve credentiallet.
const BOOKER_MODE = (BAND_ID === '__booker');
let BOOKER_SESSION = null;

// State
let SESSION = null; // { email, hash, role, member }
let CACHE = { members: null, contracts: null, dashboard: null, invoices: null, bookings: null, _stamp: {} };
const CACHE_TTL_MS = 45 * 1000;
const CACHE_TTL_PER_KEY = { dashboard: 90 * 1000, invoices: 90 * 1000 };
function cacheFresh(key){ const t = CACHE._stamp[key]; return t && (Date.now() - t) < (CACHE_TTL_PER_KEY[key] || CACHE_TTL_MS); }
function cacheTouch(key){ CACHE._stamp[key] = Date.now(); }
function cacheBust(key){ delete CACHE._stamp[key]; if (key in CACHE) CACHE[key] = null; }

/**
 * Cross-tab cache-invalidering via BroadcastChannel.
 * Når én tab gemmer noget, lytter andre tabs og buster deres cache + re-render
 * hvis de står på den relevante side. Gratis, ingen Apps Script-quota.
 */
const _bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('bandapp') : null;
function broadcastInvalidate(keys){
  if (!_bc) return;
  try { _bc.postMessage({ type: 'invalidate', keys: keys, ts: Date.now() }); } catch(e){}
}
if (_bc){
  _bc.onmessage = (ev)=>{
    if (!ev.data || ev.data.type !== 'invalidate') return;
    (ev.data.keys||[]).forEach(k => cacheBust(k));
    // Re-render hvis vi står på en side der bruger den invaliderede cache
    if (ev.data.keys.includes('contracts') && ADMIN_ROUTE === 'contracts') renderContractsList();
    if (ev.data.keys.includes('dashboard') && ADMIN_ROUTE === 'dashboard') renderDashboard();
    if (ev.data.keys.includes('members') && ADMIN_ROUTE === 'members') renderMembers();
    if (ev.data.keys.includes('invoices') && ADMIN_ROUTE === 'invoices') renderInvoicesList();
  };
}

// Pre-warm common admin data lige efter login så side-skift føles hurtigere.
// Fire-and-forget; fejl ignoreres (de viser sig når brugeren navigerer derhen).
function prewarmAdminCaches(){
  if (!CACHE.contracts || !cacheFresh('contracts')){
    apiGet('getContracts').then(d => { if (d && d.ok){ CACHE.contracts = d.contracts; cacheTouch('contracts'); } }).catch(()=>{});
  }
  if (!CACHE.members || !cacheFresh('members')){
    apiGet('getMembers').then(d => { if (d && d.ok){ CACHE.members = d.members; cacheTouch('members'); } }).catch(()=>{});
  }
  if (BAND_CONFIG.booking && (!CACHE.bookings || !cacheFresh('bookings'))){
    apiGet('listIncomingBookings').then(d => { if (d && d.ok){ CACHE.bookings = d.bookings; cacheTouch('bookings'); _updateBookingsBadge(); } }).catch(()=>{});
  }
}

// Viser antal bookinger der afventer bandets godkendelse ("sent") som et rødt
// tal i sidebar-navigationen. Kun synlig når BAND_CONFIG.booking er slået til
// (se applyBranding i 09-boot.js, som også toggler selve nav-punktets display).
function _updateBookingsBadge(){
  const n = (CACHE.bookings || []).filter(b => b.status === 'sent').length;
  document.querySelectorAll('[data-route="bookings"] .nav-badge').forEach(el => {
    el.textContent = n ? String(n) : '';
    el.style.display = n ? '' : 'none';
  });
}

// ─── Auth helpers ──────────────────────────────────────────────────
async function sha256hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/**
 * Unified API-kald via POST med text/plain (undgår CORS-preflight).
 * Real JSON-response → ordentlig fejlhåndtering i DevTools.
 * Erstatter den gamle JSONP-baserede apiGet.
 */
async function _apiCall(action, params){
  // Kald går til Worker'en på samme origin. Credentials/appToken injiceres
  // server-side ud fra session-cookien — frontend sender dem ALDRIG.
  const body = Object.assign({ action: action, bandId: BAND_ID }, params || {});
  const ctrl = new AbortController();
  const timeoutId = setTimeout(()=> ctrl.abort(), 30000);
  try {
    const res = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',   // sender httpOnly session-cookien med
      signal: ctrl.signal
    });
    if (res.status === 401){
      // Session udløbet/ugyldig server-side — log ud lokalt så UI'et matcher.
      if (typeof logout === 'function' && SESSION) logout();
      throw new Error('Session udløbet — log venligst ind igen');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch(e){
      throw new Error('Ugyldigt svar fra server — prøv igen senere');
    }
  } catch(e){
    if (e.name === 'AbortError') throw new Error('Timeout — serveren svarede ikke inden 30 sek');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

const apiGet  = (action, params) => _apiCall(action, params);
const apiPost = (action, payload) => _apiCall(action, payload);

function showErr(elId, msg){
  const el = document.getElementById(elId);
  el.textContent = msg; el.classList.add('show');
}
function clearErr(elId){ document.getElementById(elId).classList.remove('show'); }

function toast(msg, kind){
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; }, 2000);
  setTimeout(()=>{ if(t.parentNode) t.parentNode.removeChild(t); }, 2400);
}

// Kører en async handling med spinner + deaktiveret knap, så brugeren får
// feedback og ikke kan klikke igen (fx upload der ellers kørte flere gange).
// btn = knap-elementet (typisk `this` fra onclick). label = tekst under arbejde.
async function withBusy(btn, label, fn){
  if (btn && btn.disabled) return;            // allerede i gang — ignorér ekstra klik
  const orig = btn ? btn.innerHTML : null;
  if (btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + (label || 'Arbejder…'); }
  try { return await fn(); }
  finally { if (btn){ btn.disabled = false; btn.innerHTML = orig; } }
}

// Genbrugelig fejlboks der erstatter en spinner når et data-kald fejler, så
// brugeren ikke står og glor på "Henter…". retryCall = JS-udtryk til "Prøv igen".
function _errBox(msg, retryCall){
  return '<div class="load-error"><span class="load-error-icn">⚠</span>'
    + '<span>' + escapeHtml(msg || 'Noget gik galt — prøv igen') + '</span>'
    + (retryCall ? ' <button class="btn btn-ghost btn-sm" onclick="' + retryCall + '">Prøv igen</button>' : '')
    + '</div>';
}
function _failInto(elId, msg, retryCall){
  const el = document.getElementById(elId);
  if (el) el.innerHTML = _errBox(msg, retryCall);
}
function _clearEl(elId){ const el = document.getElementById(elId); if (el) el.innerHTML = ''; }

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function initials(name){ return String(name||'?').split(/\s+/).map(p=>p[0]).filter(Boolean).slice(0,2).join('').toUpperCase(); }
function fmtDate(d){
  if(!d) return '—';
  const x = new Date(d); if(isNaN(x)) return String(d);
  return x.toLocaleDateString('da-DK',{day:'numeric',month:'long',year:'numeric'});
}
function fmtMoney(n){ return new Intl.NumberFormat('da-DK').format(Math.round(n||0)) + ' kr'; }
function fmtDateShort(d){
  if(!d) return {month:'—',day:'—',year:''};
  const x = new Date(d); if(isNaN(x)) return {month:'—',day:'—',year:''};
  return {
    month: x.toLocaleDateString('da-DK',{month:'short'}).replace('.','').toUpperCase(),
    day: String(x.getDate()),
    year: String(x.getFullYear())
  };
}

