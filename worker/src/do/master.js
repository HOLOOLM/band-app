// MasterDO — ét objekt i hele installationen. Erstatter Script Properties:
// tenant-register, SSO-identiteter, bookere, operatører og audit-log.
//
// ADVARSEL: må ALDRIG ligge på den varme sti. Et Durable Object er
// enkelttrådet, så et opslag i master pr. request ville gøre dette objekt til
// et globalt serialiseringspunkt for samtlige bands — altså præcis den
// flaskehals _withLock (Code.gs:1454) er i dag, blot flyttet et lag ned.
//
// Derfor spejles bandets flag (status, cross_band, booking, feed_token) ind i
// BandDO ved skrivning, og læsestien henter dem derfra.

import { DurableObject } from 'cloudflare:workers';
import { Db } from '../lib/sql.js';
import {
  MASTER_MIGRATIONS, MASTER_SCHEMA_VERSION,
  applyMigrations, readSchemaVersion
} from './schema.js';

export class MasterDO extends DurableObject {
  #migrated = false;

  constructor(ctx, env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
  }

  async #ready() {
    if (this.#migrated) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.#migrated) return;
      const from = readSchemaVersion(this.db, 'master_meta');
      if (from < MASTER_SCHEMA_VERSION) {
        applyMigrations(this.db, MASTER_MIGRATIONS, from, 'master_meta');
      }
      this.#migrated = true;
    });
  }

  // ── Tenants ──────────────────────────────────────────────────────────────

  /**
   * Opretter et band. Returnerer den meta, kalderen skal sende videre til
   * BandDO.init() — master initialiserer ikke band-objektet selv, fordi
   * DO-til-DO-kald ellers ville binde de to objekters livscyklus sammen.
   */
  async createBand(bandId, name) {
    await this.#ready();
    const id = String(bandId || '').trim();
    if (!id) return { ok: false, error: 'bandId mangler' };
    if (this.db.one('SELECT band_id FROM bands WHERE band_id = ?', id)) {
      return { ok: false, error: 'Band-id findes allerede' };
    }
    const now = new Date().toISOString();
    this.db.insert('bands', {
      bandId: id, name: String(name || id), status: 'active',
      crossBand: 0, booking: 0, createdAt: now
    });
    return { ok: true, meta: { band_id: id, name: String(name || id), status: 'active' } };
  }

  async getBand(bandId) {
    await this.#ready();
    return this.db.one('SELECT * FROM bands WHERE band_id = ?', bandId);
  }

  /**
   * Operatørlisten. Én forespørgsel uafhængigt af antal bands — statistikken
   * er spejlet ind i bands-rækken af band-objekterne selv, netop for at undgå
   * en fan-out over N objekter her.
   */
  async listBands() {
    await this.#ready();
    return this.db.rows(
      `SELECT band_id, name, status, cross_band, booking,
              stat_members, stat_upcoming, stat_synced_at, created_at
         FROM bands ORDER BY name COLLATE NOCASE`
    );
  }

  /** Opdaterer et bands flag. Kalderen skal derefter spejle dem til BandDO. */
  async updateBand(bandId, patch) {
    await this.#ready();
    const allowed = ['name', 'status', 'crossBand', 'booking', 'feedToken',
                     'rootFolderId', 'cprEnc'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    if (!Object.keys(clean).length) return { ok: false, error: 'Ingen felter' };
    const changed = this.db.update('bands', clean, 'band_id = ?', bandId);
    return { ok: changed > 0 };
  }

  /** Band-objektet melder sine tal ind, så operatørlisten er én læsning. */
  async reportStats(bandId, members, upcoming) {
    await this.#ready();
    this.db.update('bands', {
      statMembers: members, statUpcoming: upcoming,
      statSyncedAt: new Date().toISOString()
    }, 'band_id = ?', bandId);
    return { ok: true };
  }

  async deleteBand(bandId, actor, detail) {
    await this.#ready();
    const b = this.db.one('SELECT * FROM bands WHERE band_id = ?', bandId);
    if (!b) return { ok: false, error: 'Ukendt band' };
    this.ctx.storage.transactionSync(() => {
      this.db.insert('deleted_bands', {
        bandId, name: b.name, deletedAt: new Date().toISOString(),
        actor: actor || '', detail: detail || ''
      });
      this.db.run('DELETE FROM bands WHERE band_id = ?', bandId);
      this.db.run('DELETE FROM identity_bands WHERE band_id = ?', bandId);
      this.db.run('DELETE FROM booker_bands WHERE band_id = ?', bandId);
    });
    return { ok: true };
  }

  // ── Identiteter (SSO på tværs af bands) ──────────────────────────────────

  async getIdentity(email) {
    await this.#ready();
    return this.db.one('SELECT * FROM identities WHERE email = ?', String(email).toLowerCase());
  }

  async putIdentity(email, passwordHash, pwSalt) {
    await this.#ready();
    const e = String(email).toLowerCase();
    this.db.run(
      `INSERT INTO identities (email, password_hash, pw_salt, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash, pw_salt = excluded.pw_salt`,
      e, passwordHash, pwSalt, new Date().toISOString()
    );
    return { ok: true };
  }

  async addIdentityBand(email, bandId) {
    await this.#ready();
    this.db.run(
      `INSERT INTO identity_bands (email, band_id) VALUES (?, ?)
         ON CONFLICT(email, band_id) DO NOTHING`,
      String(email).toLowerCase(), bandId
    );
    return { ok: true };
  }

  /**
   * Fjerner koblingen mellem en e-mail og ét band. Kaldes når et medlem slettes,
   * så kryds-band-opslag ikke fortsætter med at spørge et band personen ikke er
   * i længere.
   *
   * Selve identiteten (og dermed passwordet) bliver stående så længe e-mailen
   * hører til mindst ét band — musikeren skal kunne logge ind i sine øvrige
   * bands. Er det sidste band fjernet, ryddes identiteten helt: at beholde en
   * password-hash for en person der ikke længere er i systemet, er
   * unødvendig opbevaring af persondata.
   */
  async removeIdentityBand(email, bandId) {
    await this.#ready();
    const e = String(email || '').toLowerCase().trim();
    this.db.run('DELETE FROM identity_bands WHERE email = ? AND band_id = ?', e, bandId);
    const tilbage = Number(this.db.value(
      'SELECT count(*) AS c FROM identity_bands WHERE email = ?', e) ?? 0);
    if (tilbage === 0) {
      this.db.run('DELETE FROM identities WHERE email = ?', e);
    }
    return { ok: true, bandsTilbage: tilbage };
  }

  /**
   * Hvilke bands en e-mail hører til. Grundlaget for kryds-band-fan-out.
   * Kun bands med cross_band slået til returneres, så fan-out'en respekterer
   * flaget uden at kalderen skal huske det.
   */
  async bandsForIdentity(email, onlyCrossBand = true) {
    await this.#ready();
    const q = onlyCrossBand
      ? `SELECT b.band_id FROM identity_bands ib
           JOIN bands b ON b.band_id = ib.band_id
          WHERE ib.email = ? AND b.status = 'active' AND b.cross_band = 1`
      : `SELECT b.band_id FROM identity_bands ib
           JOIN bands b ON b.band_id = ib.band_id
          WHERE ib.email = ? AND b.status = 'active'`;
    return this.db.rows(q, String(email).toLowerCase()).map(r => r.bandId);
  }

  // ── Operatører ───────────────────────────────────────────────────────────

  async getOperator(email) {
    await this.#ready();
    return this.db.one('SELECT * FROM operators WHERE email = ?',
      String(email || '').toLowerCase().trim());
  }

  async putOperator(email, passwordHash, pwSalt) {
    await this.#ready();
    this.db.run(
      `INSERT INTO operators (email, password_hash, pw_salt) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash, pw_salt = excluded.pw_salt`,
      String(email).toLowerCase().trim(), passwordHash, pwSalt);
    return { ok: true };
  }

  // Rate-limit på operatør-login. Ligger i master-meta som flygtige rækker —
  // de hører ikke i audit-loggen og har ingen værdi efter vinduet er udløbet.
  async operatorLoginState(email, maxAttempts, lockSeconds) {
    await this.#ready();
    const key = 'oplock:' + String(email || '').toLowerCase().trim();
    const raw = this.db.value('SELECT value FROM master_meta WHERE key = ?', key);
    if (!raw) return { locked: false, attempts: 0 };
    let st;
    try { st = JSON.parse(raw); } catch (e) { return { locked: false, attempts: 0 }; }
    if (!st.until || Date.parse(st.until) <= Date.now()) {
      this.db.run('DELETE FROM master_meta WHERE key = ?', key);
      return { locked: false, attempts: 0 };
    }
    return { locked: st.attempts >= maxAttempts, attempts: st.attempts };
  }

  async penalizeOperatorLogin(email, maxAttempts, lockSeconds) {
    await this.#ready();
    const key = 'oplock:' + String(email || '').toLowerCase().trim();
    const st = await this.operatorLoginState(email, maxAttempts, lockSeconds);
    const attempts = st.attempts + 1;
    this.db.run(
      `INSERT INTO master_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, JSON.stringify({
        attempts, until: new Date(Date.now() + lockSeconds * 1000).toISOString()
      }));
    return { locked: attempts >= maxAttempts, attempts };
  }

  async clearOperatorLoginAttempts(email) {
    await this.#ready();
    this.db.run('DELETE FROM master_meta WHERE key = ?',
      'oplock:' + String(email || '').toLowerCase().trim());
    return { ok: true };
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  // Ligger i master, fordi operatøren skal kunne læse på tværs af bands i én
  // forespørgsel. Skrivninger sker fra band-objekter via RPC, men aldrig på en
  // læsesti — auditerede handlinger er skrivninger og er sjældne.

  async audit(actor, action, bandId, detail) {
    await this.#ready();
    this.db.insert('audit_log', {
      ts: new Date().toISOString(),
      actor: actor || '', action: action || '',
      bandId: bandId || '', detail: detail || ''
    });
    return { ok: true };
  }

  async getAuditLog(limit = 200, bandId = null) {
    await this.#ready();
    return bandId
      ? this.db.rows('SELECT * FROM audit_log WHERE band_id = ? ORDER BY ts DESC LIMIT ?', bandId, limit)
      : this.db.rows('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?', limit);
  }

  async status() {
    await this.#ready();
    return {
      ok: true,
      schemaVersion: Number(this.db.value(
        `SELECT value FROM master_meta WHERE key = 'schema_version'`) ?? 0),
      bands: Number(this.db.value('SELECT count(*) AS c FROM bands') ?? 0)
    };
  }
}
