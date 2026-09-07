// Del af band-app frontend. Splittet ud af index.html.
// Klassiske <script>-filer deler global scope; rækkefølgen (01..09) SKAL bevares.

// ─── Login flow ───────────────────────────────────────────────────
async function doLogin(){
  const email = document.getElementById('emailInput').value.trim().toLowerCase();
  const pw = document.getElementById('passwordInput').value;
  clearErr('loginErr');
  if(!email){ showErr('loginErr','Indtast email.'); return; }
  if(!pw){ showErr('loginErr','Indtast adgangskode.'); return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  document.getElementById('loginStatus').classList.add('show');
  try {
    const hash = await sha256hex(pw);
    // Login går til Worker'en, som verificerer og sætter en httpOnly session-cookie.
    // Credentialet (hash) forlader IKKE browseren bagefter og gemmes ikke i sessionStorage.
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: email, passwordHash: hash, bandId: BAND_ID })
    });
    const d = await res.json().catch(()=>null);
    document.getElementById('loginStatus').classList.remove('show');
    btn.disabled = false;
    if (!d || !d.ok){ showErr('loginErr', (d && d.error) || 'Login mislykkedes.'); return; }
    SESSION = { email: email, role: d.role || 'member', member: d.member };
    _stampSessionActivity(true); // sæt loginAt + lastActivityAt (kun til UI idle-timeout)
    // log
    _apiCall('trackLogin', { memberId: (d.member&&d.member.id)||'', email: email, ua: (navigator.userAgent||'').slice(0,200) }).catch(()=>{});
    if (d.forcePasswordChange){ showChangePwView(); return; }
    enterApp();
  } catch (err){
    document.getElementById('loginStatus').classList.remove('show');
    btn.disabled = false;
    showErr('loginErr', 'Kunne ikke kontakte serveren: ' + err.message);
  }
}

function showChangePwView(){
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('changePwView').style.display = 'flex';
}

async function doChangePassword(){
  clearErr('changePwErr');
  const cur = document.getElementById('curPw').value;
  const a = document.getElementById('newPw1').value;
  const b = document.getElementById('newPw2').value;
  // Længden håndhæves nu OGSÅ serverside (worker/src/actions/auth.js). Tallet
  // her skal matche det dér, ellers får brugeren en fejl efter at have trykket
  // Gem i stedet for mens de skriver.
  if (!cur){ showErr('changePwErr','Indtast din nuværende adgangskode.'); return; }
  if (a.length < 12){ showErr('changePwErr','Min. 12 tegn.'); return; }
  if (a !== b){ showErr('changePwErr','De to felter er ikke ens.'); return; }
  if (a === cur){ showErr('changePwErr','Den nye kode skal være forskellig fra den nuværende.'); return; }
  const btn = document.getElementById('changePwBtn');
  btn.disabled = true; btn.textContent = 'Gemmer...';
  try {
    const newHash = await sha256hex(a);
    // Den NUVÆRENDE kode sendes med.
    //
    // Workeren indsatte før selv sessionens token som oldHash, så et stjålet
    // sid var nok til at overtage kontoen permanent — og fordi kodeskift
    // synkroniseres på tværs af bands, ramte overtagelsen alle brugerens bands
    // på én gang. Re-autentificering er standardforsvaret mod netop det.
    const res = await fetch('/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ oldHash: await sha256hex(cur), newHash: newHash, bandId: BAND_ID })
    });
    const d = await res.json().catch(()=>null);
    if (!d || !d.ok){ showErr('changePwErr', (d && d.error) || 'Kunne ikke gemme.'); btn.disabled = false; btn.textContent = 'Gem'; return; }
    document.getElementById('changePwView').style.display = 'none';
    enterApp();
  } catch(err){
    showErr('changePwErr', err.message);
    btn.disabled = false; btn.textContent = 'Gem';
  }
}

// Nulstiller alt lokalt cachet data fra den udlogget bruger, så et efterfølgende
// login i samme fane (delt maskine) ikke kortvarigt kan vise forrige brugers
// kontrakter/honorar, før nye data er hentet.
function _resetAppState(){
  CACHE = { members: null, contracts: null, dashboard: null, invoices: null, bookings: null, _stamp: {} };
  if (typeof MEMBER_JOBS_CACHE !== 'undefined') MEMBER_JOBS_CACHE = null;
  if (typeof MEMBER_JOBS_CACHE_ALL !== 'undefined') MEMBER_JOBS_CACHE_ALL = null;
  window._lastHonorar = null;
  window._lastAdminHonorar = null;
  ADMIN_ROUTE = 'dashboard';
  ADMIN_STATE = {
    contractFilter: 'alle', contractSearch: '', memberFilter: 'alle',
    contractType: 'alle', contractFra: '', contractTil: '',
    contractArrangoer: '', contractHonorarMin: '', contractHonorarMax: '',
    contractSort: 'date_desc',
    contractTimeframe: 'kommende'
  };
}

function logout(){
  SESSION = null;
  _resetAppState();
  // Slet server-side session + ryd cookien. Fire-and-forget; UI'et nulstilles uanset.
  try { fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(()=>{}); } catch(e){}
  try {
    sessionStorage.removeItem('band_loginAt');
    sessionStorage.removeItem('band_activityAt');
  } catch(e){}
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('memberApp').style.display = 'none';
  document.getElementById('changePwView').style.display = 'none';
  document.getElementById('loginView').style.display = 'flex';
  document.getElementById('emailInput').value = '';
  document.getElementById('passwordInput').value = '';
}

// ─── Session timeout ─────────────────────────────────────────────
// 8t hard limit (siden login) + 30 min idle (siden sidste aktivitet)
const SESSION_HARD_MAX_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MAX_MS = 30 * 60 * 1000;

function _stampSessionActivity(includeLogin){
  const now = Date.now();
  try {
    if (includeLogin) sessionStorage.setItem('band_loginAt', String(now));
    sessionStorage.setItem('band_activityAt', String(now));
  } catch(e){}
}

function _restoreSessionTimestamps(){
  try {
    const loginAt = Number(sessionStorage.getItem('band_loginAt') || 0);
    const activityAt = Number(sessionStorage.getItem('band_activityAt') || 0);
    if (!loginAt || !activityAt) {
      // Ingen timestamps gemt — sæt nye så genoplivede sessions stadig timer ud
      _stampSessionActivity(true);
      return true;
    }
    const now = Date.now();
    if (now - loginAt > SESSION_HARD_MAX_MS) return false;
    if (now - activityAt > SESSION_IDLE_MAX_MS) return false;
    return true;
  } catch(e){ return true; }
}

function _checkSessionExpired(){
  if (!SESSION) return false;
  try {
    const loginAt = Number(sessionStorage.getItem('band_loginAt') || 0);
    const activityAt = Number(sessionStorage.getItem('band_activityAt') || 0);
    const now = Date.now();
    if (loginAt && now - loginAt > SESSION_HARD_MAX_MS){
      toast('Session udløbet (8 timer) — log venligst ind igen', 'err');
      logout();
      return true;
    }
    if (activityAt && now - activityAt > SESSION_IDLE_MAX_MS){
      toast('Inaktiv i 30 min — log venligst ind igen', 'err');
      logout();
      return true;
    }
  } catch(e){}
  return false;
}

// Tjek timeout hvert minut + ved focus/visibility-skift
setInterval(_checkSessionExpired, 60 * 1000);
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) _checkSessionExpired(); });
// Opdatér aktivitets-tidsstempel ved brugerinteraktion
['click','keydown'].forEach(ev =>
  document.addEventListener(ev, ()=>{ if (SESSION) _stampSessionActivity(false); }, { passive: true })
);

function enterApp(viewMode){
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('viewChooser').style.display = 'none';

  // Kontakt- og rider-oplysninger. De lå før i getConfig, som er
  // uautentificeret og driver login-skærmens branding — men kontaktpersonens
  // navn, private telefonnummer og adresse er persondata og hører ikke til på
  // en side enhver kan hente ved at gætte et bandId. _brandify() i
  // 07-calendar-pdf.js læser dem fra BAND_CONFIG ved kontrakt- og
  // rider-rendering, så de fyldes på her, efter login. Samme mønster som
  // adminGetBillingInfo nedenfor.
  apiPost('getBandInfo', {}).then(d => {
    if (d && d.ok && d.config) BAND_CONFIG = Object.assign(BAND_CONFIG, d.config);
  }).catch(() => {});
  if (SESSION.role === 'admin' && !viewMode){
    // Vis valg-skærm for admins
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('memberApp').style.display = 'none';
    document.getElementById('viewChooser').style.display = 'flex';
    return;
  }
  if (SESSION.role === 'admin' && viewMode !== 'member'){
    document.getElementById('adminApp').style.display = 'grid';
    document.getElementById('memberApp').style.display = 'none';
    prewarmAdminCaches();
    // Hent bankoplysninger til brug i faktura-skabeloner (kræver auth)
    apiPost('adminGetBillingInfo', {}).then(d => {
      if (d && d.ok && d.billing) {
        BAND_CONFIG.bankName = d.billing.bankName || '';
        BAND_CONFIG.bankReg  = d.billing.bankReg  || '';
        BAND_CONFIG.bankKto  = d.billing.bankKto  || '';
        BAND_CONFIG.payeeName    = d.billing.payeeName    || '';
        BAND_CONFIG.payeeAddress = d.billing.payeeAddress || '';
      }
    }).catch(() => {});
    setAdminRoute('dashboard');
  } else {
    document.getElementById('memberApp').style.display = 'flex';
    document.getElementById('adminApp').style.display = 'none';
    document.getElementById('memberAvatar').textContent = initials(SESSION.member.name);
    document.getElementById('memberName').textContent = SESSION.member.name;
    // Vis "Skift til admin" knap kun for admins
    const switchBtn = document.getElementById('switchToAdmin');
    if (switchBtn) switchBtn.style.display = SESSION.role === 'admin' ? '' : 'none';
    setMemberView('jobs');
  }
}

// ─── Try restore session ─────────────────────────────────────────
// Delt i to, så boot kan hente sessionen SAMTIDIG med brandingen i stedet for
// bagefter (se bunden af 09-boot.js). Hentningen er uafhængig af BAND_CONFIG;
// anvendelsen er det ikke — enterApp() → prewarmAdminCaches() læser
// BAND_CONFIG.booking, og logo/temafarver skal være sat først.

/** Kun netværkskaldet. Returnerer svaret eller null; kaster aldrig. */
async function hentSession(){
  try {
    // Session lever i en httpOnly-cookie; spørg Worker'en om den stadig er gyldig.
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    return await res.json().catch(()=>null);
  } catch(e){ return null; }
}

/** Anvender svaret. Skal kaldes EFTER at brandingen er på plads. */
function anvendSession(d){
  if (!(d && d.ok)) return;
  SESSION = { email: (d.member && d.member.email) || '', role: d.role, member: d.member };
  // Tjek om gemte timestamps stadig er gyldige; ellers tving fresh login
  const restored = _restoreSessionTimestamps();
  if (!restored){ logout(); return; }
  if (d.forcePasswordChange){ showChangePwView(); return; }
  enterApp();
}

/** Bevaret som ét kald for de steder der bare vil genskabe sessionen. */
async function tryRestore(){
  anvendSession(await hentSession());
}

// ──────────────────────────────────────────────────────────────────
//                          ADMIN ROUTES
// ──────────────────────────────────────────────────────────────────
let ADMIN_ROUTE = 'dashboard';
let ADMIN_STATE = {
  contractFilter: 'alle', contractSearch: '', memberFilter: 'alle',
  contractType: 'alle', contractFra: '', contractTil: '',
  contractArrangoer: '', contractHonorarMin: '', contractHonorarMax: '',
  contractSort: 'date_desc',
  contractTimeframe: 'kommende'
};

function setAdminRoute(route, params){
  ADMIN_ROUTE = route;
  document.querySelectorAll('.sidebar .nav-item[data-route], .mobile-nav .mn-item[data-route]').forEach(el=>{
    el.classList.toggle('on', el.getAttribute('data-route') === route);
  });
  if (route === 'dashboard') return renderDashboard();
  if (route === 'contracts') return renderContractsList();
  if (route === 'contractEdit') return renderContractEditor(params && params.id);
  if (route === 'bookings') return renderBookingsList();
  if (route === 'members') return renderMembers();
  if (route === 'honorar') return renderAdminHonorar();
  if (route === 'invoices') return renderInvoicesList();
  if (route === 'settings') return renderAdminSettings();
}

