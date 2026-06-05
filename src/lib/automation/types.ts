/**
 * Automation platform — shared types.
 *
 * A user-defined automation is `Trigger → Condition → Action(s)`, persisted in a
 * tenant-scoped store, evaluated against the domain event bus, executed by the
 * automation engine, and observed through run logs, a processing queue and
 * dashboard stats. Mirrors the spec on the Automation screen.
 */

export type AutomationStatus = "active" | "paused" | "draft";

// ---- triggers ---------------------------------------------------------------

export type TriggerKind = "event" | "schedule" | "inactivity" | "webhook";

/** Event sub-types we normalise from the domain bus (`${entity}.${event}`). */
export type TriggerEvent =
  | "created"
  | "updated"
  | "deleted"
  | "stage_changed"
  | "won"
  | "lost"
  | "converted"
  | "any";

export interface AutomationTrigger {
  kind: TriggerKind;
  /** Target entity (event / inactivity triggers). */
  entity?: string;
  /** Normalised event for `kind: "event"`. */
  event?: TriggerEvent;
  /** Human label for `kind: "schedule"` (daily / hourly / cron string). */
  schedule?: string;
  /** Days of no activity before firing, for `kind: "inactivity"`. */
  inactivityDays?: number;
  /** External event name for `kind: "webhook"`. */
  webhookEvent?: string;
}

// ---- conditions (nested AND/OR) --------------------------------------------

export type ConditionOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "is_empty"
  | "is_not_empty"
  | "changed";

export interface ConditionLeaf {
  type: "condition";
  field: string;
  op: ConditionOp;
  value?: string | number | boolean | null;
}

export interface ConditionGroup {
  type: "group";
  logic: "AND" | "OR";
  children: Array<ConditionLeaf | ConditionGroup>;
}

// ---- actions ----------------------------------------------------------------

export type ActionType =
  | "send_email"
  | "send_sms"
  | "send_whatsapp"
  | "notify"
  | "create_task"
  | "assign_owner"
  | "update_stage"
  | "update_record"
  | "create_record"
  | "create_reminder"
  | "webhook"
  | "delay"
  | "branch"
  | "parallel"
  | "ai_score";

/**
 * A single action node. A flat config bag keeps the builder simple while still
 * supporting nested control flow (branch / parallel) for if-else and fan-out.
 */
export interface AutomationAction {
  id: string;
  type: ActionType;
  /** message channels (send_email / send_sms / send_whatsapp / notify). */
  to?: string;
  subject?: string;
  body?: string;
  /** create_task. */
  taskSubject?: string;
  /** assign_owner — explicit user id, or empty to use the assignment rule. */
  assignTo?: string;
  /** create_record / update_record. */
  entity?: string;
  field?: string;
  value?: string;
  /** update_stage — lifecycle action name to invoke. */
  stage?: string;
  /** webhook. */
  url?: string;
  /** delay — minutes to wait before continuing. */
  delayMinutes?: number;
  /** create_reminder — days from now. */
  reminderInDays?: number;
  /** ai_score — model label + the field the score is written to. */
  model?: string;
  /** branch (if/else). */
  condition?: ConditionGroup;
  thenActions?: AutomationAction[];
  elseActions?: AutomationAction[];
  /** parallel — independent lanes run together. */
  lanes?: AutomationAction[][];
}

// ---- rule + versions --------------------------------------------------------

export interface AutomationVersionSnapshot {
  version: number;
  at: string;
  by: string;
  note?: string;
  trigger: AutomationTrigger;
  conditions: ConditionGroup;
  actions: AutomationAction[];
}

export interface AutomationStats {
  runs: number;
  success: number;
  failure: number;
  skipped: number;
  /** Rolling average execution time (ms). */
  avgMs: number;
  lastRunAt: string | null;
  /** Records advanced/created downstream — a proxy for conversion impact. */
  impact: number;
}

export interface AutomationRule {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  conditions: ConditionGroup;
  actions: AutomationAction[];
  version: number;
  versions: AutomationVersionSnapshot[];
  stats: AutomationStats;
  tags: string[];
  /** Governance — activation requires approval, then who approved it. */
  requiresApproval: boolean;
  approvedBy: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ---- runs (execution logs) --------------------------------------------------

export type RunStatus = "success" | "failed" | "skipped" | "running" | "queued";
export type StepStatus = "ok" | "failed" | "skipped";

export interface RunStep {
  name: string;
  type: ActionType | "condition" | "trigger";
  status: StepStatus;
  ms: number;
  /** Human note about what happened. */
  output?: string;
  error?: string;
}

export interface AutomationRun {
  id: string;
  tenantId: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  status: RunStatus;
  /** Why the run started — event type or "manual" / "schedule". */
  trigger: string;
  /** What the rule saw — a snapshot of the triggering record / payload. */
  input: Record<string, unknown>;
  /** What the rule produced — created ids, messages sent, etc. */
  output: Record<string, unknown>;
  steps: RunStep[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
  /** Whether this run was a manual test (not counted toward live stats). */
  test: boolean;
}

// ---- processing queue -------------------------------------------------------

export type QueueState = "pending" | "retry" | "dead";

export interface QueueItem {
  id: string;
  tenantId: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  state: QueueState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  enqueuedAt: string;
  lastError?: string;
  input: Record<string, unknown>;
}

// ---- assignment rules -------------------------------------------------------

export type AssignmentStrategy = "round_robin" | "territory" | "load_based" | "manual";

export interface AssignmentRule {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  entity: string;
  strategy: AssignmentStrategy;
  /** Candidate owner user ids. */
  pool: string[];
  /** territory → owner map (territory strategy). */
  territoryMap?: Record<string, string>;
  enabled: boolean;
  /** round-robin cursor (server state). */
  cursor: number;
}

// ---- settings / governance --------------------------------------------------

export interface AutomationSettings {
  tenantId: string;
  orgId: string;
  /** Notifications. */
  realtimeAlerts: boolean;
  failureAlerts: boolean;
  slaAlerts: boolean;
  slaMinutes: number;
  /** Time management. */
  businessHoursOnly: boolean;
  businessStart: string; // "09:00"
  businessEnd: string; // "18:00"
  timezone: string;
  /** Queue. */
  maxRetries: number;
  rateLimitPerMin: number;
  /** AI-powered automation toggles. */
  aiLeadScoring: boolean;
  aiNextBestAction: boolean;
  aiSmartAssignment: boolean;
  aiPredictive: boolean;
}
