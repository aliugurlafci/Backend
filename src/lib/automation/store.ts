/**
 * Automation store — database-backed, tenant-scoped.
 *
 * Persists rules, run logs, the processing queue, assignment rules and settings
 * through the platform query engine (MSSQL or in-memory repository), so all
 * automation state is durable and managed via the database. Complex sub-objects
 * (trigger / conditions / actions / steps / pool …) are stored as JSON in `text`
 * columns and (de)serialised here. All writes use the system context, which
 * bypasses permission checks; access is admin-gated at the API layer.
 */
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { retryOnConflict } from "@/lib/data/optimistic";
import { systemClock } from "@/lib/core/clock";
import { DEMO_ORG, DEMO_TENANT, DEMO_USERS } from "@/lib/context/dev";
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { Filter } from "@/lib/data/query";
import { NotFoundError } from "@/lib/enforcement/errors";
import type {
  AssignmentRule,
  AutomationAction,
  AutomationRule,
  AutomationRun,
  AutomationSettings,
  AutomationStats,
  AutomationStatus,
  AutomationTrigger,
  AutomationVersionSnapshot,
  ConditionGroup,
  QueueItem,
  QueueState,
} from "./types";
import {
  INTEGRATION_PROVIDERS,
  emailEnabledByDefault,
  integrationDefaults,
  resolveEmailConfig,
  type IntegrationConfig,
  type ResolvedEmailConfig,
} from "./integrations";
import { SYSTEM_SETTINGS, editableSystemKeys, maskSecret } from "./system-config";

const RULE = "automationRule";
const RUN = "automationRun";
const QUEUE = "automationQueueItem";
const ASSIGN = "assignmentRule";
const SETTING = "automationSetting";
const INTEGRATION = "automationIntegration";
const SYSSET = "systemSetting";

export interface IntegrationState {
  provider: string;
  enabled: boolean;
  config: IntegrationConfig;
}

export interface SystemSettingValue {
  key: string;
  label: string;
  group: string;
  type: string;
  options?: { value: string; label: string }[];
  secret: boolean;
  readonly: boolean;
  restart: boolean;
  help?: string;
  value: string;
  fromDb: boolean;
}

function ctxOf(tenantId: string, orgId: string): RequestContext {
  return systemContext(tenantId, orgId);
}

/** Tolerant JSON parse with a typed fallback (rows may predate a field). */
function pj<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function emptyStats(): AutomationStats {
  return { runs: 0, success: 0, failure: 0, skipped: 0, avgMs: 0, lastRunAt: null, impact: 0 };
}

function emptyGroup(): ConditionGroup {
  return { type: "group", logic: "AND", children: [] };
}

function defaultSettings(): Omit<AutomationSettings, "tenantId" | "orgId"> {
  return {
    realtimeAlerts: true,
    failureAlerts: true,
    slaAlerts: true,
    slaMinutes: 60,
    businessHoursOnly: false,
    businessStart: "09:00",
    businessEnd: "18:00",
    timezone: "UTC",
    maxRetries: 3,
    rateLimitPerMin: 120,
    maxConcurrent: 3,
    aiLeadScoring: true,
    aiNextBestAction: true,
    aiSmartAssignment: false,
    aiPredictive: false,
  };
}

// ---- row ⇄ domain mappers ---------------------------------------------------

function toRule(r: EntityRecord): AutomationRule {
  return {
    id: r.id,
    tenantId: r.tenantId,
    orgId: r.orgId,
    name: String(r.name ?? ""),
    description: r.description ? String(r.description) : "",
    status: (String(r.status ?? "draft") as AutomationStatus),
    trigger: pj<AutomationTrigger>(r.trigger, { kind: "event" }),
    conditions: pj<ConditionGroup>(r.conditions, emptyGroup()),
    actions: pj<AutomationAction[]>(r.actions, []),
    version: Number(r.revision ?? 1),
    versions: pj<AutomationVersionSnapshot[]>(r.versions, []),
    stats: pj<AutomationStats>(r.stats, emptyStats()),
    tags: pj<string[]>(r.tags, []),
    requiresApproval: Boolean(r.requiresApproval),
    approvedBy: r.approvedBy ? String(r.approvedBy) : null,
    createdAt: String(r.createdAt),
    createdBy: String(r.createdBy),
    updatedAt: String(r.updatedAt),
    updatedBy: String(r.updatedBy),
  };
}

function toRun(r: EntityRecord): AutomationRun {
  return {
    id: r.id,
    tenantId: r.tenantId,
    orgId: r.orgId,
    ruleId: String(r.ruleId ?? ""),
    ruleName: String(r.ruleName ?? ""),
    status: (String(r.status ?? "success") as AutomationRun["status"]),
    trigger: String(r.triggerSource ?? ""),
    input: pj<Record<string, unknown>>(r.input, {}),
    output: pj<Record<string, unknown>>(r.output, {}),
    steps: pj<AutomationRun["steps"]>(r.steps, []),
    startedAt: String(r.startedAt ?? r.createdAt),
    finishedAt: String(r.finishedAt ?? r.createdAt),
    durationMs: Number(r.durationMs ?? 0),
    error: r.error ? String(r.error) : undefined,
    test: Boolean(r.test),
  };
}

function toQueue(r: EntityRecord): QueueItem {
  return {
    id: r.id,
    tenantId: r.tenantId,
    orgId: r.orgId,
    ruleId: String(r.ruleId ?? ""),
    ruleName: String(r.ruleName ?? ""),
    state: (String(r.state ?? "pending") as QueueState),
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.maxAttempts ?? 3),
    nextAttemptAt: r.nextAttemptAt ? String(r.nextAttemptAt) : null,
    enqueuedAt: String(r.enqueuedAt ?? r.createdAt),
    lastError: r.lastError ? String(r.lastError) : undefined,
    input: pj<Record<string, unknown>>(r.input, {}),
  };
}

function toAssignment(r: EntityRecord): AssignmentRule {
  return {
    id: r.id,
    tenantId: r.tenantId,
    orgId: r.orgId,
    name: String(r.name ?? ""),
    entity: String(r.targetEntity ?? ""),
    strategy: (String(r.strategy ?? "round_robin") as AssignmentRule["strategy"]),
    pool: pj<string[]>(r.pool, []),
    territoryMap: pj<Record<string, string> | undefined>(r.territoryMap, undefined),
    enabled: Boolean(r.enabled),
    cursor: Number(r.cursor ?? 0),
  };
}

export class AutomationStore {
  // ---- rules ---------------------------------------------------------------

  async listRules(tenantId: string, orgId: string): Promise<AutomationRule[]> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), RULE, { pageSize: 500 });
    return page.items
      .map(toRule)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getRule(tenantId: string, orgId: string, id: string): Promise<AutomationRule | undefined> {
    const qe = await getQueryEngine();
    try {
      return toRule(await qe.get(ctxOf(tenantId, orgId), RULE, id));
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  async createRule(input: {
    tenantId: string;
    orgId: string;
    name: string;
    description?: string;
    status?: AutomationStatus;
    trigger: AutomationTrigger;
    conditions: ConditionGroup;
    actions: AutomationAction[];
    tags?: string[];
    requiresApproval?: boolean;
    by: string;
  }): Promise<AutomationRule> {
    const qe = await getQueryEngine();
    const now = systemClock.isoNow();
    const snapshot: AutomationVersionSnapshot = {
      version: 1,
      at: now,
      by: input.by,
      note: "created",
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
    };
    const values: Record<string, FieldValue> = {
      name: input.name,
      description: input.description ?? "",
      status: input.status ?? "draft",
      trigger: JSON.stringify(input.trigger),
      conditions: JSON.stringify(input.conditions),
      actions: JSON.stringify(input.actions),
      revision: 1,
      versions: JSON.stringify([snapshot]),
      stats: JSON.stringify(emptyStats()),
      tags: JSON.stringify(input.tags ?? []),
      requiresApproval: input.requiresApproval ?? false,
      approvedBy: null,
    };
    return toRule(await qe.create(ctxOf(input.tenantId, input.orgId), RULE, values));
  }

  async updateRule(
    tenantId: string,
    orgId: string,
    id: string,
    patch: Partial<Pick<AutomationRule, "name" | "description" | "trigger" | "conditions" | "actions" | "tags" | "requiresApproval">>,
    by: string,
  ): Promise<AutomationRule | undefined> {
    const current = await this.getRule(tenantId, orgId, id);
    if (!current) return undefined;
    const qe = await getQueryEngine();

    const flowChanged = patch.trigger !== undefined || patch.conditions !== undefined || patch.actions !== undefined;
    const next: Record<string, FieldValue> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.tags !== undefined) next.tags = JSON.stringify(patch.tags);
    if (patch.requiresApproval !== undefined) next.requiresApproval = patch.requiresApproval;

    const trigger = patch.trigger ?? current.trigger;
    const conditions = patch.conditions ?? current.conditions;
    const actions = patch.actions ?? current.actions;
    if (patch.trigger !== undefined) next.trigger = JSON.stringify(trigger);
    if (patch.conditions !== undefined) next.conditions = JSON.stringify(conditions);
    if (patch.actions !== undefined) next.actions = JSON.stringify(actions);

    if (flowChanged) {
      const revision = current.version + 1;
      const snapshot: AutomationVersionSnapshot = {
        version: revision,
        at: systemClock.isoNow(),
        by,
        note: "edited",
        trigger,
        conditions,
        actions,
      };
      next.revision = revision;
      next.versions = JSON.stringify([snapshot, ...current.versions].slice(0, 25));
    }
    return toRule(await qe.update(ctxOf(tenantId, orgId), RULE, id, next));
  }

  async setStatus(
    tenantId: string,
    orgId: string,
    id: string,
    status: AutomationStatus,
    by: string,
  ): Promise<AutomationRule | undefined> {
    const current = await this.getRule(tenantId, orgId, id);
    if (!current) return undefined;
    const qe = await getQueryEngine();
    const patch: Record<string, FieldValue> = { status };
    if (status === "active" && current.requiresApproval && !current.approvedBy) patch.approvedBy = by;
    return toRule(await qe.update(ctxOf(tenantId, orgId), RULE, id, patch));
  }

  async rollback(tenantId: string, orgId: string, id: string, version: number, by: string): Promise<AutomationRule | undefined> {
    const current = await this.getRule(tenantId, orgId, id);
    if (!current) return undefined;
    const snap = current.versions.find((v) => v.version === version);
    if (!snap) return undefined;
    const qe = await getQueryEngine();
    const revision = current.version + 1;
    const newSnap: AutomationVersionSnapshot = {
      version: revision,
      at: systemClock.isoNow(),
      by,
      note: `rolled back to v${version}`,
      trigger: snap.trigger,
      conditions: snap.conditions,
      actions: snap.actions,
    };
    return toRule(
      await qe.update(ctxOf(tenantId, orgId), RULE, id, {
        trigger: JSON.stringify(snap.trigger),
        conditions: JSON.stringify(snap.conditions),
        actions: JSON.stringify(snap.actions),
        revision,
        versions: JSON.stringify([newSnap, ...current.versions].slice(0, 25)),
      }),
    );
  }

  async removeRule(tenantId: string, orgId: string, id: string): Promise<boolean> {
    const qe = await getQueryEngine();
    try {
      await qe.remove(ctxOf(tenantId, orgId), RULE, id);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  // ---- runs ----------------------------------------------------------------

  async recordRun(run: AutomationRun): Promise<AutomationRun> {
    const qe = await getQueryEngine();
    const ctx = ctxOf(run.tenantId, run.orgId);
    const created = await qe.create(ctx, RUN, {
      ruleId: run.ruleId,
      ruleName: run.ruleName,
      status: run.status,
      triggerSource: run.trigger,
      input: JSON.stringify(run.input ?? {}),
      output: JSON.stringify(run.output ?? {}),
      steps: JSON.stringify(run.steps ?? []),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      error: run.error ?? null,
      test: run.test,
    });

    // Roll non-test runs into the rule's persisted stats.
    if (!run.test) {
      const rule = await this.getRule(run.tenantId, run.orgId, run.ruleId);
      if (rule) {
        const s = rule.stats;
        s.runs += 1;
        if (run.status === "success") s.success += 1;
        else if (run.status === "failed") s.failure += 1;
        else if (run.status === "skipped") s.skipped += 1;
        s.avgMs = Math.round((s.avgMs * (s.runs - 1) + run.durationMs) / s.runs);
        s.lastRunAt = run.finishedAt;
        s.impact += Number((run.output.created as number) ?? 0) + Number((run.output.advanced as number) ?? 0);
        await qe.update(ctx, RULE, run.ruleId, { stats: JSON.stringify(s) });
      }
    }
    return toRun(created);
  }

  async listRuns(
    tenantId: string,
    orgId: string,
    opts: { ruleId?: string; status?: string; limit?: number } = {},
  ): Promise<AutomationRun[]> {
    const qe = await getQueryEngine();
    const filters: Filter[] = [];
    if (opts.ruleId) filters.push({ field: "ruleId", op: "eq", value: opts.ruleId });
    if (opts.status) filters.push({ field: "status", op: "eq", value: opts.status });
    const page = await qe.list(ctxOf(tenantId, orgId), RUN, { pageSize: 500, filters });
    return page.items
      .map(toRun)
      .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))
      .slice(0, opts.limit ?? 100);
  }

  async getRun(tenantId: string, orgId: string, id: string): Promise<AutomationRun | undefined> {
    const qe = await getQueryEngine();
    try {
      return toRun(await qe.get(ctxOf(tenantId, orgId), RUN, id));
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  // ---- queue ---------------------------------------------------------------

  async enqueue(item: Omit<QueueItem, "id">): Promise<QueueItem> {
    const qe = await getQueryEngine();
    const created = await qe.create(ctxOf(item.tenantId, item.orgId), QUEUE, {
      ruleId: item.ruleId,
      ruleName: item.ruleName,
      state: item.state,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      nextAttemptAt: item.nextAttemptAt,
      enqueuedAt: item.enqueuedAt,
      lastError: item.lastError ?? null,
      input: JSON.stringify(item.input ?? {}),
    });
    return toQueue(created);
  }

  async listQueue(tenantId: string, orgId: string): Promise<QueueItem[]> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), QUEUE, { pageSize: 300 });
    return page.items.map(toQueue).sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? 1 : -1));
  }

  async getQueueItem(tenantId: string, orgId: string, id: string): Promise<QueueItem | undefined> {
    const qe = await getQueryEngine();
    try {
      return toQueue(await qe.get(ctxOf(tenantId, orgId), QUEUE, id));
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  async updateQueueItem(
    tenantId: string,
    orgId: string,
    id: string,
    patch: Partial<Pick<QueueItem, "state" | "attempts" | "lastError" | "nextAttemptAt">>,
  ): Promise<void> {
    const qe = await getQueryEngine();
    await qe.update(ctxOf(tenantId, orgId), QUEUE, id, patch as Record<string, FieldValue>);
  }

  async removeQueueItem(tenantId: string, orgId: string, id: string): Promise<boolean> {
    const qe = await getQueryEngine();
    try {
      await qe.remove(ctxOf(tenantId, orgId), QUEUE, id);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  // ---- assignment ----------------------------------------------------------

  async listAssignment(tenantId: string, orgId: string): Promise<AssignmentRule[]> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), ASSIGN, { pageSize: 200 });
    return page.items.map(toAssignment).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async upsertAssignment(input: {
    tenantId: string;
    orgId: string;
    id?: string;
    name: string;
    entity: string;
    strategy: AssignmentRule["strategy"];
    pool: string[];
    territoryMap?: Record<string, string>;
    enabled: boolean;
  }): Promise<AssignmentRule> {
    const qe = await getQueryEngine();
    const ctx = ctxOf(input.tenantId, input.orgId);
    const values: Record<string, FieldValue> = {
      name: input.name,
      targetEntity: input.entity,
      strategy: input.strategy,
      pool: JSON.stringify(input.pool),
      territoryMap: input.territoryMap ? JSON.stringify(input.territoryMap) : null,
      enabled: input.enabled,
    };
    if (input.id) {
      const existing = await this.getAssignment(input.tenantId, input.orgId, input.id);
      if (existing) return toAssignment(await qe.update(ctx, ASSIGN, input.id, values));
    }
    return toAssignment(await qe.create(ctx, ASSIGN, { ...values, cursor: 0 }));
  }

  private async getAssignment(tenantId: string, orgId: string, id: string): Promise<AssignmentRule | undefined> {
    const qe = await getQueryEngine();
    try {
      return toAssignment(await qe.get(ctxOf(tenantId, orgId), ASSIGN, id));
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  async removeAssignment(tenantId: string, orgId: string, id: string): Promise<boolean> {
    const qe = await getQueryEngine();
    try {
      await qe.remove(ctxOf(tenantId, orgId), ASSIGN, id);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  /** Pick the next owner for an entity using the configured strategy (persists the cursor). */
  async nextAssignee(tenantId: string, orgId: string, entity: string): Promise<string | null> {
    const rules = await this.listAssignment(tenantId, orgId);
    const rule = rules.find((a) => a.enabled && a.entity === entity);
    if (!rule || rule.pool.length === 0) return null;
    if (rule.strategy === "round_robin" || rule.strategy === "load_based") {
      const qe = await getQueryEngine();
      const ctx = ctxOf(tenantId, orgId);
      // Version-guarded so concurrent assignments rotate fairly through the pool
      // instead of both reading the same cursor and assigning the same person.
      return retryOnConflict(async () => {
        const current = await qe.get(ctx, ASSIGN, rule.id);
        const idx = Number(current.cursor ?? 0) % rule.pool.length;
        await qe.update(ctx, ASSIGN, rule.id, { cursor: (idx + 1) % rule.pool.length }, { expectedVersion: current.version });
        return rule.pool[idx] ?? null;
      });
    }
    return rule.pool[0] ?? null;
  }

  // ---- settings ------------------------------------------------------------

  async getSettings(tenantId: string, orgId: string): Promise<AutomationSettings> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), SETTING, { pageSize: 200 });
    const stored: Record<string, string> = {};
    for (const row of page.items) stored[String(row.key)] = String(row.value ?? "");
    const d = defaultSettings();
    const bool = (k: string, def: boolean) => (k in stored ? stored[k] === "true" : def);
    const num = (k: string, def: number) => (k in stored ? Number(stored[k]) : def);
    const str = (k: string, def: string) => (k in stored ? stored[k] : def);
    return {
      tenantId,
      orgId,
      realtimeAlerts: bool("realtimeAlerts", d.realtimeAlerts),
      failureAlerts: bool("failureAlerts", d.failureAlerts),
      slaAlerts: bool("slaAlerts", d.slaAlerts),
      slaMinutes: num("slaMinutes", d.slaMinutes),
      businessHoursOnly: bool("businessHoursOnly", d.businessHoursOnly),
      businessStart: str("businessStart", d.businessStart),
      businessEnd: str("businessEnd", d.businessEnd),
      timezone: str("timezone", d.timezone),
      maxRetries: num("maxRetries", d.maxRetries),
      rateLimitPerMin: num("rateLimitPerMin", d.rateLimitPerMin),
      maxConcurrent: num("maxConcurrent", d.maxConcurrent),
      aiLeadScoring: bool("aiLeadScoring", d.aiLeadScoring),
      aiNextBestAction: bool("aiNextBestAction", d.aiNextBestAction),
      aiSmartAssignment: bool("aiSmartAssignment", d.aiSmartAssignment),
      aiPredictive: bool("aiPredictive", d.aiPredictive),
    };
  }

  async updateSettings(tenantId: string, orgId: string, patch: Record<string, unknown>): Promise<AutomationSettings> {
    const qe = await getQueryEngine();
    const ctx = ctxOf(tenantId, orgId);
    const page = await qe.list(ctx, SETTING, { pageSize: 200 });
    const byKey = new Map(page.items.map((r) => [String(r.key), r]));
    const allowed = new Set(Object.keys(defaultSettings()));
    for (const [key, raw] of Object.entries(patch)) {
      if (!allowed.has(key)) continue; // ignore tenantId/orgId and unknowns
      const value = raw === null || raw === undefined ? "" : String(raw);
      const found = byKey.get(key);
      if (found) await qe.update(ctx, SETTING, String(found.id), { value });
      else await qe.create(ctx, SETTING, { key, value });
    }
    return this.getSettings(tenantId, orgId);
  }

  // ---- integrations --------------------------------------------------------

  async getIntegration(tenantId: string, orgId: string, provider: string): Promise<IntegrationState> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), INTEGRATION, {
      pageSize: 1,
      filters: [{ field: "provider", op: "eq", value: provider }],
    });
    const row = page.items[0];
    const defaults = integrationDefaults(provider);
    if (!row) {
      return { provider, enabled: provider === "email" ? emailEnabledByDefault() : false, config: defaults };
    }
    return {
      provider,
      enabled: Boolean(row.enabled),
      config: { ...defaults, ...pj<IntegrationConfig>(row.config, {}) },
    };
  }

  async listIntegrations(tenantId: string, orgId: string): Promise<IntegrationState[]> {
    return Promise.all(INTEGRATION_PROVIDERS.map((p) => this.getIntegration(tenantId, orgId, p.key)));
  }

  async upsertIntegration(
    tenantId: string,
    orgId: string,
    provider: string,
    input: { enabled?: boolean; config?: IntegrationConfig },
  ): Promise<IntegrationState> {
    const qe = await getQueryEngine();
    const ctx = ctxOf(tenantId, orgId);
    const page = await qe.list(ctx, INTEGRATION, {
      pageSize: 1,
      filters: [{ field: "provider", op: "eq", value: provider }],
    });
    const row = page.items[0];
    const current = row ? pj<IntegrationConfig>(row.config, {}) : integrationDefaults(provider);
    const merged = { ...current, ...(input.config ?? {}) };
    const values: Record<string, FieldValue> = {
      provider,
      enabled: input.enabled ?? Boolean(row?.enabled),
      config: JSON.stringify(merged),
    };
    if (row) await qe.update(ctx, INTEGRATION, String(row.id), values);
    else await qe.create(ctx, INTEGRATION, values);
    return this.getIntegration(tenantId, orgId, provider);
  }

  /** Effective email connection used by the mail transport (DB → env fallback). */
  async resolveEmail(tenantId: string, orgId: string): Promise<ResolvedEmailConfig> {
    const state = await this.getIntegration(tenantId, orgId, "email");
    return resolveEmailConfig(state.config, state.enabled);
  }

  // ---- system settings -----------------------------------------------------

  async getSystemSettings(tenantId: string, orgId: string): Promise<SystemSettingValue[]> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), SYSSET, { pageSize: 200 });
    const stored = new Map(page.items.map((r) => [String(r.key), String(r.value ?? "")]));
    return SYSTEM_SETTINGS.map((def) => {
      const fromDb = stored.has(def.key);
      const raw = fromDb ? stored.get(def.key)! : def.envValue();
      return {
        key: def.key,
        label: def.label,
        group: def.group,
        type: def.type,
        options: def.options,
        secret: Boolean(def.secret),
        readonly: Boolean(def.readonly),
        restart: Boolean(def.restart),
        help: def.help,
        value: def.secret ? maskSecret(raw) : raw,
        fromDb,
      };
    });
  }

  async updateSystemSettings(tenantId: string, orgId: string, patch: Record<string, unknown>): Promise<SystemSettingValue[]> {
    const qe = await getQueryEngine();
    const ctx = ctxOf(tenantId, orgId);
    const page = await qe.list(ctx, SYSSET, { pageSize: 200 });
    const byKey = new Map(page.items.map((r) => [String(r.key), r]));
    const editable = editableSystemKeys();
    for (const [key, raw] of Object.entries(patch)) {
      if (!editable.has(key)) continue; // never write bootstrap/read-only keys
      const value = raw === null || raw === undefined ? "" : String(raw);
      const found = byKey.get(key);
      if (found) await qe.update(ctx, SYSSET, String(found.id), { value });
      else await qe.create(ctx, SYSSET, { key, value });
    }
    return this.getSystemSettings(tenantId, orgId);
  }

  /** Effective value of a system setting (DB override → env default). */
  async systemValue(tenantId: string, orgId: string, key: string): Promise<string | null> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctxOf(tenantId, orgId), SYSSET, {
      pageSize: 1,
      filters: [{ field: "key", op: "eq", value: key }],
    });
    if (page.items[0]) return String(page.items[0].value ?? "");
    const def = SYSTEM_SETTINGS.find((s) => s.key === key);
    return def ? def.envValue() : null;
  }

  // ---- seed ----------------------------------------------------------------

  /** Seed realistic demo content for the demo tenant the first time it's empty. */
  async seedDemo(tenantId = DEMO_TENANT, orgId = DEMO_ORG): Promise<void> {
    if (tenantId !== DEMO_TENANT || orgId !== DEMO_ORG) return;
    const existing = await this.listRules(tenantId, orgId);
    if (existing.length > 0) return;

    const grp = (children: ConditionGroup["children"], logic: "AND" | "OR" = "AND"): ConditionGroup => ({
      type: "group",
      logic,
      children,
    });
    const aid = (n: number) => `seedact_${n}`;
    const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

    const welcome = await this.createRule({
      tenantId,
      orgId,
      name: "Welcome new accounts",
      description: "Email new accounts and create a first-touch task for the owner.",
      status: "active",
      trigger: { kind: "event", entity: "account", event: "created" },
      conditions: grp([]),
      actions: [
        { id: aid(1), type: "send_email", to: "{{record.email}}", subject: "Welcome to Aula", body: "Thanks for your interest — we'll be in touch shortly." },
        { id: aid(2), type: "create_task", taskSubject: "First-touch call with new account" },
        { id: aid(3), type: "ai_score", model: "account-propensity", field: "score" },
      ],
      tags: ["sales", "onboarding"],
      by: "system",
    });

    const bigDeal = await this.createRule({
      tenantId,
      orgId,
      name: "Escalate high-value deals",
      description: "When a deal over $50k changes stage, alert the team and assign round-robin.",
      status: "active",
      trigger: { kind: "event", entity: "deal", event: "stage_changed" },
      conditions: grp([{ type: "condition", field: "amount", op: "gte", value: 50000 }]),
      actions: [
        { id: aid(4), type: "notify", subject: "High-value deal moved", body: "A deal over $50k changed stage." },
        { id: aid(5), type: "assign_owner" },
        {
          id: aid(6),
          type: "branch",
          condition: grp([{ type: "condition", field: "stage", op: "eq", value: "won" }]),
          thenActions: [{ id: aid(7), type: "create_task", taskSubject: "Kick off onboarding for won deal" }],
          elseActions: [{ id: aid(8), type: "create_reminder", reminderInDays: 3 }],
        },
      ],
      tags: ["sales", "priority"],
      requiresApproval: true,
      by: "system",
    });
    await this.setStatus(tenantId, orgId, bigDeal.id, "active", "system");

    await this.createRule({
      tenantId,
      orgId,
      name: "Overdue invoice reminders",
      description: "Daily: nudge customers on overdue invoices and notify the accountant.",
      status: "paused",
      trigger: { kind: "schedule", schedule: "daily" },
      conditions: grp([{ type: "condition", field: "status", op: "eq", value: "overdue" }]),
      actions: [
        { id: aid(9), type: "send_email", to: "{{record.email}}", subject: "Invoice overdue", body: "Your invoice is past due." },
        { id: aid(10), type: "notify", subject: "Overdue invoices need attention", body: "Dunning run completed." },
      ],
      tags: ["finance"],
      by: "system",
    });

    await this.createRule({
      tenantId,
      orgId,
      name: "Re-engage stale opportunities",
      description: "After 14 days of inactivity on an open deal, create a follow-up reminder.",
      status: "draft",
      trigger: { kind: "inactivity", entity: "deal", inactivityDays: 14 },
      conditions: grp([
        { type: "condition", field: "stage", op: "ne", value: "won" },
        { type: "condition", field: "stage", op: "ne", value: "lost" },
      ]),
      actions: [{ id: aid(11), type: "create_reminder", reminderInDays: 1 }],
      tags: ["sales", "retention"],
      by: "system",
    });

    // A few historical runs so the dashboard + logs are populated (drive stats).
    await this.recordRun({
      id: "", tenantId, orgId, ruleId: welcome.id, ruleName: welcome.name, status: "success",
      trigger: "lead.created", input: { id: "ld_demo", name: "Dana Prospect", email: "dana@prospect.test" },
      output: { created: 1, emails: 1 },
      steps: [
        { name: "Trigger: lead.created", type: "trigger", status: "ok", ms: 0, output: "matched lead Dana Prospect" },
        { name: "Send email", type: "send_email", status: "ok", ms: 92, output: "Email → dana@prospect.test" },
        { name: "Create task", type: "create_task", status: "ok", ms: 71, output: "created task tsk_demo" },
        { name: "AI score", type: "ai_score", status: "ok", ms: 21, output: "lead-propensity: score=72" },
      ],
      startedAt: ago(33), finishedAt: ago(33), durationMs: 184, test: false,
    });
    await this.recordRun({
      id: "", tenantId, orgId, ruleId: bigDeal.id, ruleName: bigDeal.name, status: "success",
      trigger: "deal.stage_changed", input: { id: "dl_demo", name: "Globex Expansion", amount: 82000, stage: "negotiation" },
      output: { advanced: 1, notifications: 1 },
      steps: [
        { name: "Trigger: deal.stage_changed", type: "trigger", status: "ok", ms: 0 },
        { name: "Conditions (1)", type: "condition", status: "ok", ms: 1, output: "all matched" },
        { name: "Notify team", type: "notify", status: "ok", ms: 40 },
        { name: "Assign owner", type: "assign_owner", status: "ok", ms: 55, output: "assigned to Riley Rep" },
        { name: "If / Else", type: "branch", status: "ok", ms: 60, output: "else →" },
      ],
      startedAt: ago(120), finishedAt: ago(120), durationMs: 240, test: false,
    });
    await this.recordRun({
      id: "", tenantId, orgId, ruleId: welcome.id, ruleName: welcome.name, status: "failed",
      trigger: "lead.created", input: { id: "ld_demo2", email: "sam@prospect.test" },
      output: {}, error: "SMTP timeout contacting mail provider",
      steps: [
        { name: "Trigger: lead.created", type: "trigger", status: "ok", ms: 0 },
        { name: "Send email", type: "send_email", status: "failed", ms: 120, error: "SMTP timeout contacting mail provider" },
      ],
      startedAt: ago(20), finishedAt: ago(20), durationMs: 130, test: false,
    });

    // Processing-queue sample — DEAD-LETTER ONLY. We must NOT seed live
    // pending/retry items: processQueue() drains them with real side effects, so
    // a seeded `welcome` send_email item would actually email its fake recipient
    // (e.g. sam@prospect.test) on the next scheduler tick. `dead` items are never
    // processed, so this is display-only and safe. (Live items are also ephemeral
    // — they'd drain within one tick — so seeding them serves no purpose.)
    await this.enqueue({
      tenantId, orgId, ruleId: bigDeal.id, ruleName: bigDeal.name, state: "dead",
      attempts: 3, maxAttempts: 3, nextAttemptAt: null, enqueuedAt: ago(180),
      lastError: "Webhook endpoint returned 500 after 3 attempts", input: { id: "dl_demo3", amount: 64000 },
    });

    // Assignment rules.
    await this.upsertAssignment({
      tenantId, orgId, name: "Inbound account rotation", entity: "account", strategy: "round_robin",
      pool: [DEMO_USERS.manager.userId, DEMO_USERS.rep.userId], enabled: true,
    });
    await this.upsertAssignment({
      tenantId, orgId, name: "Deal desk (load-based)", entity: "deal", strategy: "load_based",
      pool: [DEMO_USERS.rep.userId, DEMO_USERS.manager.userId], enabled: true,
    });

    // Persist default settings so they're managed in the DB from the start.
    await this.updateSettings(tenantId, orgId, defaultSettings() as unknown as Record<string, unknown>);

    // Migrate the SMTP/IMAP env config into the DB-backed Email integration so
    // the connection is managed from the Integrations screen going forward.
    await this.upsertIntegration(tenantId, orgId, "email", {
      enabled: emailEnabledByDefault(),
      config: integrationDefaults("email"),
    });
  }
}

export const automationStore = new AutomationStore();
