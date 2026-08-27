/**
 * BAND-APP SIDECAR — erstatter Code.gs (4742 linjer) efter migreringen til
 * Cloudflare Durable Objects.
 *
 * Sidecaren laver KUN de tre-fire ting hvor Google faktisk er en fordel:
 *
 *   renderPdf(html, fileName)      HTML → PDF via Drive-Docs-konvertering
 *   archivePdf(...)                gem PDF i bandets Drive-arkiv
 *   calcDistance(origin, dest)     køreafstand via Maps
 *   trashFile(fileId)              flyt en fil til papirkurven
 *
 * Den er STATELESS: ingen Sheets, ingen tenants, ingen brugere, ingen sessioner.
 * Al data kommer med i request-body. Den kender ikke datamodellen — Workeren
 * bygger HTML'en og sender den færdig — så den skal ikke opdateres når et felt
 * skifter navn.
 *
 * ── OPSÆTNING ───────────────────────────────────────────────────────────────
 * 1. Opret et nyt Apps Script-projekt (eller ryd det gamle).
 * 2. Indsæt DENNE fil som eneste .gs-fil. Slet Code.gs og Tests.gs.
 * 3. Kør setSidecarToken_RUN_ME() én gang og indsæt den værdi, du uploadede
 *    som SIDECAR_TOKEN i Cloudflare.
 * 4. Aktivér Advanced Drive Service: Tjenester → Drive API → v2 → Tilføj.
 * 5. Deploy → Ny udrulning → Web app:
 *      Kør som: mig
 *      Hvem har adgang: Alle
 *    Kopiér /exec-URL'en til SIDECAR_URL i wrangler.toml.
 *
 * ── SIKKERHED ───────────────────────────────────────────────────────────────
 * Endpointet er åbent (Apps Script kan ikke gøre andet for en web app der skal
 * kaldes server-til-server), så ALT gates af sidecarToken i request-body.
 * Tokenet ligger i body og ikke i en header, fordi Apps Script ikke videregiver
 * egne headers til doPost. Sammenligningen er konstant-tid.
 *
 * Sidecaren har ingen persondata og kan ikke læse bandenes data. Det værste et
 * lækket token giver, er at nogen kan konvertere deres egen HTML til PDF på din
 * Drive-kvote — derfor logges hvert kald, og der er en størrelsesgrænse.
 */

const PROP_SIDECAR_TOKEN = 'SIDECAR_TOKEN';

// Maks HTML-/PDF-størrelse pr. kald. Uden en grænse kunne et lækket token bruges
// til at fylde Drive op.
const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/** Kør ÉN gang fra editoren og indsæt samme værdi som Cloudflares SIDECAR_TOKEN. */
function setSidecarToken_RUN_ME() {
  const token = 'INDSÆT-SAMME-VÆRDI-SOM-I-CLOUDFLARE';
  if (token.indexOf('INDSÆT') === 0) {
    throw new Error('Ret token-værdien i funktionen først, og kør så igen.');
  }
  PropertiesService.getScriptProperties().setProperty(PROP_SIDECAR_TOKEN, token);
  Logger.log('SIDECAR_TOKEN gemt. Husk at deploye en ny version bagefter.');
}

function doPost(e) {
  var svar;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!_authOk(body.sidecarToken)) {
      // Samme besked uanset om tokenet mangler eller er forkert.
      svar = { ok: false, error: 'Adgang nægtet' };
    } else {
      svar = _handle(String(body.op || ''), body);
    }
  } catch (err) {
    console.error('Sidecar-fejl: ' + (err && err.stack || err));
    svar = { ok: false, error: 'Serverfejl i sidecar' };
  }
  return ContentService.createTextOutput(JSON.stringify(svar))
    .setMimeType(ContentService.MimeType.JSON);
}

/** GET bruges kun til at bekræfte at udrulningen lever. Afslører intet. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sidecar: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function _authOk(given) {
  var forventet = PropertiesService.getScriptProperties().getProperty(PROP_SIDECAR_TOKEN);
  if (!forventet) return false;
  var a = String(given || '').trim();
  var b = String(forventet).trim();
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function _handle(op, body) {
  switch (op) {
    case 'renderPdf':    return _renderPdf(body);
    case 'archivePdf':   return _archivePdf(body);
    case 'calcDistance': return _calcDistance(body);
    case 'trashFile':    return _trashFile(body);
    case 'ping':         return { ok: true, op: 'ping' };
    default:             return { ok: false, error: 'Ukendt operation' };
  }
}

// ── renderPdf ───────────────────────────────────────────────────────────────

/**
 * HTML → PDF.
 *
 * VIGTIGT om HTML'en: Drives Docs-konvertering håndterer IKKE moderne
 * CSS-layout — kun tabel-baseret opbygning. Workerens templates er skrevet med
 * det i tanke; ændrer man dem til flexbox eller grid, kommer der en PDF ud, men
 * layoutet falder sammen.
 *
 * Der forsøges to veje: direkte blob-konvertering (hurtig, virker for simpel
 * HTML) og derefter Drive-Docs (tungere, men klarer mere). Fejler begge,
 * returneres en fejl frem for et tomt dokument — en tom PDF ville se ud som om
 * det lykkedes.
 */
function _renderPdf(body) {
  var html = String(body.html || '');
  if (!html) return { ok: false, error: 'html mangler' };
  if (html.length > MAX_INPUT_BYTES) return { ok: false, error: 'html er for stor' };
  var navn = _renseFilnavn(body.fileName || 'dokument');

  var blob = null;
  try {
    blob = Utilities.newBlob(html, 'text/html', navn + '.html').getAs('application/pdf');
  } catch (e1) {
    console.log('Direkte HTML→PDF fejlede, prøver Drive-konvertering: ' + e1);
  }
  if (!blob) {
    try {
      blob = _viaDriveDocs(html, navn);
    } catch (e2) {
      console.error('Drive-konvertering fejlede: ' + (e2 && e2.stack || e2));
    }
  }
  if (!blob) return { ok: false, error: 'PDF-konvertering fejlede' };

  console.log('renderPdf: ' + navn + ' (' + blob.getBytes().length + ' bytes)');
  return { ok: true, pdfBase64: Utilities.base64Encode(blob.getBytes()), fileName: navn + '.pdf' };
}

/**
 * Konverterer via et midlertidigt Google Doc. Dokumentet flyttes ALTID til
 * papirkurven igen — også hvis konverteringen fejler, ellers ophober vi
 * skjulte filer på Drive.
 */
function _viaDriveDocs(html, navn) {
  var temp = null;
  try {
    var resource = { title: navn + '__tmp', mimeType: 'application/vnd.google-apps.document' };
    var htmlBlob = Utilities.newBlob(html, 'text/html', navn + '.html');
    temp = Drive.Files.insert(resource, htmlBlob, { convert: true });
    var fil = DriveApp.getFileById(temp.id);
    return fil.getAs('application/pdf').setName(navn + '.pdf');
  } finally {
    if (temp && temp.id) {
      try { DriveApp.getFileById(temp.id).setTrashed(true); }
      catch (e) { console.error('Kunne ikke rydde midlertidigt Doc ' + temp.id + ': ' + e); }
    }
  }
}

// ── archivePdf ──────────────────────────────────────────────────────────────

/**
 * Gemmer en PDF i Band-app/<bandId>/<mappenavn>/<år>/.
 *
 * Mapperne låses til privat adgang, så et PDF-link ikke virker for tilfældige
 * med adressen — kun for dem du eksplicit deler med. Fakturaer indeholder CPR.
 */
function _archivePdf(body) {
  var pdfBase64 = String(body.pdfBase64 || '');
  if (!pdfBase64) return { ok: false, error: 'pdfBase64 mangler' };
  if (pdfBase64.length > MAX_INPUT_BYTES) return { ok: false, error: 'PDF er for stor' };

  var bandId = _renseId(body.bandId);
  if (!bandId) return { ok: false, error: 'bandId mangler' };
  var navn = _renseFilnavn(body.fileName || 'dokument');
  var aar = String(body.year || new Date().getFullYear()).replace(/\D/g, '') || 'ukendt';

  var advarsel = '';
  // Erstat en tidligere version FØR vi lægger den nye, så der aldrig ligger to.
  if (body.replaceFileId) {
    try { DriveApp.getFileById(String(body.replaceFileId)).setTrashed(true); }
    catch (e) {
      console.error('Kunne ikke trashe gammel fil ' + body.replaceFileId + ': ' + e);
      advarsel = 'Den gamle Drive-fil kunne ikke fjernes — der kan ligge en forældet kopi.';
    }
  }

  var mappe = _mappe(bandId, String(body.folderName || 'Fakturaer'), aar);
  var blob = Utilities.newBlob(
    Utilities.base64Decode(pdfBase64), 'application/pdf', navn + '.pdf');
  var fil = mappe.createFile(blob);
  _laasNed(fil);

  console.log('archivePdf: ' + bandId + '/' + aar + '/' + navn);
  var ud = { ok: true, fileId: fil.getId(), url: fil.getUrl() };
  if (advarsel) ud.warning = advarsel;
  return ud;
}

/** Opretter mappekæden lazy. Hver ny mappe låses ned med det samme. */
function _mappe(bandId, mappenavn, aar) {
  var rod = _underMappe(DriveApp.getRootFolder(), 'Band-app');
  var band = _underMappe(rod, bandId);
  var arkiv = _underMappe(band, mappenavn);
  return _underMappe(arkiv, aar);
}

function _underMappe(forælder, navn) {
  var it = forælder.getFoldersByName(navn);
  if (it.hasNext()) return it.next();
  var ny = forælder.createFolder(navn);
  _laasNed(ny);
  return ny;
}

function _laasNed(driveObj) {
  try {
    driveObj.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (e) {
    // Ikke fatalt, men værd at vide: en fil der ikke kunne låses, er delbar via
    // link. Fakturaer indeholder CPR, så det skal ses i loggen.
    console.error('Kunne ikke låse Drive-objekt ned: ' + e);
  }
}

// ── calcDistance ────────────────────────────────────────────────────────────

/**
 * Køreafstand i km mellem to adresser.
 *
 * Ingen cache her — Workeren cacher pr. band i sin egen database og kalder kun
 * hertil ved et cache-miss. Sidecaren skal være stateless.
 */
function _calcDistance(body) {
  var origin = String(body.origin || '').trim();
  var destination = String(body.destination || '').trim();
  if (!origin || !destination) return { ok: false, error: 'origin og destination kræves' };
  try {
    var dir = Maps.newDirectionFinder()
      .setOrigin(origin)
      .setDestination(destination)
      .setMode(Maps.DirectionFinder.Mode.DRIVING)
      .getDirections();
    if (!dir || !dir.routes || !dir.routes.length) {
      return { ok: false, error: 'Ingen rute fundet' };
    }
    var meter = dir.routes[0].legs.reduce(function (s, l) {
      return s + (l.distance ? l.distance.value : 0);
    }, 0);
    return { ok: true, km: Math.round(meter / 100) / 10 };
  } catch (e) {
    console.error('Maps-fejl: ' + (e && e.stack || e));
    return { ok: false, error: 'Afstanden kunne ikke beregnes' };
  }
}

// ── trashFile ───────────────────────────────────────────────────────────────

function _trashFile(body) {
  var id = String(body.fileId || '').trim();
  if (!id) return { ok: false, error: 'fileId mangler' };
  try {
    DriveApp.getFileById(id).setTrashed(true);
    return { ok: true };
  } catch (e) {
    console.error('Kunne ikke trashe ' + id + ': ' + e);
    return { ok: false, error: 'Filen kunne ikke flyttes til papirkurven' };
  }
}

// ── Hjælpere ────────────────────────────────────────────────────────────────

/** Filnavne må ikke kunne bruges til at snige stier ind. */
function _renseFilnavn(s) {
  return String(s || '')
    .replace(/[\\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'dokument';
}

/** bandId bliver et mappenavn — kun det tegnsæt band-id'er må have. */
function _renseId(s) {
  var v = String(s || '').toLowerCase().trim();
  return /^[a-z0-9-]{1,40}$/.test(v) ? v : '';
}
