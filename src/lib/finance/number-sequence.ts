/**
 * Document number sequences (per tenant + prefix), backed by the SQL database.
 *
 * Generates monotonically increasing, zero-padded document numbers like
 * `INV-0001`, `Q-0001`. Backed by an atomic counter row in `_seq_counter` so
 * numbers are durable across restarts and safe under concurrency. On SQL Server
 * a `MERGE … WITH (HOLDLOCK)` serialises increments per tenant+prefix; on MySQL
 * an `INSERT … ON DUPLICATE KEY UPDATE` with the `LAST_INSERT_ID(value+1)` idiom
 * returns the new value atomically.
 */
import { getDriver } from "@/lib/data/sql/driver";
import { getDialect } from "@/lib/data/sql/dialect";
import { T } from "@/lib/data/sql/types";
import { usingInMemoryBackends } from "@/lib/config/env";

export class NumberSequence {
  async next(tenantId: string, prefix: string, pad = 4): Promise<string> {
    const driver = await getDriver();
    const dialect = await getDialect();
    const t = dialect.table("_seq_counter");
    const cTenant = dialect.id("tenantId");
    const cPrefix = dialect.id("prefix");
    const cValue = dialect.id("value");
    const p0 = dialect.placeholder(0);
    const p1 = dialect.placeholder(1);
    const params = [
      { value: tenantId, type: T.string(80) },
      { value: prefix, type: T.string(40) },
    ];

    let n: number;
    if (dialect.client === "mysql") {
      const res = await driver.query(
        `INSERT INTO ${t} (${cTenant}, ${cPrefix}, ${cValue}) VALUES (${p0}, ${p1}, 1) ` +
          `ON DUPLICATE KEY UPDATE ${cValue} = LAST_INSERT_ID(${cValue} + 1)`,
        params,
      );
      // A fresh insert changes 1 row (value = 1); an update changes 2 and carries
      // the new value in LAST_INSERT_ID() → insertId.
      n = res.rowsAffected === 1 ? 1 : Number(res.insertId);
    } else {
      const res = await driver.query(
        `MERGE ${t} WITH (HOLDLOCK) AS target ` +
          `USING (SELECT ${p0} AS tenantId, ${p1} AS prefix) AS src ` +
          `ON target.${cTenant} = src.tenantId AND target.${cPrefix} = src.prefix ` +
          `WHEN MATCHED THEN UPDATE SET ${cValue} = target.${cValue} + 1 ` +
          `WHEN NOT MATCHED THEN INSERT (${cTenant}, ${cPrefix}, ${cValue}) VALUES (${p0}, ${p1}, 1) ` +
          `OUTPUT inserted.${cValue} AS val;`,
        params,
      );
      n = Number((res.rows[0] as { val: number }).val);
    }
    return `${prefix}-${String(n).padStart(pad, "0")}`;
  }

  /** Raise the counter so seeded/imported documents don't collide. */
  async bump(tenantId: string, prefix: string, n: number): Promise<void> {
    const driver = await getDriver();
    const dialect = await getDialect();
    const t = dialect.table("_seq_counter");
    const cTenant = dialect.id("tenantId");
    const cPrefix = dialect.id("prefix");
    const cValue = dialect.id("value");

    if (dialect.client === "mysql") {
      await driver.query(
        `INSERT INTO ${t} (${cTenant}, ${cPrefix}, ${cValue}) VALUES (?, ?, ?) ` +
          `ON DUPLICATE KEY UPDATE ${cValue} = GREATEST(${cValue}, ?)`,
        [
          { value: tenantId, type: T.string(80) },
          { value: prefix, type: T.string(40) },
          { value: n, type: T.int },
          { value: n, type: T.int },
        ],
      );
    } else {
      const p0 = dialect.placeholder(0);
      const p1 = dialect.placeholder(1);
      const p2 = dialect.placeholder(2);
      await driver.query(
        `MERGE ${t} WITH (HOLDLOCK) AS target ` +
          `USING (SELECT ${p0} AS tenantId, ${p1} AS prefix) AS src ` +
          `ON target.${cTenant} = src.tenantId AND target.${cPrefix} = src.prefix ` +
          `WHEN MATCHED THEN UPDATE SET ${cValue} = CASE WHEN target.${cValue} < ${p2} THEN ${p2} ELSE target.${cValue} END ` +
          `WHEN NOT MATCHED THEN INSERT (${cTenant}, ${cPrefix}, ${cValue}) VALUES (${p0}, ${p1}, ${p2});`,
        [
          { value: tenantId, type: T.string(80) },
          { value: prefix, type: T.string(40) },
          { value: n, type: T.int },
        ],
      );
    }
  }
}

/**
 * Process-local sequence used when `AULA_PERSISTENCE=memory`. Structurally
 * compatible with {@link NumberSequence} (async `next`/`bump`) so it is a drop-in
 * for the finance service and seeder.
 */
export class MemoryNumberSequence {
  private counters = new Map<string, number>();

  async next(tenantId: string, prefix: string, pad = 4): Promise<string> {
    const key = `${tenantId}:${prefix}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return `${prefix}-${String(n).padStart(pad, "0")}`;
  }

  async bump(tenantId: string, prefix: string, n: number): Promise<void> {
    const key = `${tenantId}:${prefix}`;
    this.counters.set(key, Math.max(this.counters.get(key) ?? 0, n));
  }
}

export const numberSequence: NumberSequence = usingInMemoryBackends
  ? new MemoryNumberSequence()
  : new NumberSequence();
