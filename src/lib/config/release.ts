/**
 * Phase 14 — Release audit trail + rollback.
 *
 * Records every governed release action (metadata publish, rollback, migration)
 * with who/when, providing an auditable history and the mechanism for rollback.
 */
import { newId } from "@/lib/core/ids";
import type { RequestContext } from "@/lib/context/types";

export type ReleaseKind = "metadata_publish" | "rollback" | "migration";

export interface ReleaseRecord {
  id: string;
  at: string;
  actor: string;
  kind: ReleaseKind;
  version?: number;
  note?: string;
}

export class ReleaseLog {
  private records: ReleaseRecord[] = [];

  record(ctx: RequestContext, input: { kind: ReleaseKind; version?: number; note?: string }): ReleaseRecord {
    const entry: ReleaseRecord = {
      id: newId("rel"),
      at: ctx.at,
      actor: ctx.userId,
      ...input,
    };
    this.records.push(entry);
    return entry;
  }

  list(): ReleaseRecord[] {
    return [...this.records].reverse();
  }
}

export const releaseLog = new ReleaseLog();
