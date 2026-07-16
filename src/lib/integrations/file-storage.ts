/**
 * File blob storage.
 *
 * Stores uploaded file BYTES so they travel with the metadata and stay findable
 * from any backend host/instance. The `file` entity row holds the metadata
 * (name, folder, size, owner, mimeType, storageKey); this module owns only the
 * bytes, keyed by the same `file` record id.
 *
 * Backends (chosen by persistence mode):
 *   - sql    : bytes in the `_file_blob` table (VARBINARY(MAX) on SQL Server,
 *              LONGBLOB on MySQL) — durable, shared across instances, restored
 *              together with the database.
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

// ---- SQL backend (SQL Server / MySQL) --------------------------------------

async function sqlDeps() {
  const [{ getDriver }, { getDialect }, { T }] = await Promise.all([
    import("@/lib/data/sql/driver"),
    import("@/lib/data/sql/dialect"),
    import("@/lib/data/sql/types"),
  ]);
  const [driver, dialect] = await Promise.all([getDriver(), getDialect()]);
  return { driver, dialect, T };
}

async function sqlSave(id: string, data: Buffer, mime: string | null): Promise<void> {
  const { driver, dialect, T } = await sqlDeps();
  const t = dialect.table("_file_blob");
  const c = (n: string) => dialect.id(n);
  const size = data.length;
  const sha = sha256Of(data);
  const at = systemClock.isoNow();
  const bId = { value: id, type: T.string(80) };
  const bData = { value: data, type: T.binary };
  const bMime = { value: mime, type: T.string(160) };
  const bSize = { value: size, type: T.int };
  const bSha = { value: sha, type: T.string(64) };
  const bAt = { value: at, type: T.string(40) };

  if (dialect.client === "mysql") {
    await driver.query(
      `INSERT INTO ${t} (${c("id")}, ${c("data")}, ${c("mimeType")}, ${c("sizeBytes")}, ${c("sha256")}, ${c("createdAt")}) ` +
        `VALUES (?, ?, ?, ?, ?, ?) ` +
        `ON DUPLICATE KEY UPDATE ${c("data")} = ?, ${c("mimeType")} = ?, ${c("sizeBytes")} = ?, ${c("sha256")} = ?, ${c("createdAt")} = ?`,
      [bId, bData, bMime, bSize, bSha, bAt, bData, bMime, bSize, bSha, bAt],
    );
    return;
  }
  const p0 = dialect.placeholder(0);
  await driver.query(
    `MERGE ${t} AS tgt USING (SELECT ${p0} AS id) AS s ON tgt.${c("id")} = s.id ` +
      `WHEN MATCHED THEN UPDATE SET ${c("data")} = ${dialect.placeholder(1)}, ${c("mimeType")} = ${dialect.placeholder(2)}, ` +
      `${c("sizeBytes")} = ${dialect.placeholder(3)}, ${c("sha256")} = ${dialect.placeholder(4)}, ${c("createdAt")} = ${dialect.placeholder(5)} ` +
      `WHEN NOT MATCHED THEN INSERT (${c("id")}, ${c("data")}, ${c("mimeType")}, ${c("sizeBytes")}, ${c("sha256")}, ${c("createdAt")}) ` +
      `VALUES (${p0}, ${dialect.placeholder(1)}, ${dialect.placeholder(2)}, ${dialect.placeholder(3)}, ${dialect.placeholder(4)}, ${dialect.placeholder(5)});`,
    [bId, bData, bMime, bSize, bSha, bAt],
  );
}

async function sqlRead(id: string): Promise<StoredBlob | null> {
  const { driver, dialect, T } = await sqlDeps();
  const res = await driver.query(
    `SELECT ${dialect.id("data")}, ${dialect.id("mimeType")} FROM ${dialect.table("_file_blob")} WHERE ${dialect.id("id")} = ${dialect.placeholder(0)}`,
    [{ value: id, type: T.string(80) }],
  );
  const row = res.rows[0] as { data: Buffer; mimeType: string | null } | undefined;
  if (!row) return null;
  return { data: row.data, mimeType: row.mimeType ?? null };
}

async function sqlDelete(id: string): Promise<void> {
  const { driver, dialect, T } = await sqlDeps();
  await driver.query(
    `DELETE FROM ${dialect.table("_file_blob")} WHERE ${dialect.id("id")} = ${dialect.placeholder(0)}`,
    [{ value: id, type: T.string(80) }],
  );
}

// ---- public API ------------------------------------------------------------

/** Persist a file's bytes under its record id (durable store + optional mime). */
export async function saveBlob(id: string, data: Buffer, mime?: string | null): Promise<void> {
  const mimeType = mime && mime.trim() ? mime.trim() : null;
  if (usingInMemoryBackends) {
    memStore.set(id, { data, mimeType });
    return;
  }
  await sqlSave(id, data, mimeType);
}

/** Read a file's bytes (durable store first, then legacy disk with backfill). */
export async function readBlob(id: string): Promise<StoredBlob | null> {
  if (usingInMemoryBackends) {
    const mem = memStore.get(id);
    if (mem) return mem;
    const disk = await readDisk(id);
    return disk ? { data: disk, mimeType: null } : null;
  }
  const durable = await sqlRead(id);
  if (durable) return durable;
  // Legacy blob still on local disk → serve it and migrate it into the DB.
  const disk = await readDisk(id);
  if (!disk) return null;
  try {
    await sqlSave(id, disk, null);
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
  const durable = await sqlRead(id);
  if (durable) return true;
  return (await readDisk(id)) !== null;
}

/** Remove a file's bytes from every store. */
export async function deleteBlob(id: string): Promise<void> {
  if (usingInMemoryBackends) {
    memStore.delete(id);
  } else {
    try {
      await sqlDelete(id);
    } catch (e) {
      logger.warn("file blob delete failed", { id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await deleteDisk(id); // also clear any legacy disk copy
}
