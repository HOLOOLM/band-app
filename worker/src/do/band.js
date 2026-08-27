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

  /**
   * Alt hvad getConfig skal svare med, i ÉT kald.
   *
   * Dette er appens absolut varmeste sti: login-skærmen kalder den uden auth ved
   * hvert boot, også for besøgende der aldrig logger ind. Derfor samles den her
   * frem for at lade Workeren lave tre-fire RPC-runder, og derfor gemmes logoet
   * som en færdig data-URL-streng — så der ikke skal base64-encodes noget på
   * læsestien. Det erstatter _cachedLogoDataUrl (Code.gs:2787) helt: en
   * SQLite-læsning i samme proces er hurtigere end cache-opslaget var.
   */
  async getPublicConfig(publicKeys) {
    await this.#ready();
    const settings = {};
    for (const r of this.db.rows('SELECT key, value FROM settings')) settings[r.key] = r.value;
    const meta = this.#getMeta();

    const pub = {};
    for (const k of publicKeys) pub[k] = settings[k] || '';

    // Logoet ligger som færdig data-URL; øvrige assets rapporteres kun som
    // tilstedeværende, så getConfig aldrig flytter store blobs.
    pub.logoDataUrl = this.db.value(
      `SELECT data_url FROM assets WHERE kind = 'logo' AND seq = 0`) || '';

    const har = kind => Number(this.db.value(
      'SELECT count(*) AS c FROM assets WHERE kind = ?', kind) ?? 0) > 0;
    pub.hasRiderPdf = har('rider');
    pub.hasRider = pub.hasRiderPdf || !!String(settings.riderText || '').trim();
    pub.hasSceneplan = har('sceneplan');

    // Bandets flag læses fra de spejlede værdier — ALDRIG fra master. Fejler
    // lukket (false), så en manglende spejling ikke åbner en betalt feature.
    pub.crossBand = meta.cross_band === '1' || meta.cross_band === 'true';
    pub.booking = meta.booking === '1' || meta.booking === 'true';

    return { config: pub, status: meta.status || 'active' };
  }

  // ── Medlemmer ────────────────────────────────────────────────────────────
  // Bemærk at intet af dette filtrerer på band_id: kolonnen findes ikke, fordi
  // bandet er implicit i hvilket objekt vi er inde i.

  /** Ét medlem ved e-mail. Returnerer ALLE felter, inkl. hash — kun til auth. */
  async findMemberByEmail(email) {
    await this.#ready();
    const e = String(email || '').toLowerCase().trim();
    if (!e) return null;
    return this.db.one('SELECT * FROM members WHERE email = ?', e);
  }

  async findMemberById(id) {
    await this.#ready();
    return this.db.one('SELECT * FROM members WHERE id = ?', String(id));
  }

  /** Alle medlemmer uden hemmeligheder. Til medlemslisten. */
  async listMembers() {
    await this.#ready();
    return this.db.rows(
      `SELECT id, name, category, instrument, phone, email, reg_account, address,
              role, force_password_change, created_at
         FROM members ORDER BY name COLLATE NOCASE`
    );
  }

  async insertMember(m) {
    await this.#ready();
    this.db.insert('members', m);
    return { ok: true, id: m.id };
  }

  async updateMember(id, patch) {
    await this.#ready();
    if (!Object.keys(patch).length) return { ok: false, error: 'Ingen felter' };
    const changed = this.db.update('members', patch, 'id = ?', String(id));
    return { ok: changed > 0 };
  }

  /**
   * Sætter nyt password OG dræber alle sessioner for medlemmet i én transaktion.
   * De to hører sammen: efter et kodeskift skal udestående sessioner være døde,
   * og et halvt gennemført skift ville efterlade en session med gammel adgang.
   */
  async setMemberPassword(id, passwordHash, pwSalt, forcePasswordChange) {
    await this.#ready();
    let ok = false;
    this.ctx.storage.transactionSync(() => {
      this.db.update('members', {
        passwordHash, pwSalt,
        forcePasswordChange: forcePasswordChange ? 1 : 0
      }, 'id = ?', String(id));
      ok = this.db.changes() > 0;
      if (ok) this.db.run('DELETE FROM sessions WHERE subject = ?', String(id));
    });
    return { ok };
  }

  // ── Login-forsøg (rate-limit pr. e-mail) ─────────────────────────────────
  // Erstatter CacheService-baseret lockout (Code.gs:1602-1609). Ligger i
  // objektet, så tælleren er pr. band og ikke deles med andre tenants.
  //
  // Rate-limit rækkerne lever i login_log-tabellen? Nej — de er flygtige og
  // hører ikke i en GDPR-eksport. De ligger i band_meta med en tidsstempel, så
  // de ikke kræver en ekstra tabel og forsvinder ved oprydning.

  async loginAttemptState(email, maxAttempts, lockSeconds) {
    await this.#ready();
    const key = 'loginlock:' + String(email || '').toLowerCase().trim();
    const raw = this.db.value('SELECT value FROM band_meta WHERE key = ?', key);
    if (!raw) return { locked: false, attempts: 0 };
    let st;
    try { st = JSON.parse(raw); } catch (e) { return { locked: false, attempts: 0 }; }
    // Udløbet vindue = ren tavle.
    if (!st.until || Date.parse(st.until) <= Date.now()) {
      this.db.run('DELETE FROM band_meta WHERE key = ?', key);
      return { locked: false, attempts: 0 };
    }
    return { locked: st.attempts >= maxAttempts, attempts: st.attempts, until: st.until };
  }

  /** Tæller ét fejlet forsøg op. Returnerer den nye tilstand. */
  async penalizeLogin(email, maxAttempts, lockSeconds) {
    await this.#ready();
    const key = 'loginlock:' + String(email || '').toLowerCase().trim();
    const st = await this.loginAttemptState(email, maxAttempts, lockSeconds);
    const attempts = st.attempts + 1;
    const until = new Date(Date.now() + lockSeconds * 1000).toISOString();
    this.db.run(
      `INSERT INTO band_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, JSON.stringify({ attempts, until })
    );
    return { locked: attempts >= maxAttempts, attempts, remaining: Math.max(0, maxAttempts - attempts) };
  }

  async clearLoginAttempts(email) {
    await this.#ready();
    this.db.run('DELETE FROM band_meta WHERE key = ?',
      'loginlock:' + String(email || '').toLowerCase().trim());
    return { ok: true };
  }

  /** Skriver en linje i login-loggen. Kræver at kalderen har verificeret auth. */
  async trackLogin(memberId, email, userAgent) {
    await this.#ready();
    this.db.insert('login_log', {
      ts: new Date().toISOString(),
      memberId: String(memberId),
      email: String(email || '').toLowerCase().trim(),
      userAgent: String(userAgent || '').slice(0, 200)
    });
    return { ok: true };
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
