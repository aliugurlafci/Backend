/**
 * Phase 6 — Permission engine contracts.
 *
 * Access is evaluated at four levels:
 *  - object  : may this role touch this entity for this action at all? (RBAC)
 *  - action  : named lifecycle actions (e.g. `deal:win`) gated by grants (RBAC)
 *  - record  : may this user act on *this* record? (ABAC, ownership-based)
 *  - field   : may this role read/write a specific field? (e.g. PII)
 *
 * Every evaluation returns a structured Decision carrying a human reason and a
 * machine code, so denials are explainable and auditable.
 */

export type DecisionCode =
  | "allowed"
  | "rbac_denied"
  | "abac_denied"
  | "field_denied";

export interface Decision {
  allowed: boolean;
  reason: string;
  code: DecisionCode;
}

export interface RoleDef {
  name: string;
  label: string;
  /** Permission grants, supporting `*`, `<entity>:*` and `<entity>:<verb>`. */
  grants: string[];
}

export interface AccessRequest {
  /** Full action string, e.g. `deal:update` or lifecycle `deal:win`. */
  action: string;
  entity: string;
  /** Owner of the target record for record-level ABAC (mutations only). */
  recordOwnerId?: string | null;
  /** Field name for field-level checks. */
  field?: string;
  /** Whether the field carries PII (drives field-level policy). */
  fieldPii?: boolean;
}
