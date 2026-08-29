// Skemaer for de to Durable Object-klasser.
//
// Der findes ingen samlet migreringskommando som `wrangler d1 migrations apply`:
// hvert objekt løfter sit eget skema ved første adgang efter et deploy. Derfor
// SKAL hvert trin være
//   - kumulativt: et objekt kan springe fra version 0 direkte til N
//   - idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
// så et løft kan køre på et vilkårligt gammelt objekt uden at fejle.
//
// Kolonnenavne er snake_case og matcher de gamle SHEET_HEADERS (Code.gs:28-52),
// så action-svarene bliver bit-for-bit som i dag efter camelCase-mapping.

// ── Band-objektet ────────────────────────────────────────────────────────────
// Bemærk fraværet af band_id overalt. Hvilket band der er tale om, er implicit
// i hvilket objekt man taler med. Man kan ikke glemme en filterbetingelse på en
// kolonne der ikke findes — det er hele isolationsgevinsten ved denne model.

const BAND_V1 = `
CREATE TABLE IF NOT EXISTS band_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT, category TEXT, instrument TEXT, phone TEXT,
  email TEXT COLLATE NOCASE, reg_account TEXT, address TEXT,
  password_hash TEXT, pw_salt TEXT,
  force_password_change INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email ON members(email);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  type TEXT, status TEXT NOT NULL DEFAULT 'udkast',
  arrangoer TEXT, venue TEXT,
  date TEXT, get_in TEXT, soundcheck TEXT,
  showtime_from TEXT, showtime_to TEXT,
  sets INTEGER, set_minutes INTEGER,
  musician_count INTEGER, crew_count INTEGER, guest_count INTEGER,
  honorar REAL, payment_terms TEXT, payment_terms_other TEXT,
  notes TEXT, member_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_date ON contracts(date);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

CREATE TABLE IF NOT EXISTS attendances (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL, member_id TEXT NOT NULL,
  share REAL, status TEXT, confirmed_at TEXT, checked_in_at TEXT,
  start_address TEXT, distance_km REAL, distance_origin TEXT,
  return_home INTEGER, distance_round_trip INTEGER
);
CREATE INDEX IF NOT EXISTS idx_att_contract ON attendances(contract_id);
CREATE INDEX IF NOT EXISTS idx_att_member ON attendances(member_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  contract_id TEXT, invoice_nr INTEGER UNIQUE, date TEXT, amount REAL,
  status TEXT, drive_file_id TEXT, drive_url TEXT,
  created_at TEXT NOT NULL, paid_at TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  booker_id TEXT, source TEXT, status TEXT NOT NULL,
  contract_draft TEXT, arrangoer_name TEXT, arrangoer_email TEXT,
  doc_hash TEXT, token_exp TEXT,
  band_signature TEXT, arrangoer_signature TEXT,
  decline_reason TEXT, contract_id TEXT, pdf_file_id TEXT,
  history TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, member_id TEXT, email TEXT, user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_ts ON login_log(ts);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  token TEXT NOT NULL,
  pw_fp TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS assets (
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  mime TEXT, bytes BLOB, data_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, seq)
);

CREATE TABLE IF NOT EXISTS distance_cache (
  key TEXT PRIMARY KEY, origin TEXT, destination TEXT,
  km REAL, cached_at TEXT
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, next INTEGER NOT NULL DEFAULT 1);
`;

// ── Master-objektet ─────────────────────────────────────────────────────────
// Erstatter Script Properties. Må ALDRIG ligge på den varme sti — se
// arkitekturreglen i planens Fase 1: et Durable Object er enkelttrådet, så et
// opslag i master pr. request ville gøre master til et globalt
// serialiseringspunkt for alle bands.

const MASTER_V1 = `
CREATE TABLE IF NOT EXISTS bands (
  band_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cross_band INTEGER NOT NULL DEFAULT 0,
  booking INTEGER NOT NULL DEFAULT 0,
  cpr_enc TEXT,
  feed_token TEXT,
  root_folder_id TEXT,
  stat_members INTEGER NOT NULL DEFAULT 0,
  stat_upcoming INTEGER NOT NULL DEFAULT 0,
  stat_synced_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_bands (
  email TEXT NOT NULL, band_id TEXT NOT NULL,
  PRIMARY KEY (email, band_id)
);

CREATE TABLE IF NOT EXISTS bookers (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT, agency TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  password_hash TEXT, pw_salt TEXT,
  force_password_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS booker_bands (
  email TEXT NOT NULL, band_id TEXT NOT NULL,
  PRIMARY KEY (email, band_id)
);

CREATE TABLE IF NOT EXISTS operators (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL, pw_salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, actor TEXT, action TEXT, band_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

CREATE TABLE IF NOT EXISTS deleted_bands (
  band_id TEXT, name TEXT, deleted_at TEXT, actor TEXT, detail TEXT
);

CREATE TABLE IF NOT EXISTS master_meta (key TEXT PRIMARY KEY, value TEXT);
`;

// ── Band v2 ─────────────────────────────────────────────────────────────────
// invoice_nr blev erklæret INTEGER, men er en STRENG: _nextInvoiceNr
// (Code.gs:2331) danner "2026-001" med årstal og nulpolstring. SQLites
// type-affinitet gemmer strengen alligevel (konvertering til heltal er ikke
// tabsfri), så det var ikke en aktiv fejl — men en forkert erklæret type er en
// fælde for den næste der læser skemaet, og et heltalsindeks ville sortere
// "2026-10" før "2026-9".
//
// SQLite kan ikke ALTER COLUMN TYPE, så tabellen bygges om. Dataen kopieres med,
// selvom der pt. ikke er nogen — trinnet skal virke uanset hvornår det kører.
const BAND_V2 = `
CREATE TABLE IF NOT EXISTS invoices_v2 (
  id TEXT PRIMARY KEY,
  contract_id TEXT, invoice_nr TEXT UNIQUE, date TEXT, amount REAL,
  status TEXT, drive_file_id TEXT, drive_url TEXT,
  created_at TEXT NOT NULL, paid_at TEXT
);
INSERT OR IGNORE INTO invoices_v2
  (id, contract_id, invoice_nr, date, amount, status, drive_file_id, drive_url, created_at, paid_at)
  SELECT id, contract_id, CAST(invoice_nr AS TEXT), date, amount, status,
         drive_file_id, drive_url, created_at, paid_at
    FROM invoices;
DROP TABLE invoices;
ALTER TABLE invoices_v2 RENAME TO invoices;
CREATE INDEX IF NOT EXISTS idx_invoices_contract ON invoices(contract_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
`;

// Tilføj nye trin ved at appende — ret ALDRIG et udgivet trin, da gamle objekter
// kan have kørt den gamle udgave. Ny kolonne = nyt trin med ALTER TABLE.
// V3 — fakturaarkivet flyttes fra Google Drive til Cloudflare R2.
//
// Hvorfor: sidecaren arkiverede med DriveApp.getRootFolder() og kørte "som mig",
// så HVERT bands fakturaer landede i operatørens personlige Drive og blev sat
// til Access.PRIVATE. To følger: "↗ Drive"-linket i admin-panelet var dødt for
// alle andre end den ene Google-konto, og alle bands delte operatørens 15 GB
// Google-kvote — den samme kvote som vedkommendes Gmail.
//
// drive_file_id og drive_url beholdes. Bands der stadig kører på Apps Script
// (BACKEND = "sheets") har rigtige Drive-filer i de kolonner, og en faktura
// arkiveret før omskiftningen skal stadig kunne åbnes.
const BAND_V3 = `
ALTER TABLE invoices ADD COLUMN archive_key TEXT;
`;

export const BAND_MIGRATIONS = [BAND_V1, BAND_V2, BAND_V3];
export const MASTER_MIGRATIONS = [MASTER_V1];

export const BAND_SCHEMA_VERSION = BAND_MIGRATIONS.length;
export const MASTER_SCHEMA_VERSION = MASTER_MIGRATIONS.length;

/**
 * Læser objektets nuværende skemaversion. Opretter meta-tabellen først, fordi
 * et helt nyt objekt har en tom database — så selv versionsopslaget ville fejle.
 * Returnerer 0 for et objekt der aldrig har været migreret.
 */
export function readSchemaVersion(db, metaTable) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${metaTable} (key TEXT PRIMARY KEY, value TEXT)`);
  const v = db.value(`SELECT value FROM ${metaTable} WHERE key = 'schema_version'`);
  return Number(v ?? 0) || 0;
}

/**
 * Løfter et objekts skema fra `fromVersion` til nyeste. Kaldes altid inde i
 * ctx.blockConcurrencyWhile, så ingen request slipper ind midt i løftet.
 * Returnerer den version der blev nået.
 */
export function applyMigrations(db, migrations, fromVersion, metaTable) {
  for (let v = fromVersion; v < migrations.length; v++) {
    db.exec(migrations[v]);
  }
  const version = migrations.length;
  db.run(
    `INSERT INTO ${metaTable} (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(version)
  );
  return version;
}
