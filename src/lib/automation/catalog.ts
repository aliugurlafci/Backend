/**
 * Automation builder catalog.
 *
 * A compact, UI-friendly projection of the metadata (entities, fields, lifecycle
 * actions) plus the fixed vocabularies (trigger events, operators, action types)
 * the visual builder needs to render its pickers — so the frontend never has to
 * duplicate metadata logic.
 */
import { metadata } from "@/lib/metadata";

export interface CatalogField {
  name: string;
  label: string;
  type: string;
  options?: { value: string; label: string }[];
}
export interface CatalogEntity {
  name: string;
  label: string;
  pluralLabel: string;
  icon?: string;
  fields: CatalogField[];
  /** Lifecycle action names (for the "update stage" action) + state field. */
  lifecycleField?: string;
  lifecycleStates?: string[];
  lifecycleActions?: { action: string; to: string }[];
}

export interface AutomationCatalog {
  entities: CatalogEntity[];
  triggerKinds: { value: string; label: string; description: string }[];
  triggerEvents: { value: string; label: string }[];
  operators: { value: string; label: string; unary?: boolean }[];
  actionTypes: { value: string; label: string; group: string; description: string }[];
  assignmentStrategies: { value: string; label: string; description: string }[];
}

export function buildCatalog(): AutomationCatalog {
  const entities: CatalogEntity[] = metadata
    .listEntities()
    .filter((e) => !e.system && !e.parent)
    .map((e) => ({
      name: e.name,
      label: e.label,
      pluralLabel: e.pluralLabel,
      icon: e.icon,
      fields: e.fields
        .filter((f) => !f.pii || f.type === "email")
        .map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          options: f.options?.map((o) => ({ value: o.value, label: o.label })),
        })),
      lifecycleField: e.lifecycle?.field,
      lifecycleStates: e.lifecycle?.states,
      lifecycleActions: e.lifecycle?.transitions.map((t) => ({ action: t.action, to: t.to })),
    }));

  return {
    entities,
    triggerKinds: [
      { value: "event", label: "Record event", description: "When a record is created, updated, or changes stage" },
      { value: "schedule", label: "Schedule", description: "On a recurring time interval" },
      { value: "inactivity", label: "Inactivity", description: "After a period of no activity on a record" },
      { value: "webhook", label: "Webhook / API", description: "When an external system calls in" },
    ],
    triggerEvents: [
      { value: "created", label: "Created" },
      { value: "updated", label: "Updated" },
      { value: "stage_changed", label: "Stage changed" },
      { value: "won", label: "Won" },
      { value: "lost", label: "Lost" },
      { value: "converted", label: "Converted" },
      { value: "deleted", label: "Deleted" },
      { value: "any", label: "Any change" },
    ],
    operators: [
      { value: "eq", label: "equals" },
      { value: "ne", label: "not equals" },
      { value: "gt", label: "greater than" },
      { value: "gte", label: "≥" },
      { value: "lt", label: "less than" },
      { value: "lte", label: "≤" },
      { value: "contains", label: "contains" },
      { value: "not_contains", label: "does not contain" },
      { value: "in", label: "in list" },
      { value: "is_empty", label: "is empty", unary: true },
      { value: "is_not_empty", label: "is not empty", unary: true },
      { value: "changed", label: "changed", unary: true },
    ],
    actionTypes: [
      { value: "send_email", label: "Send email", group: "Messaging", description: "Email a contact or customer" },
      { value: "send_sms", label: "Send SMS", group: "Messaging", description: "Send a text message" },
      { value: "send_whatsapp", label: "Send WhatsApp", group: "Messaging", description: "Send a WhatsApp message" },
      { value: "notify", label: "Notify team", group: "Messaging", description: "Post an in-app notification" },
      { value: "create_task", label: "Create task", group: "Records", description: "Create a follow-up task" },
      { value: "create_reminder", label: "Create reminder", group: "Records", description: "Schedule a reminder" },
      { value: "assign_owner", label: "Assign owner", group: "Records", description: "Route the record to an owner" },
      { value: "update_stage", label: "Update stage", group: "Records", description: "Advance the lifecycle stage" },
      { value: "update_record", label: "Update record", group: "Records", description: "Set a field value" },
      { value: "create_record", label: "Create record", group: "Records", description: "Create a related record" },
      { value: "webhook", label: "Call webhook", group: "Integrations", description: "POST to an external URL" },
      { value: "ai_score", label: "AI score", group: "AI", description: "Compute a predictive score" },
      { value: "delay", label: "Delay", group: "Flow", description: "Wait before continuing" },
      { value: "branch", label: "If / Else", group: "Flow", description: "Conditional branching" },
      { value: "parallel", label: "Parallel", group: "Flow", description: "Run lanes simultaneously" },
    ],
    assignmentStrategies: [
      { value: "round_robin", label: "Round-robin", description: "Rotate evenly through the pool" },
      { value: "territory", label: "Territory-based", description: "Map by territory/region" },
      { value: "load_based", label: "Load-based", description: "Balance by current workload" },
      { value: "manual", label: "Manual override", description: "Always the first in the pool" },
    ],
  };
}
