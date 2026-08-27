// BandDO — ét Durable Object pr. band, med sin egen SQLite-database.
//
// Isolationen er fysisk: band A's data ligger i en anden database end band B's,
// og band_id findes ikke som kolonne nogen steder herinde. En glemt
// filterbetingelse kan derfor ikke lække på tværs af bands — det er den
// garanti den gamle model (ét regneark pr. band) havde, og som en fælles
// database med band_id ville have givet op.
//
// Alt herinde kører enkelttrådet, så skrivninger til ÉT band serialiseres
// automatisk, mens andre bands kører uforstyrret. Det erstatter _withLock
// (Code.gs:1454), som havde én global lås for alle bands.

import { DurableObject } from 'cloudflare:workers';
import { Db } from '../lib/sql.js';
import { benchKdf } from './bench.js';
import {
  BAND_MIGRATIONS, BAND_SCHEMA_VERSION,
  applyMigrations, readSchemaVersion
} from './schema.js';

export class BandDO extends DurableObject {
  // Konstruktøren SKAL være tom-agtig. Objektet hiberneres efter 10 sekunder
  // uden trafik og smides ud af hukommelsen efter 70-140 sekunder, hvorefter
  // konstruktøren kører igen ved næste kald. Opstarten er under 5 ms så længe
  // der ikke laves arbejde her — migreringer hører derfor i #ready().
  #migrated = false;

  constructor(ctx, env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
  }

  /**
   * Sikrer at skemaet er løftet. Efter første kald er dette et boolean-opslag,
   * altså gratis mens objektet er varmt.
   */
  async #ready() {
    if (this.#migrated) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.#migrated) return;                 // en anden request nåede det først
      const from = readSchemaVersion(this.db, 'band_meta');
      if (from < BAND_SCHEMA_VERSION) {
        applyMigrations(this.db, BAND_MIGRATIONS, from, 'band_meta');
      }
      this.#migrated = true;
    });
  }

  // ── Livscyklus ────────────────────────────────────────────────────────────

  /**
   * Kaldes af MasterDO når bandet oprettes. Skriver de flag ind, som den varme
   * sti skal kunne læse uden at slå op i master.
   */
  async init(meta) {
    await this.#ready();
    this.#putMeta(meta);
    return { ok: true, schemaVersion: BAND_SCHEMA_VERSION };
  }

  /** Skemaversion + bandets spejlede flag. Bruges af operatørens migreringstjek. */
  async status() {
    await this.#ready();
    return {
      ok: true,
      schemaVersion: Number(this.db.value(
        `SELECT value FROM band_meta WHERE key = 'schema_version'`) ?? 0),
      meta: this.#getMeta(),
      counts: {
        members: Number(this.db.value('SELECT count(*) AS c FROM members') ?? 0),
        contracts: Number(this.db.value('SELECT count(*) AS c FROM contracts') ?? 0)
      }
    };
  }

  // ── Bandets spejlede flag ────────────────────────────────────────────────
  // status / cross_band / booking / feed_token har master som kilde til
  // sandhed, men læses på hver request. De ligger derfor også her, så den
  // varme sti aldrig rører master.

  #putMeta(obj) {
    for (const k in obj) {
      this.db.run(
        `INSERT INTO band_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        k, obj[k] === null || obj[k] === undefined ? '' : String(obj[k])
      );
    }
  }

  #getMeta() {
    const out = {};
    for (const r of this.db.rows('SELECT key, value FROM band_meta')) out[r.key] = r.value;
    delete out.schema_version;
    return out;
  }

  /** Opdaterer de spejlede flag. Kaldes af MasterDO ved ændring. */
  async syncMeta(obj) {
    await this.#ready();
    this.#putMeta(obj);
    return { ok: true };
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  /** Alle settings som key/value-objekt. Kaldere lægger defaults ovenpå. */
  async getSettings() {
    await this.#ready();
    const out = {};
    for (const r of this.db.rows('SELECT key, value FROM settings')) out[r.key] = r.value;
    return out;
  }

  /**
   * Skriver settings. `allowedKeys` filtrerer, så en kalder ikke kan indføre
   * vilkårlige nøgler — samme rolle som whitelisten i _setSettings.
   */
  async putSettings(changes, allowedKeys) {
    await this.#ready();
    const allow = allowedKeys ? new Set(allowedKeys) : null;
    let written = 0;
    this.ctx.storage.transactionSync(() => {
      for (const k in changes) {
        if (allow && !allow.has(k)) continue;
        const v = changes[k];
        this.db.run(
          `INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          k, v === null || v === undefined ? '' : String(v)
        );
        written++;
      }
    });
    return { ok: true, written };
  }

  // ── Sessioner ────────────────────────────────────────────────────────────
  // Flyttet hertil fra KV. Gratisplanen tillader kun 1.000 KV-skrivninger/dag,
  // og med fornyelse ved hvert /api/call ramte man muren ved 6-7 bands. Her
  // tæller de mod DO'ens 100.000 rækkeskrivninger/dag i stedet.
  //
  // Sidegevinst: et session-id udstedt til band A findes ikke i band B's
  // database, så et forsøg på at bruge det mod band B fejler af sig selv.

  async putSession(sid, data, ttlSeconds) {
    await this.#ready();
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (sid, kind, subject, token, pw_fp, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           token = excluded.token, pw_fp = excluded.pw_fp, expires_at = excluded.expires_at`,
      sid, data.kind, data.subject, data.token, data.pwFp || '',
      new Date(now).toISOString(), new Date(now + ttlSeconds * 1000).toISOString()
    );
    return { ok: true };
  }

  async getSession(sid) {
    await this.#ready();
    const s = this.db.one('SELECT * FROM sessions WHERE sid = ?', sid);
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= Date.now()) {
      this.db.run('DELETE FROM sessions WHERE sid = ?', sid);
      return null;
    }
    return s;
  }

  /**
   * Forlænger en session. Skrives KUN når der er under `minRemaining` sekunder
   * tilbage — ellers ville hvert API-kald give en skrivning, hvilket var netop
   * problemet med KV-modellen.
   */
  async touchSession(sid, ttlSeconds, minRemaining = 3600) {
    await this.#ready();
    const s = this.db.one('SELECT expires_at FROM sessions WHERE sid = ?', sid);
    if (!s) return { ok: false };
    const left = (Date.parse(s.expiresAt) - Date.now()) / 1000;
    if (left > minRemaining) return { ok: true, renewed: false };
    this.db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?',
      new Date(Date.now() + ttlSeconds * 1000).toISOString(), sid);
    return { ok: true, renewed: true };
  }

  async deleteSession(sid) {
    await this.#ready();
    this.db.run('DELETE FROM sessions WHERE sid = ?', sid);
    return { ok: true };
  }

  /** Dræber alle sessioner for et subjekt. Kaldes ved password-skift. */
  async killSessionsFor(subject) {
    await this.#ready();
    this.db.run('DELETE FROM sessions WHERE subject = ?', subject);
    return { ok: true };
  }

  /** Rydder udløbne sessioner. Kaldes af retention-cron'en. */
  async pruneSessions() {
    await this.#ready();
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    return { ok: true, removed: this.db.changes() };
  }

  // ── Tællere ──────────────────────────────────────────────────────────────
  // Ikke længere en låsemekanisme (objektet er enkelttrådet), men beholdt til
  // fakturanumre, hvor soft-delete skal bevare nummerreservationen.

  async nextCounter(name) {
    await this.#ready();
    this.db.run(
      `INSERT INTO counters (name, next) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET next = next + 1`,
      name
    );
    return Number(this.db.value('SELECT next FROM counters WHERE name = ?', name));
  }

  // ── Diagnostik ───────────────────────────────────────────────────────────

  /**
   * Måler password-KDF'ens omkostning INDE i objektet. Planen placerer KDF'en
   * her frem for i den ydre Worker, fordi CPU-budgettet for Durable Objects
   * angives mere generøst end Workers 10 ms på gratisplanen.
   */
  async bench() {
    return benchKdf('Durable Object');
  }

  /**
   * Kolonnenavne pr. tabel. Bruges af selvtesten til at bevise at band_id IKKE
   * findes på nogen band-tabel — den påstand hele isolationsmodellen hviler på.
   * Returnerer kun metadata, aldrig rækkeindhold.
   */
  async debugColumns(tables) {
    await this.#ready();
    const out = {};
    for (const t of tables) {
      if (!/^[a-z_]+$/.test(t)) continue;           // ingen dynamisk SQL fra ukendte navne
      try {
        out[t] = this.db.rows(`PRAGMA table_info(${t})`).map(r => r.name);
      } catch (e) {
        out[t] = [];
      }
    }
    return out;
  }
}
