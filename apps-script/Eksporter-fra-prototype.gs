/**
 * ENGANGS-EKSPORT fra DMDT-prototypens Google Sheet.
 *
 * Kør denne ÉN gang i prototypens eget Apps Script-projekt — altså det der
 * hører til deployment AKfycbxQlGk_… og regnearket
 * 1bwk_Bj2LADx_JgE6w1GlwPsos4JlnGAD5CO2gWmIV4w. Ikke i sidecar-projektet.
 *
 * ── SÅDAN ───────────────────────────────────────────────────────────────────
 * 1. Åbn prototypens Apps Script-projekt
 * 2. Filer → + → Script → navngiv den `Eksport`
 * 3. Indsæt DENNE fil. Rør ikke Code.gs.
 * 4. Vælg `eksporterAlt` i funktions-dropdownen → Kør
 * 5. Loggen viser en Drive-URL. Hent filen derfra.
 *
 * Funktionen LÆSER kun. Den skriver intet til regnearket, og prototypen kører
 * videre uforstyrret imens.
 *
 * ── ADVARSEL OM PERSONDATA ──────────────────────────────────────────────────
 * Filen indeholder medlemmernes navne, e-mail, telefon, adresser OG
 * CPR-numre — Members-arket har en cpr-kolonne pr. medlem.
 *
 * Derfor:
 *   • Filen lægges PRIVAT i din Drive-rod og deles ikke
 *   • Slet den fra Drive OG fra papirkurven når importen er gennemført
 *   • Læg den aldrig i et git-repo, og send den ikke i en chat
 *
 * CPR importeres IKKE til det nye lag: dér findes kun ét band-CPR, krypteret
 * med CPR_KEY, og det indtastes i Indstillinger. Feltet tages med i eksporten
 * så du kan aflæse hvilket nummer der skal indtastes — ikke for at flytte det.
 */

// Samme regneark som prototypens Code.gs binder sig til.
const EKSPORT_SHEET_ID = '1bwk_Bj2LADx_JgE6w1GlwPsos4JlnGAD5CO2gWmIV4w';

// Ark der skal med. LoginLog udelades bevidst: den er ren historik, fylder
// mest, og har ingen værdi i det nye lag.
const EKSPORT_ARK = ['Members', 'Contracts', 'Attendances', 'Invoices',
                     'Riders', 'DistanceCache'];

function eksporterAlt() {
  var ss = SpreadsheetApp.openById(EKSPORT_SHEET_ID);
  var ud = {
    _kilde: 'DMDT-prototype',
    _sheetId: EKSPORT_SHEET_ID,
    _eksporteret: new Date().toISOString(),
    _advarsel: 'Indeholder persondata inkl. CPR. Slet efter import.'
  };

  EKSPORT_ARK.forEach(function (navn) {
    var sh = ss.getSheetByName(navn);
    if (!sh) { ud[navn] = []; Logger.log('Ark mangler: ' + navn); return; }
    ud[navn] = _laesArk(sh);
    Logger.log(navn + ': ' + ud[navn].length + ' rækker');
  });

  // Band-CPR ligger i Script Properties, ikke i regnearket. Tages med så du
  // kan indtaste det i det nye lags Indstillinger.
  try {
    var cpr = PropertiesService.getScriptProperties().getProperty('BAND_CPR');
    ud._bandCpr = cpr || '';
  } catch (e) {
    ud._bandCpr = '';
  }

  var navn = 'dmdt-eksport-' +
    Utilities.formatDate(new Date(), 'Europe/Copenhagen', 'yyyy-MM-dd-HHmm') + '.json';
  var fil = DriveApp.createFile(navn, JSON.stringify(ud, null, 2),
                                'application/json');
  // Ingen deling. Filen har CPR i sig.
  try {
    fil.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (e) {
    Logger.log('ADVARSEL: kunne ikke låse filen ned: ' + e);
  }

  Logger.log('');
  Logger.log('FÆRDIG. Hent filen her:');
  Logger.log(fil.getUrl());
  Logger.log('');
  Logger.log('Husk at slette den fra Drive OG papirkurven efter importen.');
  return fil.getUrl();
}

/**
 * Læser ét ark som en liste af objekter, med samme kolonne→nøgle-mapping som
 * prototypens eget _readAll (Code.gs:298).
 *
 * Datoer konverteres til ISO-strenge. Uden det ville de blive serialiseret som
 * Apps Scripts egne Date-objekter, og tidszonen ville skride ved import.
 */
function _laesArk(sh) {
  var sidsteRaekke = sh.getLastRow();
  if (sidsteRaekke < 2) return [];
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var data = sh.getRange(2, 1, sidsteRaekke - 1, headers.length).getValues();

  return data.map(function (raekke) {
    var o = {};
    headers.forEach(function (h, i) {
      if (!h) return;
      var v = raekke[i];
      if (v instanceof Date) v = v.toISOString();
      o[String(h)] = v;
    });
    return o;
  }).filter(function (o) {
    // Tomme rækker nederst i et ark er almindelige. En række uden id (eller
    // uden nogen udfyldt værdi) er støj, ikke data.
    return Object.keys(o).some(function (k) {
      return String(o[k] || '').trim() !== '';
    });
  });
}

/**
 * Hurtigt overblik UDEN at danne en fil. Kør denne først hvis du bare vil se
 * hvor meget der ligger.
 */
function taelAlt() {
  var ss = SpreadsheetApp.openById(EKSPORT_SHEET_ID);
  EKSPORT_ARK.forEach(function (navn) {
    var sh = ss.getSheetByName(navn);
    Logger.log(navn + ': ' + (sh ? Math.max(0, sh.getLastRow() - 1) : 'ARK MANGLER'));
  });
}
