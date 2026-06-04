/**
 * Local-disk file storage.
 *
 * Stores uploaded file bytes on the backend host under `UPLOAD_DIR` (default
 * `<cwd>/uploads`), one file per record id. Metadata (name, folder, size, owner)
 * lives in the `file` entity table; this module owns only the bytes. Swap this
 * for S3/Azure by implementing the same three functions.
 */
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import type { ReadStream } from "node:fs";
import { env } from "@/lib/config/env";

function baseDir(): string {
  return env.UPLOAD_DIR && env.UPLOAD_DIR.trim() ? env.UPLOAD_DIR.trim() : path.join(process.cwd(), "uploads");
}

/** Resolve the absolute path for a record's blob, guarding against traversal. */
function blobPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe file id: ${id}`);
  return path.join(baseDir(), id);
}

export async function saveBlob(id: string, data: Buffer): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true });
  await fs.writeFile(blobPath(id), data);
}

export async function blobSize(id: string): Promise<number | null> {
  try {
    const s = await fs.stat(blobPath(id));
    return s.size;
  } catch {
    return null;
  }
}

export function openBlob(id: string): ReadStream {
  return createReadStream(blobPath(id));
}

export async function blobExists(id: string): Promise<boolean> {
  try {
    await fs.access(blobPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function deleteBlob(id: string): Promise<void> {
  try {
    await fs.unlink(blobPath(id));
  } catch {
    // already gone — fine
  }
}
