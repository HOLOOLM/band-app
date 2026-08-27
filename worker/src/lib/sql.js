// SQL-helpere oven på et Durable Objects SQLite-lager (ctx.storage.sql).
//
// Kolonnenavne i skemaet er snake_case og identiske med de gamle SHEET_HEADERS
// (Code.gs:28-52). JSON ud mod frontenden er camelCase. Konverteringen sker KUN
// her, så ingen action laver ad-hoc-mapping — det var en af faldgruberne i planen.

/** snake_case → camelCase. `member_note` → `memberNote`. */
export function toCamelKey(k) {
  return k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** camelCase → snake_case. `memberNote` → `member_note`. */
export function toSnakeKey(k) {
  return k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

/** Mapper én række fra SQL til camelCase-objekt. */
export function rowToCamel(row) {
  if (!row) return row;
  const out = {};
  for (const k in row) out[toCamelKey(k)] = row[k];
  return out;
}

/** Mapper et camelCase-objekt til snake_case kolonner. */
export function objToSnake(obj) {
  const out = {};
  for (const k in obj) out[toSnakeKey(k)] = obj[k];
  return out;
}

/**
 * Wrapper om ctx.storage.sql med camelCase-mapping.
 *
 * Bemærk at forespørgsler her er synkrone og kører i samme proces som dataen —
 * der er ingen netværkstur, så `await` er hverken nødvendigt eller ønskeligt.
 */
export class Db {
  constructor(sqlStorage) {
    this.sql = sqlStorage;
  }

  /** Alle rækker som camelCase-objekter. */
  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray().map(rowToCamel);
  }

  /** Første række som camelCase-objekt, eller null. */
  one(query, ...params) {
    const r = this.sql.exec(query, ...params).toArray();
    return r.length ? rowToCamel(r[0]) : null;
  }

  /** Enkelt skalarværdi fra første kolonne i første række, eller null. */
  value(query, ...params) {
    const r = this.sql.exec(query, ...params).toArray();
    if (!r.length) return null;
    const row = r[0];
    const first = Object.keys(row)[0];
    return first === undefined ? null : row[first];
  }

  /** Kør en sætning. Returnerer antal ændrede rækker. */
  run(query, ...params) {
    return this.sql.exec(query, ...params).rowsWritten;
  }

  /**
   * DDL eller flere sætninger adskilt af semikolon. Bindinger er ikke tilladt
   * når man sender flere sætninger — derfor et separat kald frem for run().
   */
  exec(multiStatementSql) {
    this.sql.exec(multiStatementSql);
  }

  /**
   * INSERT fra et camelCase-objekt. Kolonner udledes af nøglerne, så kaldere
   * ikke skal skrive kolonnelister to gange.
   */
  insert(table, obj) {
    const snake = objToSnake(obj);
    const cols = Object.keys(snake);
    if (!cols.length) throw new Error('insert() uden felter');
    const q = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return this.run(q, ...cols.map(c => snake[c]));
  }

  /**
   * UPDATE fra et camelCase-objekt. `where` er rå SQL uden "WHERE".
   * Returnerer antal ændrede rækker — 0 bruges til optimistisk låsning
   * (expectedUpdatedAt-tjekket, jf. 05-honorar.js:465).
   */
  update(table, obj, where, ...whereParams) {
    const snake = objToSnake(obj);
    const cols = Object.keys(snake);
    if (!cols.length) throw new Error('update() uden felter');
    const q = `UPDATE ${table} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE ${where}`;
    this.sql.exec(q, ...cols.map(c => snake[c]), ...whereParams);
    return this.changes();
  }

  /**
   * Antal rækker ændret af seneste sætning. Bruges til optimistisk låsning:
   * 0 betyder "ingen række matchede", altså at updated_at var flyttet under os.
   * Bemærk at cursor.rowsWritten IKKE kan bruges — den tæller også
   * indeksskrivninger og er derfor > 0 selv når ingen række matchede.
   */
  changes() {
    return Number(this.value('SELECT changes() AS c') ?? 0);
  }
}
