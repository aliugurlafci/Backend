/**
 * Document number sequences (per tenant + prefix), backed by MSSQL.
 *
 * Generates monotonically increasing, zero-padded document numbers like
 * `INV-0001`, `Q-0001`. Backed by an atomic counter row in `_seq_counter` so
 * numbers are durable across restarts and safe under concurrency (the MERGE
 * with HOLDLOCK serialises increments per tenant+prefix).
 */
import { getPool, sql } from "@/lib/data/mssql/connection";
import { usingInMemoryBackends } from "@/lib/config/env";

export class NumberSequence {
  async next(tenantId: string, prefix: string, pad = 4): Promise<string> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("t", sql.NVarChar(80), tenantId)
      .input("p", sql.NVarChar(40), prefix)
      .query(`
        MERGE [dbo].[_seq_counter] WITH (HOLDLOCK) AS target
        USING (SELECT @t AS tenantId, @p AS prefix) AS src
          ON target.[tenantId] = src.tenantId AND target.[prefix] = src.prefix
        WHEN MATCHED THEN UPDATE SET [value] = target.[value] + 1
        WHEN NOT MATCHED THEN INSERT ([tenantId], [prefix], [value]) VALUES (@t, @p, 1)
        OUTPUT inserted.[value] AS val;
      `);
    const n = Number((result.recordset[0] as { val: number }).val);
    return `${prefix}-${String(n).padStart(pad, "0")}`;
  }

  /** Raise the counter so seeded/imported documents don't collide. */
  async bump(tenantId: string, prefix: string, n: number): Promise<void> {
    const pool = await getPool();
    await pool
      .request()
      .input("t", sql.NVarChar(80), tenantId)
      .input("p", sql.NVarChar(40), prefix)
      .input("n", sql.Int, n)
      .query(`
        MERGE [dbo].[_seq_counter] WITH (HOLDLOCK) AS target
        USING (SELECT @t AS tenantId, @p AS prefix) AS src
          ON target.[tenantId] = src.tenantId AND target.[prefix] = src.prefix
        WHEN MATCHED THEN UPDATE SET [value] = CASE WHEN target.[value] < @n THEN @n ELSE target.[value] END
        WHEN NOT MATCHED THEN INSERT ([tenantId], [prefix], [value]) VALUES (@t, @p, @n);
      `);
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
