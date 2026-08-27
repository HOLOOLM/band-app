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
   * Sletter et medlem og alt hvad der hænger på det i én transaktion.
   *
   * Attendances SKAL med: en efterladt attendance-række ville pege på et
   * medlem der ikke findes, og både honorarfordeling og dashboard summerer
   * over dem. Login-log ryddes også — det er personhenførbart og har ingen
   * værdi når kontoen er væk (GDPR-dataminimering).
   */
  async deleteMember(id) {
    await this.#ready();
    let fandtes = false;
    this.ctx.storage.transactionSync(() => {
      this.db.run('DELETE FROM members WHERE id = ?', String(id));
      fandtes = this.db.changes() > 0;
      if (fandtes) {
        this.db.run('DELETE FROM attendances WHERE member_id = ?', String(id));
        this.db.run('DELETE FROM sessions WHERE subject = ?', String(id));
        this.db.run('DELETE FROM login_log WHERE member_id = ?', String(id));
      }
    });
    return { ok: fandtes };
  }

  /**
   * Alt personhenførbart om ét medlem, til GDPR-eksporten.
   *
   * Bemærk at contracts.member_note IKKE er med: det er admins interne note om
   * jobbet, ikke medlemmets persondata, og den er også holdt ude af kontrakt-PDF
   * og iCal-feedet.
   */
  async exportMemberData(memberId, email) {
    await this.#ready();
    const jobs = this.db.rows(
      `SELECT a.contract_id, c.date, c.venue, a.share, a.status,
              a.checked_in_at, a.distance_km, a.start_address
         FROM attendances a
         LEFT JOIN contracts c ON c.id = a.contract_id
        WHERE a.member_id = ?
        ORDER BY c.date DESC`,
      String(memberId)
    ).map(r => {
      // venue er en JSON-streng, som i Sheets-modellen. Udpak de to felter
      // eksporten viser, og fejl ikke på en korrupt værdi.
      let venue = {};
      try { venue = JSON.parse(r.venue || '{}') || {}; } catch (e) { venue = {}; }
      return {
        contractId: r.contractId, date: r.date || '',
        venue: venue.name || '', city: venue.city || '',
        share: r.share, status: r.status, checkedInAt: r.checkedInAt || '',
        distanceKm: r.distanceKm || '', startAddress: r.startAddress || ''
      };
    });

    const loginHistory = this.db.rows(
      'SELECT ts, user_agent FROM login_log WHERE email = ? ORDER BY ts DESC',
      String(email || '').toLowerCase().trim()
    ).map(r => ({ timestamp: r.ts, userAgent: r.userAgent || '' }));

    return { jobs, loginHistory };
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

  // ── Kontrakter ───────────────────────────────────────────────────────────

  async listContracts() {
    await this.#ready();
    return this.db.rows('SELECT * FROM contracts ORDER BY date DESC');
  }

  async getContract(id) {
    await this.#ready();
    const c = this.db.one('SELECT * FROM contracts WHERE id = ?', String(id));
    if (!c) return null;
    const attendees = this.db.rows(
      'SELECT * FROM attendances WHERE contract_id = ?', String(id));
    return { contract: c, attendees };
  }

  /**
   * Gemmer en kontrakt med deltagere. HELE operationen er én transaktion:
   * id-omdøbning, kontraktrækken og deltagersynkroniseringen. Ellers kunne en
   * afbrudt gemning efterlade en kontrakt uden deltagere eller omvendt.
   *
   * Fire ting sker her, og de har hver deres faldgrube:
   *
   *   1. OMDØBNING. Kontrakt-id er brugerredigerbart (det er kontraktnummeret),
   *      så et gem kan flytte rækken til et nyt id. Alle attendances skal følge
   *      med, ellers bliver de forældreløse.
   *   2. UTILSIGTET OVERSKRIVNING. Er der ingen originalId, opretter brugeren en
   *      ny kontrakt — findes nummeret allerede, skal vi afvise frem for at
   *      skrive oven i en anden aftale.
   *   3. OPTIMISTISK LÅSNING. To admins med samme kontrakt åben må ikke kunne
   *      overskrive hinanden lydløst.
   *   4. DELTAGERSYNKRONISERING. Se kommentaren nedenfor — her afviger vi
   *      bevidst fra originalen.
   */
  async saveContract(data, attendees, originalId, expectedUpdatedAt) {
    await this.#ready();
    const providedId = String(data.id || '').trim();
    const origId = String(originalId || '').trim();
    let svar = null;

    this.ctx.storage.transactionSync(() => {
      // ── 1. Omdøbning ─────────────────────────────────────────────────────
      let arbejdsId = providedId;
      if (origId && providedId && origId !== providedId) {
        const orig = this.db.one('SELECT id FROM contracts WHERE id = ?', origId);
        if (!orig) {
          svar = { ok: false, error: 'Original kontrakt ikke fundet (id: ' + origId + ')' };
          return;
        }
        if (this.db.one('SELECT id FROM contracts WHERE id = ?', providedId)) {
          svar = { ok: false, error: 'Kontrakt-nr "' + providedId + '" er allerede i brug' };
          return;
        }
        this.db.run('UPDATE contracts SET id = ? WHERE id = ?', providedId, origId);
        // Cascade. I Sheets krævede dette en kolonnescanning række for række
        // (Code.gs:1889); her er det én sætning.
        this.db.run('UPDATE attendances SET contract_id = ? WHERE contract_id = ?',
          providedId, origId);
      }

      const eksisterende = arbejdsId
        ? this.db.one('SELECT id, updated_at FROM contracts WHERE id = ?', arbejdsId)
        : null;

      // ── 2. Beskyt mod utilsigtet overskrivning ───────────────────────────
      if (eksisterende && !origId) {
        svar = { ok: false, error: 'Kontrakt-nr "' + arbejdsId +
                 '" er allerede i brug. Vælg et andet nummer.' };
        return;
      }

      // ── 3. Optimistisk låsning ──────────────────────────────────────────
      if (eksisterende && expectedUpdatedAt) {
        const server = Date.parse(eksisterende.updatedAt || '') || 0;
        const klient = Date.parse(expectedUpdatedAt) || 0;
        if (server && klient && server > klient) {
          svar = { ok: false, conflict: true,
                   error: 'Kontrakten er ændret af en anden bruger siden du åbnede den. Genindlæs og prøv igen.' };
          return;
        }
      }

      const nu = new Date().toISOString();
      const felter = {
        type: data.type || 'Spillested',
        status: data.status || 'udkast',
        arrangoer: JSON.stringify(data.arrangoer || {}),
        venue: JSON.stringify(data.venue || {}),
        date: data.date ? String(data.date).slice(0, 10) : '',
        getIn: data.getIn || '',
        soundcheck: data.soundcheck || '',
        showtimeFrom: data.showtimeFrom || '',
        showtimeTo: data.showtimeTo || '',
        sets: Number(data.sets) || 0,
        setMinutes: Number(data.setMinutes) || 0,
        musicianCount: Number(data.musicianCount) || 0,
        crewCount: Number(data.crewCount) || 0,
        guestCount: Number(data.guestCount) || 0,
        honorar: Number(data.honorar) || 0,
        paymentTerms: data.paymentTerms || '',
        paymentTermsOther: data.paymentTermsOther || '',
        notes: data.notes || '',
        memberNote: data.memberNote || '',
        updatedAt: nu
      };

      if (!eksisterende) {
        if (!arbejdsId) arbejdsId = 'c' + this.#nextCounterSync('contract');
        this.db.insert('contracts', Object.assign({ id: arbejdsId, createdAt: nu }, felter));
      } else {
        this.db.update('contracts', felter, 'id = ?', arbejdsId);
      }

      this.#syncAttendances(arbejdsId, attendees || []);
      svar = { ok: true, id: arbejdsId };
    });

    return svar;
  }

  /**
   * Synkroniserer deltagerlisten for en kontrakt.
   *
   * HER AFVIGER VI BEVIDST FRA ORIGINALEN. Code.gs:1929 sletter ALLE
   * attendance-rækker for kontrakten og indsætter nye med status 'invited' og
   * tomme confirmedAt/checkedInAt. Konsekvensen er, at det at rette en stavefejl
   * i spillestedets navn nulstiller samtlige medlemmers bekræftelser og smider
   * de cachede køreafstande væk. Det er datatab uden formål — klienten sender
   * kun {memberId, share}, så den har ingen viden om tilstanden den overskriver.
   *
   * Her bevares tilstanden for de medlemmer der FORTSAT er på jobbet: kun
   * andelen opdateres. Nye medlemmer får en frisk 'invited'-række, og medlemmer
   * der er fjernet, får deres række slettet. Rosteren og andelene synkroniseres
   * altså præcis som før — men en bekræftelse går kun tabt, hvis medlemmet
   * faktisk bliver taget af jobbet.
   */
  #syncAttendances(contractId, attendees) {
    const cid = String(contractId);
    const eksisterende = this.db.rows(
      'SELECT * FROM attendances WHERE contract_id = ?', cid);
    const efterMedlem = new Map();
    for (const a of eksisterende) efterMedlem.set(String(a.memberId), a);

    const oenskede = new Set();
    let i = 0;
    for (const a of attendees) {
      const memberId = String(a.memberId || '');
      if (!memberId || oenskede.has(memberId)) continue;   // dedup på memberId
      oenskede.add(memberId);
      const share = Number(a.share) || 0;
      const gammel = efterMedlem.get(memberId);
      if (gammel) {
        // Bevar status, bekræftelse, check-in og afstandsdata.
        this.db.run('UPDATE attendances SET share = ? WHERE id = ?', share, gammel.id);
      } else {
        this.db.insert('attendances', {
          id: 'a' + this.#nextCounterSync('attendance') + '_' + (i++),
          contractId: cid,
          memberId,
          share,
          status: 'invited',
          confirmedAt: '',
          checkedInAt: ''
        });
      }
    }

    // Fjernede medlemmer.
    for (const a of eksisterende) {
      if (!oenskede.has(String(a.memberId))) {
        this.db.run('DELETE FROM attendances WHERE id = ?', a.id);
      }
    }
  }

  /** Counter-optælling inde i en igangværende transaktion (synkron). */
  #nextCounterSync(name) {
    this.db.run(
      `INSERT INTO counters (name, next) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET next = next + 1`,
      name
    );
    return Number(this.db.value('SELECT next FROM counters WHERE name = ?', name));
  }

  async changeContractStatus(id, status) {
    await this.#ready();
    const changed = this.db.update('contracts',
      { status, updatedAt: new Date().toISOString() }, 'id = ?', String(id));
    return { ok: changed > 0 };
  }

  async deleteContract(id) {
    await this.#ready();
    let fandtes = false;
    this.ctx.storage.transactionSync(() => {
      this.db.run('DELETE FROM contracts WHERE id = ?', String(id));
      fandtes = this.db.changes() > 0;
      // Attendances har ON DELETE CASCADE i skemaet, men SQLite håndhæver kun
      // fremmednøgler hvis PRAGMA foreign_keys er slået til for forbindelsen.
      // Vi sletter derfor eksplicit frem for at stole på det.
      if (fandtes) this.db.run('DELETE FROM attendances WHERE contract_id = ?', String(id));
    });
    return { ok: fandtes };
  }

  /**
   * Rådata til dashboardet i ÉT kald. Aggregeringen sker i kalderen, så
   * svarformen kan holdes bit-for-bit identisk med i dag.
   */
  async dashboardData(myMemberId) {
    await this.#ready();
    return {
      contracts: this.db.rows('SELECT * FROM contracts'),
      members: this.db.rows(
        'SELECT id, name, instrument, category FROM members ORDER BY name COLLATE NOCASE'),
      attendances: this.db.rows('SELECT contract_id, member_id, share, status FROM attendances'),
      memberCount: Number(this.db.value('SELECT count(*) AS c FROM members') ?? 0),
      myMemberId: myMemberId || null
    };
  }

  /** Opsummering til operatørlisten i master. Kaldes efter kontraktændringer. */
  async summaryStats() {
    await this.#ready();
    const iDag = new Date().toISOString().slice(0, 10);
    return {
      members: Number(this.db.value('SELECT count(*) AS c FROM members') ?? 0),
      upcoming: Number(this.db.value(
        "SELECT count(*) AS c FROM contracts WHERE date >= ?", iDag) ?? 0)
    };
  }

  // ── Jobs (medlemmets eget udsnit) ────────────────────────────────────────
  // Bemærk at intet herinde beregner eller skriver afstande. Det er hele
  // pointen: _ensureDistance (Code.gs:516) beregnede og SKREV midt på
  // læsestien, så en jobliste tog skrivelåsen. Her er læsning ren SELECT.

  /**
   * Medlemmets godkendte jobs med deltagerrækken. Kun 'godkendt' — et udkast er
   * ikke et job endnu, og et medlem skal ikke kunne se aftaler der ikke er
   * indgået.
   */
  async listMyJobs(memberId) {
    await this.#ready();
    return this.db.rows(
      `SELECT a.id AS attendance_id, a.share, a.status, a.confirmed_at, a.checked_in_at,
              a.start_address, a.distance_km, a.distance_origin, a.return_home,
              a.distance_round_trip,
              c.id AS contract_id, c.type, c.date, c.venue, c.get_in, c.soundcheck,
              c.showtime_from, c.showtime_to,
              CASE WHEN c.member_note IS NOT NULL AND c.member_note != '' THEN 1 ELSE 0 END
                AS has_member_note
         FROM attendances a
         JOIN contracts c ON c.id = a.contract_id
        WHERE a.member_id = ? AND c.status = 'godkendt'
        ORDER BY c.date ASC`,
      String(memberId)
    );
  }

  /** Én attendance + dens kontrakt. Verificerer ejerskab i samme forespørgsel. */
  async getMyJob(attendanceId, memberId) {
    await this.#ready();
    const a = this.db.one(
      'SELECT * FROM attendances WHERE id = ? AND member_id = ?',
      String(attendanceId), String(memberId));
    if (!a) return null;
    const c = this.db.one('SELECT * FROM contracts WHERE id = ?', a.contractId);
    if (!c) return { attendance: a, contract: null, besaetning: [] };
    const besaetning = this.db.rows(
      `SELECT m.id, m.name, m.instrument, a.status
         FROM attendances a JOIN members m ON m.id = a.member_id
        WHERE a.contract_id = ?
        GROUP BY m.id
        ORDER BY m.name COLLATE NOCASE`,
      a.contractId);
    return { attendance: a, contract: c, besaetning };
  }

  /** Kontrakten for en attendance — til afstandsberegning på skrivestien. */
  async getAttendanceWithContract(attendanceId, memberId) {
    await this.#ready();
    const a = this.db.one(
      'SELECT * FROM attendances WHERE id = ? AND member_id = ?',
      String(attendanceId), String(memberId));
    if (!a) return null;
    const c = this.db.one('SELECT * FROM contracts WHERE id = ?', a.contractId);
    return { attendance: a, contract: c };
  }

  /** Alle af medlemmets attendances med kontrakt — til bulk-genberegning. */
  async listMyAttendancesWithContracts(memberId) {
    await this.#ready();
    const rows = this.db.rows(
      `SELECT a.*, c.venue AS c_venue, c.status AS c_status
         FROM attendances a JOIN contracts c ON c.id = a.contract_id
        WHERE a.member_id = ?`,
      String(memberId));
    return rows.map(r => ({
      attendance: r,
      contract: { venue: r.cVenue, status: r.cStatus }
    }));
  }

  async setAttendanceDistance(id, km, origin, roundTrip) {
    await this.#ready();
    this.db.update('attendances', {
      distanceKm: km === '' ? null : km,
      distanceOrigin: origin || '',
      distanceRoundTrip: roundTrip ? 1 : 0
    }, 'id = ?', String(id));
    return { ok: true };
  }

  /** Sætter startadresse og TØMMER cachen, så næste beregning bruger ny origin. */
  async setAttendanceStartAddress(id, memberId, startAddress) {
    await this.#ready();
    const changed = this.db.update('attendances', {
      startAddress: startAddress || '',
      distanceKm: null, distanceOrigin: '', distanceRoundTrip: null
    }, 'id = ? AND member_id = ?', String(id), String(memberId));
    return { ok: changed > 0 };
  }

  async setAttendanceReturnHome(id, memberId, on) {
    await this.#ready();
    const changed = this.db.update('attendances', {
      returnHome: on ? 1 : 0,
      distanceKm: null, distanceOrigin: '', distanceRoundTrip: null
    }, 'id = ? AND member_id = ?', String(id), String(memberId));
    return { ok: changed > 0 };
  }

  /**
   * Tømmer afstandscachen for de jobs der brugte HJEMMEADRESSEN som origin.
   * Jobs med en egen startadresse er upåvirkede af at hjemmeadressen ændres.
   */
  async invalidateHomeDistances(memberId) {
    await this.#ready();
    this.db.run(
      `UPDATE attendances
          SET distance_km = NULL, distance_origin = '', distance_round_trip = NULL
        WHERE member_id = ? AND (start_address IS NULL OR start_address = '')`,
      String(memberId));
    return { ok: true, ryddet: this.db.changes() };
  }

  // ── Afstandscache (pr. band) ─────────────────────────────────────────────

  async getDistanceCache(key) {
    await this.#ready();
    const v = this.db.value('SELECT km FROM distance_cache WHERE key = ?', String(key));
    return (v === null || v === undefined) ? null : Number(v);
  }

  async putDistanceCache(key, origin, destination, km) {
    await this.#ready();
    this.db.run(
      `INSERT INTO distance_cache (key, origin, destination, km, cached_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET km = excluded.km, cached_at = excluded.cached_at`,
      String(key), origin, destination, km, new Date().toISOString());
    return { ok: true };
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
  /**
   * Sætter felter på én attendance-række. KUN til selvtesten, som skal kunne
   * simulere at et medlem har bekræftet, før den kan bevise at et gem ikke
   * nulstiller bekræftelsen. Der findes ingen produktionssti hertil — de rigtige
   * ændringer sker gennem confirmAttendance og afstandsberegningen i Fase 3d.
   */
  async updateAttendanceForTest(id, patch) {
    await this.#ready();
    const changed = this.db.update('attendances', patch, 'id = ?', String(id));
    return { ok: changed > 0 };
  }

  /**
   * Antal attendance-rækker der peger på en kontrakt der ikke findes. Skal
   * altid være 0 — en forældreløs række indgår i honorarfordeling og dashboard
   * og ville trække forkerte tal med sig.
   */
  async countOrphanAttendances() {
    await this.#ready();
    return Number(this.db.value(
      `SELECT count(*) AS c FROM attendances a
        WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.id = a.contract_id)`) ?? 0);
  }

  /**
   * SQLites total_changes() — samlet antal rækker ændret siden forbindelsen blev
   * åbnet. Selvtesten bruger den til at BEVISE at læsestien ikke skriver: en
   * påstand om "vi rører ikke databasen" er ellers kun en hensigt, og det var
   * netop den hensigt _ensureDistance (Code.gs:516) brød.
   */
  async writeCounter() {
    await this.#ready();
    return Number(this.db.value('SELECT total_changes() AS c') ?? 0);
  }

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
