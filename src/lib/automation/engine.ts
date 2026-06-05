/**
 * Automation engine.
 *
 * Subscribes to the domain event bus, matches active rules by trigger, evaluates
 * their (nested AND/OR) conditions and executes their actions — recording a run
 * with a step-by-step trace, rolling up stats, and pushing failures to the retry
 * / dead-letter queue. Side effects reuse the query engine directly (like the
 * built-in workflows) so automation-driven writes never re-emit domain events
 * (no trigger recursion).
 */
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { metadata } from "@/lib/metadata";
import { notifications } from "@/lib/integrations/notifications";
import { logger } from "@/lib/observability/logger";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { automationStore } from "./store";
import type {
  AutomationAction,
  AutomationRule,
  AutomationRun,
  ConditionGroup,
  ConditionLeaf,
  RunStep,
  RunStatus,
} from "./types";

type Rec = Record<string, unknown>;

// ---- condition evaluation ---------------------------------------------------

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : NaN;
}

export function evaluateLeaf(leaf: ConditionLeaf, record: Rec): boolean {
  const actual = record[leaf.field];
  const expected = leaf.value;
  switch (leaf.op) {
    case "eq":
      return String(actual ?? "") === String(expected ?? "");
    case "ne":
      return String(actual ?? "") !== String(expected ?? "");
    case "gt":
      return asNumber(actual) > asNumber(expected);
    case "gte":
      return asNumber(actual) >= asNumber(expected);
    case "lt":
      return asNumber(actual) < asNumber(expected);
    case "lte":
      return asNumber(actual) <= asNumber(expected);
    case "contains":
      return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "not_contains":
      return !String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "in":
      return String(expected ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes(String(actual ?? ""));
    case "is_empty":
      return actual === null || actual === undefined || String(actual) === "";
    case "is_not_empty":
      return !(actual === null || actual === undefined || String(actual) === "");
    case "changed":
      return true; // change tracking is approximated as "present" for updates
    default:
      return false;
  }
}

export function evaluateGroup(group: ConditionGroup, record: Rec): boolean {
  if (!group.children || group.children.length === 0) return true; // no conditions ⇒ always
  const results = group.children.map((child) =>
    child.type === "group" ? evaluateGroup(child, record) : evaluateLeaf(child, record),
  );
  return group.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

/** Count condition leaves so the run trace can show "N conditions evaluated". */
function countLeaves(group: ConditionGroup): number {
  return group.children.reduce((n, c) => n + (c.type === "group" ? countLeaves(c) : 1), 0);
}

// ---- templating -------------------------------------------------------------

function interpolate(template: string | undefined, record: Rec): string {
  if (!template) return "";
  return template.replace(/\{\{\s*(?:record\.)?([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = record[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

// ---- execution --------------------------------------------------------------

interface ExecContext {
  ctx: RequestContext;
  entity?: string;
  record: Rec;
  dry: boolean;
  steps: RunStep[];
  output: Record<string, number>;
}

function bump(out: Record<string, number>, key: string, by = 1): void {
  out[key] = (out[key] ?? 0) + by;
}

/** Deterministic pseudo lead/deal score (no external model needed for the demo). */
function pseudoScore(record: Rec): number {
  const str = JSON.stringify(record);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 1000;
  return 40 + (h % 60); // 40..99
}

async function executeAction(action: AutomationAction, ec: ExecContext): Promise<void> {
  const t0 = Date.now();
  const step: RunStep = { name: labelFor(action), type: action.type, status: "ok", ms: 0 };
  try {
    const id = ec.record.id ? String(ec.record.id) : null;
    switch (action.type) {
      case "send_email":
      case "send_sms":
      case "send_whatsapp":
      case "notify": {
        const channel = action.type === "send_email" ? "email" : "system";
        const subject = interpolate(action.subject, ec.record) || defaultSubject(action.type);
        const to = interpolate(action.to, ec.record);
        if (!ec.dry) {
          notifications.add({
            at: ec.ctx.at,
            tenantId: ec.ctx.tenantId,
            orgId: ec.ctx.orgId,
            channel,
            subject,
            body: interpolate(action.body, ec.record) || `${action.type} via automation`,
            eventType: `automation.${action.type}`,
          });
        }
        bump(ec.output, action.type === "send_email" ? "emails" : "notifications");
        step.output = to ? `${prettyChannel(action.type)} → ${to}` : `${prettyChannel(action.type)} sent`;
        break;
      }
      case "create_task": {
        const subject = interpolate(action.taskSubject, ec.record) || "Automation follow-up";
        if (!ec.dry) {
          const qe = await getQueryEngine();
          const rec = await qe.create(ec.ctx, "task", {
            subject,
            status: "open",
            notes: `Auto-created by automation${id ? ` for ${ec.entity ?? "record"} ${id}` : ""}.`,
            ...(ec.entity === "deal" && id ? { dealId: id } : {}),
          });
          step.output = `created task ${rec.id}`;
        } else {
          step.output = `would create task “${subject}”`;
        }
        bump(ec.output, "created");
        break;
      }
      case "create_reminder": {
        const days = action.reminderInDays ?? 1;
        if (!ec.dry) {
          const qe = await getQueryEngine();
          const rec = await qe.create(ec.ctx, "task", {
            subject: `Reminder: follow up ${ec.entity ?? "record"}`,
            status: "open",
            notes: `Reminder scheduled in ${days} day(s) by automation.`,
          });
          step.output = `reminder task ${rec.id} (+${days}d)`;
        } else {
          step.output = `would create reminder (+${days}d)`;
        }
        bump(ec.output, "created");
        break;
      }
      case "assign_owner": {
        const owner =
          action.assignTo ||
          (ec.entity ? await automationStore.nextAssignee(ec.ctx.tenantId, ec.ctx.orgId, ec.entity) : null);
        if (!owner) {
          step.status = "skipped";
          step.output = "no assignee resolved (configure an assignment rule)";
          break;
        }
        if (!ec.dry && ec.entity && id) {
          const qe = await getQueryEngine();
          await qe.update(ec.ctx, ec.entity, id, { ownerId: owner });
        }
        bump(ec.output, "advanced");
        step.output = `assigned to ${owner}`;
        break;
      }
      case "update_stage": {
        if (!ec.entity || !action.stage) {
          step.status = "skipped";
          step.output = "missing entity or target stage";
          break;
        }
        const def = metadata.getEntity(ec.entity);
        const lifeField = def.lifecycle?.field;
        if (!lifeField) {
          step.status = "skipped";
          step.output = `${ec.entity} has no lifecycle`;
          break;
        }
        if (!ec.dry && id) {
          const qe = await getQueryEngine();
          await qe.update(ec.ctx, ec.entity, id, { [lifeField]: action.stage }, { allowLifecycleField: true });
        }
        bump(ec.output, "advanced");
        step.output = `${lifeField} → ${action.stage}`;
        break;
      }
      case "update_record": {
        const entity = action.entity || ec.entity;
        if (!entity || !action.field) {
          step.status = "skipped";
          step.output = "missing entity or field";
          break;
        }
        const value = interpolate(action.value, ec.record);
        if (!ec.dry && id) {
          const qe = await getQueryEngine();
          await qe.update(ec.ctx, entity, id, { [action.field]: value });
        }
        bump(ec.output, "advanced");
        step.output = `set ${entity}.${action.field} = ${value || "''"}`;
        break;
      }
      case "create_record": {
        const entity = action.entity;
        if (!entity) {
          step.status = "skipped";
          step.output = "no target entity";
          break;
        }
        const data = action.field ? { [action.field]: interpolate(action.value, ec.record) } : {};
        if (!ec.dry) {
          const qe = await getQueryEngine();
          const rec = await qe.create(ec.ctx, entity, data);
          step.output = `created ${entity} ${rec.id}`;
        } else {
          step.output = `would create ${entity}`;
        }
        bump(ec.output, "created");
        break;
      }
      case "webhook": {
        const url = interpolate(action.url, ec.record);
        if (!url) {
          step.status = "skipped";
          step.output = "no URL configured";
          break;
        }
        if (!ec.dry) {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-aula-event": "automation" },
            body: JSON.stringify({ record: ec.record }),
          });
          if (!res.ok) throw new Error(`webhook returned ${res.status}`);
          step.output = `POST ${url} → ${res.status}`;
        } else {
          step.output = `would POST ${url}`;
        }
        bump(ec.output, "webhooks");
        break;
      }
      case "delay": {
        const mins = action.delayMinutes ?? 0;
        step.output = `wait ${mins} min${mins === 1 ? "" : "s"} (scheduled)`;
        break;
      }
      case "ai_score": {
        const score = pseudoScore(ec.record);
        const field = action.field || "score";
        if (!ec.dry && ec.entity && id) {
          try {
            const qe = await getQueryEngine();
            await qe.update(ec.ctx, ec.entity, id, { [field]: score });
          } catch {
            /* entity may not have a score field — scoring still recorded */
          }
        }
        bump(ec.output, "advanced");
        step.output = `${action.model || "model"}: ${field}=${score}`;
        break;
      }
      case "branch": {
        const cond = action.condition;
        const matched = cond ? evaluateGroup(cond, ec.record) : true;
        step.output = matched ? "then →" : "else →";
        const branch = matched ? action.thenActions ?? [] : action.elseActions ?? [];
        ec.steps.push({ ...step, ms: Date.now() - t0 });
        await runActions(branch, ec);
        return; // already pushed
      }
      case "parallel": {
        step.output = `${action.lanes?.length ?? 0} lane(s)`;
        ec.steps.push({ ...step, ms: Date.now() - t0 });
        for (const lane of action.lanes ?? []) await runActions(lane, ec);
        return; // already pushed
      }
      default:
        step.status = "skipped";
        step.output = "unknown action";
    }
  } catch (e) {
    step.status = "failed";
    step.error = e instanceof Error ? e.message : String(e);
    ec.steps.push({ ...step, ms: Date.now() - t0 });
    throw e;
  }
  step.ms = Date.now() - t0;
  ec.steps.push(step);
}

async function runActions(actions: AutomationAction[], ec: ExecContext): Promise<void> {
  for (const action of actions) await executeAction(action, ec);
}

function prettyChannel(type: string): string {
  if (type === "send_email") return "Email";
  if (type === "send_sms") return "SMS";
  if (type === "send_whatsapp") return "WhatsApp";
  return "Notification";
}
function defaultSubject(type: string): string {
  return `${prettyChannel(type)} from automation`;
}
function labelFor(action: AutomationAction): string {
  const map: Record<string, string> = {
    send_email: "Send email",
    send_sms: "Send SMS",
    send_whatsapp: "Send WhatsApp",
    notify: "Notify team",
    create_task: "Create task",
    create_reminder: "Create reminder",
    assign_owner: "Assign owner",
    update_stage: "Update stage",
    update_record: "Update record",
    create_record: "Create record",
    webhook: "Call webhook",
    delay: "Delay",
    ai_score: "AI score",
    branch: "If / Else",
    parallel: "Parallel",
    ai_score_: "AI score",
  };
  return map[action.type] ?? action.type;
}

/**
 * Run one rule against a record. `test` runs are dry (no writes / messages) and
 * excluded from live stats; live runs perform real side effects.
 */
export async function executeRule(
  rule: AutomationRule,
  ctx: RequestContext,
  record: Rec,
  opts: { test: boolean; trigger: string },
): Promise<AutomationRun> {
  const startedAt = ctx.at;
  const t0 = Date.now();
  const ec: ExecContext = {
    ctx,
    entity: rule.trigger.entity,
    record,
    dry: opts.test,
    steps: [
      {
        name: `Trigger: ${opts.trigger}`,
        type: "trigger",
        status: "ok",
        ms: 0,
        output: rule.trigger.entity ? `record ${record.id ?? ""}` : opts.trigger,
      },
    ],
    output: {},
  };

  // Condition gate.
  const leaves = countLeaves(rule.conditions);
  const passed = evaluateGroup(rule.conditions, record);
  ec.steps.push({
    name: leaves ? `Conditions (${leaves})` : "Conditions",
    type: "condition",
    status: passed ? "ok" : "skipped",
    ms: 0,
    output: leaves ? (passed ? "all matched" : "did not match") : "none",
  });

  let status: RunStatus = "success";
  let error: string | undefined;
  if (!passed) {
    status = "skipped";
  } else {
    try {
      await runActions(rule.actions, ec);
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const finishedAt = new Date().toISOString();
  const run: AutomationRun = {
    id: "",
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
    ruleId: rule.id,
    ruleName: rule.name,
    status,
    trigger: opts.trigger,
    input: record,
    output: ec.output,
    steps: ec.steps,
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    error,
    test: opts.test,
  };
  const saved = await automationStore.recordRun(run);

  // Failure handling for live runs: enqueue to retry, alert if configured.
  if (!opts.test && status === "failed") {
    const settings = await automationStore.getSettings(ctx.tenantId, ctx.orgId);
    await automationStore.enqueue({
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      ruleId: rule.id,
      ruleName: rule.name,
      state: "retry",
      attempts: 1,
      maxAttempts: settings.maxRetries,
      nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      enqueuedAt: finishedAt,
      lastError: error,
      input: record,
    });
    if (settings.failureAlerts) {
      notifications.add({
        at: ctx.at,
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        channel: "system",
        subject: `Automation failed: ${rule.name}`,
        body: error ?? "An automation run failed.",
        eventType: "automation.failed",
        href: "/automation",
      });
    }
  }
  return saved;
}

// ---- event-bus integration --------------------------------------------------

/** Normalise a domain event type ("deal.stage_changed") into entity + suffix. */
function parseEventType(type: string): { entity: string; suffix: string } {
  const dot = type.indexOf(".");
  if (dot < 0) return { entity: type, suffix: "" };
  return { entity: type.slice(0, dot), suffix: type.slice(dot + 1) };
}

function triggerMatches(rule: AutomationRule, entity: string, suffix: string, record: Rec): boolean {
  if (rule.trigger.kind !== "event") return false;
  if (rule.trigger.entity !== entity) return false;
  const ev = rule.trigger.event ?? "any";
  if (ev === "any") return true;
  if (ev === suffix) return true;
  if (ev === "won") return suffix === "win" || (suffix === "stage_changed" && String(record.stage) === "won");
  if (ev === "lost") return suffix === "lose" || suffix === "lost" || (suffix === "stage_changed" && String(record.stage) === "lost");
  if (ev === "converted") return suffix === "converted";
  return false;
}

let registered = false;

export function registerAutomationEngine(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe("*", async (event: DomainEvent) => {
    // Ignore noisy internal events we don't model as triggers.
    if (event.type === "ping") return;
    const { entity, suffix } = parseEventType(event.type);
    const record: Rec = (event.payload.record as Rec) ?? { id: event.payload.id };
    const all = await automationStore.listRules(event.tenantId, event.orgId);
    const rules = all.filter((r) => r.status === "active" && triggerMatches(r, entity, suffix, record));
    if (rules.length === 0) return;

    const ctx = systemContext(event.tenantId, event.orgId, { correlationId: event.correlationId });
    for (const rule of rules) {
      try {
        await executeRule(rule, ctx, record, { test: false, trigger: event.type });
      } catch (e) {
        logger.error("automation rule crashed", {
          ruleId: rule.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  logger.info("automation engine registered");
}

/** Run all active schedule-triggered rules (called from the cron tick). */
export async function runScheduledAutomations(ctx: RequestContext): Promise<{ ruleId: string; status: RunStatus }[]> {
  const all = await automationStore.listRules(ctx.tenantId, ctx.orgId);
  const rules = all.filter((r) => r.status === "active" && r.trigger.kind === "schedule");
  const out: { ruleId: string; status: RunStatus }[] = [];
  for (const rule of rules) {
    const run = await executeRule(rule, ctx, { scheduledAt: ctx.at }, { test: false, trigger: "schedule" });
    out.push({ ruleId: rule.id, status: run.status });
  }
  return out;
}
