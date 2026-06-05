import type { EntityDef } from "../types";

/**
 * Automation platform persistence (Phase: DB-backed automation).
 *
 * Five system entities back the Automation console so rules, run logs, the
 * processing queue, assignment rules and settings live in the database (MSSQL or
 * in-memory) rather than process memory — surviving restarts and manageable via
 * the DB. Complex sub-structures (trigger / conditions / actions / steps …) are
 * stored as JSON in `text` (NVARCHAR(MAX)) columns. All are `system: true` so
 * they stay off the auto-nav; access is admin-gated at the API layer and writes
 * go through the system context.
 *
 * Note: the rule's user-facing version number is stored as `revision` to avoid
 * clashing with the platform's `version` optimistic-concurrency system column.
 */

export const automationRuleEntity: EntityDef = {
  name: "automationRule",
  label: "Automation",
  pluralLabel: "Automations",
  icon: "recurring",
  group: "admin",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, filterable: true, max: 160 },
    { name: "description", label: "Description", type: "text" },
    {
      name: "status",
      label: "Status",
      type: "enum",
      filterable: true,
      defaultValue: "draft",
      options: [
        { value: "active", label: "Active", tone: "success" },
        { value: "paused", label: "Paused", tone: "warning" },
        { value: "draft", label: "Draft", tone: "neutral" },
      ],
    },
    { name: "trigger", label: "Trigger", type: "text" },
    { name: "conditions", label: "Conditions", type: "text" },
    { name: "actions", label: "Actions", type: "text" },
    { name: "revision", label: "Revision", type: "number", defaultValue: 1 },
    { name: "versions", label: "Versions", type: "text" },
    { name: "stats", label: "Stats", type: "text" },
    { name: "tags", label: "Tags", type: "text" },
    { name: "requiresApproval", label: "Requires approval", type: "boolean", defaultValue: false },
    { name: "approvedBy", label: "Approved by", type: "string", max: 80 },
  ],
};

export const automationRunEntity: EntityDef = {
  name: "automationRun",
  label: "Automation Run",
  pluralLabel: "Automation Runs",
  icon: "activity",
  group: "admin",
  titleField: "ruleName",
  system: true,
  fields: [
    { name: "ruleId", label: "Rule", type: "string", filterable: true, max: 80 },
    { name: "ruleName", label: "Rule name", type: "string", max: 160 },
    {
      name: "status",
      label: "Status",
      type: "enum",
      filterable: true,
      options: [
        { value: "success", label: "Success", tone: "success" },
        { value: "failed", label: "Failed", tone: "danger" },
        { value: "skipped", label: "Skipped", tone: "neutral" },
        { value: "running", label: "Running", tone: "info" },
        { value: "queued", label: "Queued", tone: "warning" },
      ],
    },
    { name: "triggerSource", label: "Trigger", type: "string", max: 160 },
    { name: "input", label: "Input", type: "text" },
    { name: "output", label: "Output", type: "text" },
    { name: "steps", label: "Steps", type: "text" },
    { name: "startedAt", label: "Started at", type: "datetime" },
    { name: "finishedAt", label: "Finished at", type: "datetime" },
    { name: "durationMs", label: "Duration (ms)", type: "number" },
    { name: "error", label: "Error", type: "text" },
    { name: "test", label: "Test run", type: "boolean", filterable: true, defaultValue: false },
  ],
};

export const automationQueueEntity: EntityDef = {
  name: "automationQueueItem",
  label: "Automation Queue Item",
  pluralLabel: "Automation Queue",
  icon: "recurring",
  group: "admin",
  titleField: "ruleName",
  system: true,
  fields: [
    { name: "ruleId", label: "Rule", type: "string", filterable: true, max: 80 },
    { name: "ruleName", label: "Rule name", type: "string", max: 160 },
    {
      name: "state",
      label: "State",
      type: "enum",
      filterable: true,
      options: [
        { value: "pending", label: "Pending", tone: "info" },
        { value: "retry", label: "Retry", tone: "warning" },
        { value: "dead", label: "Dead-letter", tone: "danger" },
      ],
    },
    { name: "attempts", label: "Attempts", type: "number", defaultValue: 0 },
    { name: "maxAttempts", label: "Max attempts", type: "number", defaultValue: 3 },
    { name: "nextAttemptAt", label: "Next attempt at", type: "datetime" },
    { name: "enqueuedAt", label: "Enqueued at", type: "datetime" },
    { name: "lastError", label: "Last error", type: "text" },
    { name: "input", label: "Input", type: "text" },
  ],
};

export const assignmentRuleEntity: EntityDef = {
  name: "assignmentRule",
  label: "Assignment Rule",
  pluralLabel: "Assignment Rules",
  icon: "users",
  group: "admin",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, max: 160 },
    { name: "targetEntity", label: "Entity", type: "string", filterable: true, max: 80 },
    {
      name: "strategy",
      label: "Strategy",
      type: "enum",
      options: [
        { value: "round_robin", label: "Round-robin" },
        { value: "territory", label: "Territory" },
        { value: "load_based", label: "Load-based" },
        { value: "manual", label: "Manual" },
      ],
    },
    { name: "pool", label: "Owner pool", type: "text" },
    { name: "territoryMap", label: "Territory map", type: "text" },
    { name: "enabled", label: "Enabled", type: "boolean", filterable: true, defaultValue: true },
    { name: "cursor", label: "Cursor", type: "number", defaultValue: 0 },
  ],
};

export const automationSettingEntity: EntityDef = {
  name: "automationSetting",
  label: "Automation Setting",
  pluralLabel: "Automation Settings",
  icon: "settings",
  group: "admin",
  titleField: "key",
  system: true,
  fields: [
    { name: "key", label: "Key", type: "string", required: true, filterable: true, max: 80 },
    { name: "value", label: "Value", type: "text" },
  ],
};

/**
 * Integration hub connections (Email / SMS / WhatsApp / Slack / ERP / REST).
 * One row per provider; the provider-specific variables live as JSON in `config`
 * so each hub can be configured from the Automation → Integrations screen and the
 * connection details are stored in the database (the Email row supersedes the
 * SMTP/IMAP env vars and is used by the live mail transport).
 */
export const automationIntegrationEntity: EntityDef = {
  name: "automationIntegration",
  label: "Integration",
  pluralLabel: "Integrations",
  icon: "network",
  group: "admin",
  titleField: "provider",
  system: true,
  fields: [
    { name: "provider", label: "Provider", type: "string", required: true, filterable: true, max: 40 },
    { name: "enabled", label: "Enabled", type: "boolean", filterable: true, defaultValue: false },
    { name: "config", label: "Config", type: "text" },
  ],
};

/**
 * System / environment configuration (key/value). Holds the runtime-editable
 * settings previously sourced only from `.env` (server, security, storage,
 * bootstrap) so they can be managed from the app and stored in the database.
 * Bootstrap-only values (DB connection, secrets) are surfaced read-only.
 */
export const systemSettingEntity: EntityDef = {
  name: "systemSetting",
  label: "System Setting",
  pluralLabel: "System Settings",
  icon: "settings",
  group: "admin",
  titleField: "key",
  system: true,
  fields: [
    { name: "key", label: "Key", type: "string", required: true, filterable: true, max: 80 },
    { name: "value", label: "Value", type: "text" },
  ],
};
