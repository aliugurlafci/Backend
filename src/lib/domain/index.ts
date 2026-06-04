/**
 * Phase 7 — Domain layer barrel + service wiring.
 */
import { metadata } from "@/lib/metadata";
import { permissionEngine } from "@/lib/permissions/engine";
import { getQueryEngine } from "@/lib/data/store";
import { eventBus } from "@/lib/workflow/event-bus";
import { idempotencyStore } from "@/lib/workflow/idempotency";
import { ensurePlatform } from "@/lib/bootstrap";
import { auditLog } from "./audit";
import { DomainService } from "./service";

const globalRef = globalThis as unknown as { __aulaDomain?: DomainService };

/** Resolve the domain service, ensuring the store is seeded and platform wired. */
export async function getDomainService(): Promise<DomainService> {
  const qe = await getQueryEngine();
  ensurePlatform();
  globalRef.__aulaDomain ??= new DomainService(
    qe,
    metadata,
    permissionEngine,
    eventBus,
    idempotencyStore,
    auditLog,
  );
  return globalRef.__aulaDomain;
}

export { DomainService } from "./service";
export type { TransitionOption } from "./service";
export { AuditLog, auditLog } from "./audit";
export type { AuditEntry, AuditAction } from "./audit";
export { StateMachine } from "./state-machine";
export { INVARIANTS, runGuards } from "./invariants";
