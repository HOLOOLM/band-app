// Settings-kontrakten mod frontenden.
//
// GENERERET af worker/tools/gen-settings.mjs ud fra apps-script/Code.gs
// (SETTINGS_DEFAULTS, PUBLIC_CONFIG_KEYS, BILLING_CONFIG_KEYS).
// Ret ikke filen i hånden — kør scriptet igen:  node worker/tools/gen-settings.mjs

/** Alle Settings-nøgler med deres default. Ukendte nøgler afvises ved skrivning. */
export const SETTINGS_DEFAULTS = {
  bandName: 'Mit Band',
  bandShortName: 'BAND',
  bandTagline: '',
  emailDomain: 'example.com',
  theme: 'kul',
  primaryColor: '#8A8A8A',
  primaryColorSoft: '#A8A8A8',
  primaryColorDeep: '#5C5C5C',
  bgColor: '',
  textColor: '',
  bgColorCard: '',
  bgColorRaised: '',
  borderColor: '',
  textColorDim: '',
  textColorMute: '',
  fontUi: '',
  fontDisplay: '',
  logoFileId: '',
  riderFileId: '',
  riderText: '',
  riderTemplates: '',
  sceneplanFileId: '',
  sceneplanJson: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  contactAddress: '',
  techContactName: '',
  techContactPhone: '',
  bankName: '',
  bankReg: '',
  bankKto: '',
  payeeName: '',
  payeeAddress: '',
  seedPassword: 'skiftmig2026',
  invoiceFolderName: 'Fakturaer',
  retentionLoginLogMonths: '',
};

/**
 * Nøgler getConfig må returnere UDEN auth — login-skærmen kalder den, før nogen
 * er logget ind. seedPassword, invoiceFolderName, bankoplysninger og alle
 * *FileId er bevidst udeladt; selvtesten håndhæver det.
 */
export const PUBLIC_CONFIG_KEYS = [
  'bandName',
  'bandShortName',
  'bandTagline',
  'emailDomain',
  'theme',
  'primaryColor',
  'primaryColorSoft',
  'primaryColorDeep',
  'bgColor',
  'textColor',
  'fontUi',
  'fontDisplay',
  'bgColorCard',
  'bgColorRaised',
  'borderColor',
  'textColorDim',
  'textColorMute',
];

/**
 * Nøgler ethvert MEDLEM må læse, men som ikke hører til på login-skærmen.
 *
 * Kontakt- og teknikpersonens navn, private telefonnummer og adresse lå før i
 * PUBLIC_CONFIG_KEYS. getConfig kræver ingen session — den driver
 * login-skærmens branding — så alt på den liste kunne hentes af enhver der
 * kendte eller gættede et bandId, og bandId'erne er ifølge lib/addressing.js
 * "stabile og menneskeligt læsbare". Det er persondata under GDPR, og
 * login-skærmen har aldrig haft brug for dem: den viser navn, farver, font og
 * logo.
 *
 * riderTemplates følger med hertil af samme grund — det er bandets interne
 * tekster, ikke branding.
 *
 * Kontrakt- og rider-renderingen i frontenden bruger felterne, og henter dem
 * nu med getBandInfo efter login. Se actions/auth.js.
 */
export const MEMBER_CONFIG_KEYS = [
  'contactName',
  'contactEmail',
  'contactPhone',
  'contactAddress',
  'techContactName',
  'techContactPhone',
  'riderTemplates',
];

/** Nøgler der kræver admin-auth — bankoplysninger til fakturering. */
export const BILLING_CONFIG_KEYS = [
  'bankName',
  'bankReg',
  'bankKto',
];

/** Whitelist ved skrivning til settings. */
export const ALL_SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

/** Nøgler der aldrig må returneres uden auth. Selvtesten krydstjekker mod PUBLIC. */
export const NEVER_PUBLIC_KEYS = [
  'seedPassword',
  'invoiceFolderName',
  'logoFileId',
  'riderFileId',
  'sceneplanFileId',
  'sceneplanJson',
  'riderText',
  'bankName',
  'bankReg',
  'bankKto',
  'payeeName',
  'payeeAddress',
];
