/**
 * Phase 7 — Lifecycle state machine engine.
 *
 * A metadata-driven finite state machine built from an entity's LifecycleDef.
 * It answers which transitions are legal from a given state; permissions and
 * invariants are layered on top by the domain service.
 */
import type { LifecycleDef, LifecycleTransition } from "@/lib/metadata/types";

export class StateMachine {
  constructor(private readonly def: LifecycleDef) {}

  get field(): string {
    return this.def.field;
  }

  get initial(): string {
    return this.def.initial;
  }

  isFinal(state: string): boolean {
    return (this.def.finalStates ?? []).includes(state);
  }

  transitionsFrom(state: string): LifecycleTransition[] {
    return this.def.transitions.filter((t) => t.from === state);
  }

  actionsFrom(state: string): string[] {
    return this.transitionsFrom(state).map((t) => t.action);
  }

  find(state: string, action: string): LifecycleTransition | undefined {
    return this.def.transitions.find((t) => t.from === state && t.action === action);
  }
}
