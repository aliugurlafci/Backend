/**
 * File blob storage.
 *
 * Stores uploaded file BYTES so they travel with the metadata and stay findable
 * from any backend host/instance. The `file` entity row holds the metadata
 * (name, folder, size, owner, mimeType, storageKey); this module owns only the
 * bytes, keyed by the same `file` record id.
 *
 * Backends (chosen by persistence mode):
 *   - mssql  : bytes in the `_file_blob` table (VARBINARY(MAX)) — durable, shared
 *              across instances, restored together with the database.
 *   - memory : in-process Map (dev / smoke tests, no DB or disk required).
 *
 * Read falls back to legacy local-disk blobs (`UPLOAD_DIR/<id>`) so files
 * uploaded before this change keep working; a successful disk read is lazily
 * backfilled into the durable store. Swap in S3/Azure by reimplementing the
 * same exported functions.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { env, usingInMemoryBackends } from "@/lib/config/env";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";

export interface StoredBlob {
  data: Buffer;
  mimeType: string | null;
}

function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---- legacy local-disk fallback (read-only migration path) -----------------

function baseDir(): string {
  return env.UPLOAD_DIR && env.UPLOAD_DIR.trim() ? env.UPLOAD_DIR.trim() : path.join(process.cwd(), "uploads");
}

/** Resolve the absolute path for a legacy disk blob, guarding against traversal. */
function diskPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe file id: ${id}`);
  return path.join(baseDir(), id);
}

async function readDisk(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(diskPath(id));
  } catch {
    return null;
  }
}

async function deleteDisk(id: string): Promise<void> {
  try {
    await fs.unlink(diskPath(id));
  } catch {
    // already gone — fine
  }
}

// ---- in-memory backend (memory persistence mode) ---------------------------

const memStore: Map<string, StoredBlob> =
  ((globalThis as unknown as { __aulaBlobs?: Map<string, StoredBlob> }).__aulaBlobs ??= new Map());

// ---- MSSQL backend ---------------------------------------------------------

async function mssqlSave(id: string, data: Buffer, mime: string | null): Promise<void> {
  const { getPool, sql } = await import("@/lib/data/mssql/connection");
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.NVarChar(80), id)
    .input("data", sql.VarBinary(sql.MAX), data)
    .input("mime", sql.NVarChar(160), mime)
    .input("size", sql.Int, data.length)
    .input("sha", sql.NVarChar(64), sha256Of(data))
    .input("at", sql.NVarChar(40), systemClock.isoNow())
    .query(
      `MERGE [dbo].[_file_blob] AS t USING (SELECT @id AS id) AS s ON t.[id] = s.id ` +
        `WHEN MATCHED THEN UPDATE SET [data] = @data, [mimeType] = @mime, [sizeBytes] = @size, [sha256] = @sha, [createdAt] = @at ` +
        `WHEN NOT MATCHED THEN INSERT ([id],[data],[mimeType],[sizeBytes],[sha256],[createdAt]) VALUES (@id,@data,@mime,@size,@sha,@at);`,
    );
}

async function mssqlRead(id: string): Promise<StoredBlob | null> {
  const { getPool, sql } = await import("@/lib/data/mssql/connection");
  const pool = await getPool();
  const res = await pool.request().input("id", sql.NVarChar(80), id).query(
    `SELECT [data], [mimeType] FROM [dbo].[_file_blob] WHERE [id] = @id`,
  );
  const row = res.recordset[0] as { data: Buffer; mimeType: string | null } | undefined;
  if (!row) return null;
  return { data: row.data, mimeType: row.mimeType ?? null };
}

async function mssqlDelete(id: string): Promise<void> {
  const { getPool, sql } = await import("@/lib/data/mssql/connection");
  const pool = await getPool();
  await pool.request().input("id", sql.NVarChar(80), id).query(`DELETE FROM [dbo].[_file_blob] WHERE [id] = @id`);
}

// ---- public API ------------------------------------------------------------

/** Persist a file's bytes under its record id (durable store + optional mime). */
export async function saveBlob(id: string, data: Buffer, mime?: string | null): Promise<void> {
  const mimeType = mime && mime.trim() ? mime.trim() : null;
  if (usingInMemoryBackends) {
    memStore.set(id, { data, mimeType });
    return;
  }
  await mssqlSave(id, data, mimeType);
}

/** Read a file's bytes (durable store first, then legacy disk with backfill). */
export async function readBlob(id: string): Promise<StoredBlob | null> {
  if (usingInMemoryBackends) {
    const mem = memStore.get(id);
    if (mem) return mem;
    const disk = await readDisk(id);
    return disk ? { data: disk, mimeType: null } : null;
  }
  const durable = await mssqlRead(id);
  if (durable) return durable;
  // Legacy blob still on local disk → serve it and migrate it into the DB.
  const disk = await readDisk(id);
  if (!disk) return null;
  try {
    await mssqlSave(id, disk, null);
    await deleteDisk(id);
  } catch (e) {
    logger.warn("file blob disk→db backfill failed", { id, error: e instanceof Error ? e.message : String(e) });
  }
  return { data: disk, mimeType: null };
}

/** Whether a blob exists (durable store or legacy disk). */
export async function blobExists(id: string): Promise<boolean> {
  if (usingInMemoryBackends) {
    if (memStore.has(id)) return true;
    return (await readDisk(id)) !== null;
  }
  const durable = await mssqlRead(id);
  if (durable) return true;
  return (await readDisk(id)) !== null;
}

/** Remove a file's bytes from every store. */
export async function deleteBlob(id: string): Promise<void> {
  if (usingInMemoryBackends) {
    memStore.delete(id);
  } else {
    try {
      await mssqlDelete(id);
    } catch (e) {
      logger.warn("file blob delete failed", { id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await deleteDisk(id); // also clear any legacy disk copy
}
