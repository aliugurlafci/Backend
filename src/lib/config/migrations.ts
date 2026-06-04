/**
 * Phase 14 — Migration strategy.
 *
 * A forward-only, idempotent migration ledger. The in-memory backend needs no
 * schema, so migrations are tracked here and mapped to SQL files under
 * `migrations/` for the PostgreSQL backend. `apply` records each run in the
 * release audit trail.
 */
import type { RequestContext } from "@/lib/context/types";
import { releaseLog } from "./release";

export interface Migration {
  id: string;
  description: string;
}

export const MIGRATIONS: Migration[] = [
  { id: "0001_init", description: "Create core CRM tables (accounts, contacts, deals, tasks)" },
  { id: "0002_audit", description: "Add audit_log and outbox tables" },
];

export class MigrationRunner {
  private applied = new Set<string>();

  pending(): Migration[] {
    return MIGRATIONS.filter((m) => !this.applied.has(m.id));
  }

  appliedIds(): string[] {
    return [...this.applied];
  }

  apply(ctx: RequestContext): Migration[] {
    const ran = this.pending();
    for (const m of ran) {
      this.applied.add(m.id);
      releaseLog.record(ctx, { kind: "migration", note: `${m.id}: ${m.description}` });
    }
    return ran;
  }
}

export const migrationRunner = new MigrationRunner();
