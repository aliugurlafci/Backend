/**
 * Phase 14 — Metadata publish governance + rollback.
 *
 * Gates the metadata publish pipeline (Phase 2) behind an authorization check
 * and records the action in the release audit trail. Only admins (or the system
 * actor) may publish or roll back metadata.
 */
import { ForbiddenError } from "@/lib/enforcement/errors";
import type { RequestContext } from "@/lib/context/types";
import { metadataRegistry } from "@/lib/metadata";
import type { MetadataVersion } from "@/lib/metadata/types";
import { releaseLog } from "./release";

function assertCanGovern(ctx: RequestContext): void {
  if (!ctx.isSystem && !ctx.roles.includes("admin")) {
    throw new ForbiddenError("only administrators may publish or roll back metadata");
  }
}

/** Governed metadata publish — authorization + audit around registry.publish. */
export function publishMetadata(ctx: RequestContext, version: number, note?: string): MetadataVersion {
  assertCanGovern(ctx);
  const published = metadataRegistry.publish(version, ctx.userId, ctx.at);
  releaseLog.record(ctx, { kind: "metadata_publish", version, note });
  return published;
}

/** Roll the active metadata back to a prior version. */
export function rollbackMetadata(ctx: RequestContext, toVersion: number, note?: string): MetadataVersion {
  assertCanGovern(ctx);
  const restored = metadataRegistry.publish(toVersion, ctx.userId, ctx.at);
  releaseLog.record(ctx, { kind: "rollback", version: toVersion, note: note ?? "metadata rollback" });
  return restored;
}
