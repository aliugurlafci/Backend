/**
 * File upload and download (local-disk storage).
 */

import { type Router } from "express";
import Busboy from "busboy";
import { runApi, setApiHeaders, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { BadRequestError, NotFoundError } from "@/lib/enforcement/errors";
import { saveBlob, readBlob } from "@/lib/integrations/file-storage";

/** Best-effort content-type from a filename (used for inline file/image serving). */
function guessFileContentType(name: string): string {
  switch (name.toLowerCase().split(".").pop()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** MIME types that are unsafe to store/serve (script/markup the browser may
 *  execute when served inline → stored-XSS). Rejected at upload time. */
const BLOCKED_UPLOAD_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-sh",
]);

/** Content-types we allow to render inline on download; everything else is forced
 *  to download as an attachment so it can never execute in the browsing context. */
const INLINE_SAFE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function registerFileRoutes(r: Router): void {
  // ---- files: real upload / download (local-disk storage) ----------------
  r.post(
    "/files/upload",
    runApi(
      async (rc, req) => {
        const { buffer, filename, folder, mimeType } = await new Promise<{
          buffer: Buffer;
          filename: string;
          folder: string;
          mimeType: string;
        }>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let filename = "upload";
          let folder = "documents";
          let mimeType = "";
          let tooBig = false;
          const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
          bb.on("file", (_name, stream, info) => {
            if (info.filename) filename = info.filename;
            if (info.mimeType) mimeType = info.mimeType;
            stream.on("data", (d: Buffer) => chunks.push(d));
            stream.on("limit", () => {
              tooBig = true;
            });
          });
          bb.on("field", (name, value) => {
            if (name === "folder" && value) folder = value;
          });
          bb.on("close", () =>
            tooBig
              ? reject(new BadRequestError("file exceeds the 100 MB limit"))
              : resolve({ buffer: Buffer.concat(chunks), filename, folder, mimeType }),
          );
          bb.on("error", reject);
          req.pipe(bb);
        });

        if (!buffer.length) throw new BadRequestError("no file uploaded");
        const domain = await getDomainService();
        // Captured content-type → served verbatim on download (no guessing); fall
        // back to the filename guess so older clients without a type still work.
        const resolvedMime = mimeType.trim() || guessFileContentType(filename);
        // Reject script/markup uploads that could execute as stored-XSS if served.
        if (BLOCKED_UPLOAD_MIME.has((resolvedMime.toLowerCase().split(";")[0] ?? "").trim())) {
          throw new BadRequestError(`file type "${resolvedMime}" is not allowed`).withKey("err.fileTypeNotAllowed", { type: resolvedMime });
        }
        const record = await domain.create(rc, "file", {
          name: filename,
          folder,
          sizeKb: Math.max(1, Math.round(buffer.length / 1024)),
          mimeType: resolvedMime,
          owner: rc.displayName,
        });
        try {
          await saveBlob(record.id, buffer, resolvedMime); // bytes keyed by the record id (durable store)
        } catch (e) {
          // Atomicity: never leave a metadata row whose bytes failed to persist.
          await domain.remove(rc, "file", record.id).catch(() => {});
          throw e;
        }
        // Make the blob↔record link explicit + portable (was implicit id==filename).
        return domain.update(rc, "file", record.id, { storageKey: `db:${record.id}` });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/files/:id/download", runApi(async (rc, req, res) => {
    const domain = await getDomainService();
    const record = await domain.get(rc, "file", pathParam(req, "id")); // enforces read + tenant scope
    const blob = await readBlob(pathParam(req, "id"));
    if (!blob) throw new NotFoundError("file", pathParam(req, "id"));
    const name = String(record.name);
    // `?inline=1` serves with the real content-type + inline disposition so chat
    // image attachments render in <img>; the default stays a forced download.
    // Prefer the stored mimeType (row → blob), falling back to a filename guess.
    const contentType =
      (typeof record.mimeType === "string" && record.mimeType.trim()) || blob.mimeType || guessFileContentType(name);
    // Only render inline when both requested AND the type is on the safe list;
    // anything else is forced to download so it can't execute in the page context.
    const inline =
      (req.query.inline === "1" || req.query.inline === "true") &&
      // An unreadable type is not in the safe set, so it downloads rather than
      // rendering — the failure direction that cannot execute in the page.
      INLINE_SAFE_MIME.has((contentType.toLowerCase().split(";")[0] ?? "").trim());
    setApiHeaders(res, rc.correlationId);
    res.setHeader("content-type", inline ? contentType : "application/octet-stream");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-length", blob.data.length);
    res.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`);
    res.end(blob.data);
  }));

}
