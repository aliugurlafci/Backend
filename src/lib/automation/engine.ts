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
import { sendMail } from "@/lib/integrations/email-transport";
import { sendSms } from "@/lib/integrations/sms-transport";
import { sendWhatsApp } from "@/lib/integrations/whatsapp-transport";
import { sendSlack } from "@/lib/integrations/slack-transport";
import { restRequest } from "@/lib/integrations/rest-transport";
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

/**
 * Coerce a value to a comparable number: plain numbers stay as-is; date strings
 * (ISO etc.) become a timestamp; everything else is NaN. So `>` / `<` work for
 * both numeric and date fields (e.g. "closeDate after 2026-01-01").
 */
function toComparable(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (s === "") return NaN;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
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
      return toComparable(actual) > toComparable(expected);
    case "gte":
      return toComparable(actual) >= toComparable(expected);
    case "lt":
      return toComparable(actual) < toComparable(expected);
    case "lte":
      return toComparable(actual) <= toComparable(expected);
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

/** The `{{record.field}}` tokens inside a single template string. */
function templateTokens(template: string | undefined): string[] {
  if (!template) return [];
  return [...template.matchAll(/\{\{\s*(?:record\.)?([\w.]+)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * Explain *why* a recipient resolved empty so the run trace is actionable: when
 * the address was a `{{record.field}}` reference, name the field(s) that came
 * back blank (the record has no such value) instead of a generic "no recipient".
 */
function recipientSkipReason(template: string | undefined): string {
  const refs = templateTokens(template);
  if (refs.length > 0) {
    return `no recipient — ${refs.map((r) => `{{${r}}}`).join(", ")} is empty on this record`;
  }
  return "no recipient — set a 'To' address or a {{field}} reference";
}

// ---- record hydration -------------------------------------------------------

/**
 * Every record field a rule reads: condition-leaf fields plus `{{record.field}}`
 * tokens in any action template (recursing into branch/parallel lanes). Used to
 * decide which fields a run needs before it can interpolate them.
 */
function referencedFields(rule: AutomationRule): Set<string> {
  const fields = new Set<string>();
  const fromGroup = (g: ConditionGroup): void => {
    for (const c of g.children) {
      if (c.type === "group") fromGroup(c);
      else if (c.field) fields.add(c.field);
    }
  };
  const fromTemplate = (s: string | undefined): void => {
    for (const tok of templateTokens(s)) fields.add(tok.split(".")[0]);
  };
  const fromActions = (actions: AutomationAction[]): void => {
    for (const a of actions) {
      fromTemplate(a.to);
      fromTemplate(a.subject);
      fromTemplate(a.body);
      fromTemplate(a.value);
      fromTemplate(a.taskSubject);
      fromTemplate(a.url);
      for (const as of a.assignments ?? []) fromTemplate(as.value);
      if (a.condition) fromGroup(a.condition);
      if (a.thenActions) fromActions(a.thenActions);
      if (a.elseActions) fromActions(a.elseActions);
      for (const lane of a.lanes ?? []) fromActions(lane);
    }
  };
  fromGroup(rule.conditions);
  fromActions(rule.actions);
  return fields;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === "";
}

/**
 * Whether a run holds a real, fetchable triggering record — as opposed to NO
 * record at all (a schedule tick, a manual run with nothing selected, a thin
 * event that lost its id). A genuine entity id is non-empty and not the legacy
 * "manual" sentinel. This is the single source of truth for the engine's
 * `hasRecord` gating: actions that read `{{record.*}}` or act on a record by id
 * are SKIPPED with a clear reason (never run against fabricated values) when this
 * is false — which is the fix for the "Manual run" placeholder leaking into a
 * notify/email and for schedule rules silently interpolating empty fields.
 */
function recordHasRealId(record: Rec): boolean {
  const id = record.id;
  return id != null && id !== "manual" && String(id).trim() !== "";
}

/** The `{{record.*}}` field tokens an action reads in its OWN templates (not
 *  recursing — branch/parallel gate their children individually). Drives the
 *  no-record skip: an action with any record token depends on the record. */
function actionRecordTokens(action: AutomationAction): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    for (const tok of templateTokens(s)) out.add(tok);
  };
  add(action.to);
  add(action.subject);
  add(action.body);
  add(action.taskSubject);
  add(action.value);
  add(action.url);
  for (const as of action.assignments ?? []) add(as.value);
  return [...out];
}

/** Actions that act ON the triggering record by id — meaningless without one. */
const ACTION_NEEDS_RECORD_ID = new Set<AutomationAction["type"]>([
  "update_record",
  "update_stage",
  "assign_owner",
  "ai_score",
]);

/**
 * Guarantee a run sees a *complete* record. Domain event payloads are not
 * uniform — the generic create/update/transition events carry the full record,
 * but `deleted` carries only `{id}` and bespoke (e.g. purchasing) events ship a
 * thin `{id, …}`. So when the rule is entity-scoped and we hold a real id, fetch
 * the live record and merge it in (transient payload keys like from/to survive;
 * persisted fields win). This single point is what makes `{{record.*}}` resolve
 * reliably regardless of which event fired.
 *
 * No-ops — adding no read — when there is no real record (schedule ticks, manual
 * runs with nothing selected), when the rule reads no record fields, and when the
 * payload already carries every referenced field (the common full-payload case).
 */
async function hydrateRecord(ctx: RequestContext, rule: AutomationRule, record: Rec): Promise<Rec> {
  const entity = rule.trigger.entity;
  if (!entity || !recordHasRealId(record)) return record;
  const needed = referencedFields(rule);
  if (needed.size === 0) return record; // rule reads no record fields
  if (![...needed].some((f) => isBlank(record[f]))) return record; // payload already complete
  try {
    const qe = await getQueryEngine();
    const full = await qe.get(ctx, entity, String(record.id));
    return { ...record, ...full };
  } catch {
    return record; // record deleted / unreadable — interpolate with what we have
  }
}

// ---- execution --------------------------------------------------------------

interface ExecContext {
  ctx: RequestContext;
  entity?: string;
  record: Rec;
  /** Whether this run has a real triggering record (see recordHasRealId). When
   *  false, record-dependent actions are skipped with a reason. */
  hasRecord: boolean;
  dry: boolean;
  steps: RunStep[];
  output: Record<string, number>;
}

function bump(out: Record<string, number>, key: string, by = 1): void {
  out[key] = (out[key] ?? 0) + by;
}

/**
 * Build a human error message that includes a ValidationError's per-field detail
 * (e.g. "Validation failed: subject — Required") so a failed run says *why* it
 * failed rather than just "Validation failed".
 */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const details = (e as { details?: { field?: string; message?: string }[] }).details;
    if (Array.isArray(details) && details.length > 0) {
      const parts = details.map((d) => (d.field ? `${d.field} — ${d.message ?? ""}` : d.message ?? "")).filter(Boolean);
      if (parts.length > 0) return `${e.message}: ${parts.join("; ")}`;
    }
    return e.message;
  }
  return String(e);
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
    // No-record gate: when the run has no real triggering record, skip any action
    // that reads {{record.*}} or acts on a record by id — surfacing a clear reason
    // instead of firing against a fabricated/empty record (the "Manual run"
    // notification bug). Container actions (branch/parallel) are not gated here;
    // their child actions are gated individually when they run.
    if (!ec.hasRecord && action.type !== "branch" && action.type !== "parallel") {
      const tokens = actionRecordTokens(action);
      if (tokens.length > 0 || ACTION_NEEDS_RECORD_ID.has(action.type)) {
        step.status = "skipped";
        step.output =
          tokens.length > 0
            ? `no record — references ${tokens.map((tk) => `{{${tk}}}`).join(", ")} (run from an event or pick a record)`
            : "no record — this action targets a record (run from an event or pick a record)";
        step.ms = Date.now() - t0;
        ec.steps.push(step);
        return;
      }
    }
    switch (action.type) {
      case "send_email": {
        const subject = interpolate(action.subject, ec.record) || defaultSubject(action.type);
        const to = interpolate(action.to, ec.record).trim();
        const text = interpolate(action.body, ec.record) || "Sent by automation.";
        if (!to) {
          step.status = "skipped";
          step.output = recipientSkipReason(action.to);
          break;
        }
        if (!ec.dry) {
          // Send a real message over the tenant's configured SMTP connection.
          const messageId = await sendMail({ to, subject, text }, { tenantId: ec.ctx.tenantId, orgId: ec.ctx.orgId });
          if (messageId) {
            step.output = `Email → ${to} (sent)`;
          } else {
            // SMTP is not configured — fall back to an in-app notification so the
            // action still has a visible effect (configure Email under Integrations
            // or set SMTP_* env vars to send real mail).
            notifications.add({
              at: ec.ctx.at,
              tenantId: ec.ctx.tenantId,
              orgId: ec.ctx.orgId,
              channel: "email",
              subject,
              body: text,
              eventType: "automation.send_email",
            });
            step.output = `Email → ${to} (SMTP not configured — in-app notification)`;
          }
        } else {
          step.output = `would email ${to}`;
        }
        bump(ec.output, "emails");
        break;
      }
      case "send_sms": {
        const to = interpolate(action.to, ec.record).trim();
        const text = interpolate(action.body, ec.record) || "Sent by automation.";
        if (!to) {
          step.status = "skipped";
          step.output = recipientSkipReason(action.to);
          break;
        }
        if (!ec.dry) {
          // Send a real text over the tenant's configured SMS gateway.
          const res = await sendSms({ tenantId: ec.ctx.tenantId, orgId: ec.ctx.orgId }, to, text);
          if (res.ok) {
            step.output = `SMS → ${to} (sent${res.id ? `, ${res.id}` : ""})`;
          } else if (res.notConfigured) {
            // No gateway configured — fall back to an in-app notification so the
            // action still has a visible effect (configure the SMS Gateway under
            // Automation → Integrations to send real texts).
            notifications.add({
              at: ec.ctx.at,
              tenantId: ec.ctx.tenantId,
              orgId: ec.ctx.orgId,
              channel: "system",
              subject: interpolate(action.subject, ec.record) || defaultSubject(action.type),
              body: text,
              eventType: "automation.send_sms",
            });
            step.output = `SMS → ${to} (gateway not configured — in-app notification)`;
          } else {
            step.status = "failed";
            step.error = res.error;
            step.output = `SMS failed → ${to}: ${res.error}`;
          }
        } else {
          step.output = `would send SMS → ${to}`;
        }
        bump(ec.output, "notifications");
        break;
      }
      case "send_whatsapp": {
        const to = interpolate(action.to, ec.record).trim();
        const text = interpolate(action.body, ec.record) || "Sent by automation.";
        if (!to) {
          step.status = "skipped";
          step.output = recipientSkipReason(action.to);
          break;
        }
        if (!ec.dry) {
          // Send a real WhatsApp message over the tenant's configured provider.
          const res = await sendWhatsApp({ tenantId: ec.ctx.tenantId, orgId: ec.ctx.orgId }, to, text);
          if (res.ok) {
            step.output = `WhatsApp → ${to} (sent${res.id ? `, ${res.id}` : ""})`;
          } else if (res.notConfigured) {
            notifications.add({
              at: ec.ctx.at,
              tenantId: ec.ctx.tenantId,
              orgId: ec.ctx.orgId,
              channel: "system",
              subject: interpolate(action.subject, ec.record) || defaultSubject(action.type),
              body: text,
              eventType: "automation.send_whatsapp",
            });
            step.output = `WhatsApp → ${to} (not configured — in-app notification)`;
          } else {
            step.status = "failed";
            step.error = res.error;
            step.output = `WhatsApp failed → ${to}: ${res.error}`;
          }
        } else {
          step.output = `would send WhatsApp → ${to}`;
        }
        bump(ec.output, "notifications");
        break;
      }
      case "notify": {
        const subject = interpolate(action.subject, ec.record) || defaultSubject(action.type);
        const to = interpolate(action.to, ec.record).trim();
        const bodyText = interpolate(action.body, ec.record) || "notify via automation";
        let extra = "";
        if (!ec.dry) {
          // Always record an in-app notification…
          notifications.add({
            at: ec.ctx.at,
            tenantId: ec.ctx.tenantId,
            orgId: ec.ctx.orgId,
            channel: "system",
            subject,
            body: bodyText,
            eventType: "automation.notify",
          });
          // …and fan out to Slack when that integration is enabled (best-effort).
          const slack = await sendSlack(
            { tenantId: ec.ctx.tenantId, orgId: ec.ctx.orgId },
            subject ? `*${subject}*\n${bodyText}` : bodyText,
          );
          if (slack.ok) extra = " + Slack";
          else if (!slack.notConfigured) extra = ` (Slack failed: ${slack.error})`;
        }
        bump(ec.output, "notifications");
        step.output = (to ? `Notify → ${to}` : "Notify sent") + extra;
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
        // Build the new record from the field assignments (interpolating record
        // tokens). Falls back to the legacy single field/value for old rules.
        const data: Record<string, unknown> = {};
        const assignments = action.assignments ?? (action.field ? [{ field: action.field, value: action.value ?? "" }] : []);
        for (const a of assignments) {
          if (a.field) data[a.field] = interpolate(a.value, ec.record);
        }
        if (!ec.dry) {
          const qe = await getQueryEngine();
          const rec = await qe.create(ec.ctx, entity, data);
          step.output = `created ${entity} ${rec.id}`;
        } else {
          step.output = `would create ${entity} (${Object.keys(data).length} field(s))`;
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
          // Route through the REST/API integration when it's enabled and the URL
          // targets its own origin — so the call carries the configured auth /
          // headers / HMAC signature. Otherwise send a plain unauthenticated POST.
          const viaRest = await restRequest(
            { tenantId: ec.ctx.tenantId, orgId: ec.ctx.orgId },
            { url, method: "POST", body: { record: ec.record }, sameOriginOnly: true },
          );
          if (viaRest.notConfigured) {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-aula-event": "automation" },
              body: JSON.stringify({ record: ec.record }),
            });
            if (!res.ok) throw new Error(`webhook returned ${res.status}`);
            step.output = `POST ${url} → ${res.status}`;
          } else if (viaRest.ok) {
            step.output = `POST ${url} → ${viaRest.status} (REST integration)`;
          } else {
            throw new Error(`webhook failed: ${viaRest.error}`);
          }
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
    step.error = describeError(e);
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

// ---- live run activity (in-memory, powers the "what's running now" UI) ------

export interface LivePulse {
  tenantId: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  status: RunStatus;
  at: string;
  durationMs: number;
  test: boolean;
}

const liveRunning = new Map<string, number>(); // `${tenant}|${org}|${ruleId}` → in-flight count
const livePulses: LivePulse[] = []; // newest-first ring buffer of completed runs
const PULSE_CAP = 60;
const lkey = (t: string, o: string, id: string): string => `${t}|${o}|${id}`;

function markStart(ctx: RequestContext, ruleId: string): void {
  const k = lkey(ctx.tenantId, ctx.orgId, ruleId);
  liveRunning.set(k, (liveRunning.get(k) ?? 0) + 1);
}
function markEnd(ctx: RequestContext, ruleId: string): void {
  const k = lkey(ctx.tenantId, ctx.orgId, ruleId);
  const n = (liveRunning.get(k) ?? 1) - 1;
  if (n <= 0) liveRunning.delete(k);
  else liveRunning.set(k, n);
}
function markPulse(run: AutomationRun): void {
  livePulses.unshift({
    tenantId: run.tenantId, orgId: run.orgId, ruleId: run.ruleId, ruleName: run.ruleName,
    status: run.status, at: run.finishedAt, durationMs: run.durationMs, test: run.test,
  });
  if (livePulses.length > PULSE_CAP) livePulses.length = PULSE_CAP;
}

/** Currently-running rule ids + the most recent completed runs (this tenant). */
export function getLiveActivity(
  tenantId: string,
  orgId: string,
  recent = 12,
): { running: string[]; recent: LivePulse[] } {
  const prefix = `${tenantId}|${orgId}|`;
  const running = [...liveRunning.entries()]
    .filter(([k, n]) => n > 0 && k.startsWith(prefix))
    .map(([k]) => k.slice(prefix.length));
  const recentList = livePulses.filter((p) => p.tenantId === tenantId && p.orgId === orgId).slice(0, recent);
  return { running, recent: recentList };
}

/** Total automations currently executing for a tenant (across all rules). */
export function runningCount(tenantId: string, orgId: string): number {
  const prefix = `${tenantId}|${orgId}|`;
  let n = 0;
  for (const [k, c] of liveRunning) if (k.startsWith(prefix)) n += c;
  return n;
}

/**
 * Run one rule against a record. `test` runs are dry (no writes / messages) and
 * excluded from live stats; live runs perform real side effects.
 */
export async function executeRule(
  rule: AutomationRule,
  ctx: RequestContext,
  record: Rec,
  opts: { test: boolean; trigger: string; fromQueue?: boolean },
): Promise<AutomationRun> {
  const startedAt = ctx.at;
  const t0 = Date.now();
  markStart(ctx, rule.id);
  try {
  // Hydrate first so conditions, actions and the run's input snapshot all see a
  // complete record — even when the triggering event carried only an id.
  const hydrated = await hydrateRecord(ctx, rule, record);
  const hasRecord = recordHasRealId(hydrated);
  const ec: ExecContext = {
    ctx,
    entity: rule.trigger.entity,
    record: hydrated,
    hasRecord,
    dry: opts.test,
    steps: [
      {
        name: `Trigger: ${opts.trigger}`,
        type: "trigger",
        status: "ok",
        ms: 0,
        output: rule.trigger.entity ? (hasRecord ? `record ${hydrated.id}` : "no record") : opts.trigger,
      },
    ],
    output: {},
  };

  // Condition gate.
  const leaves = countLeaves(rule.conditions);
  const passed = evaluateGroup(rule.conditions, hydrated);
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
      error = describeError(e);
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
    input: hydrated,
    output: ec.output,
    steps: ec.steps,
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    error,
    test: opts.test,
  };
  const saved = await automationStore.recordRun(run);
  markPulse(saved);

  // Failure handling for live runs: enqueue to retry, alert if configured. When
  // the run *is* a queue item being processed, the queue processor owns its
  // lifecycle (attempts/backoff/dead), so we don't enqueue a duplicate here.
  //
  // Only replay-worthy runs are enqueued: a failed run with a real record, or a
  // schedule rule (whose legitimate input is {scheduledAt}). A no-record run of
  // an entity rule (e.g. a manual run with nothing selected) is NOT enqueued —
  // replaying it would just re-skip its record-dependent actions every scheduler
  // tick, which is the background-notification recurrence we must not create.
  const replayable = hasRecord || rule.trigger.kind === "schedule";
  if (!opts.test && !opts.fromQueue && status === "failed" && replayable) {
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
      input: hydrated,
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
  } finally {
    markEnd(ctx, rule.id);
  }
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

/** Cadence (ms) for a schedule trigger; unknown values fall back to daily. */
function cadenceMs(trigger: AutomationRule["trigger"]): number {
  switch (trigger.schedule) {
    case "minutely":
      return Math.max(1, Math.floor(trigger.everyMinutes ?? 1)) * 60_000;
    case "hourly":
      return 60 * 60_000;
    case "weekly":
      return 7 * 24 * 60 * 60_000;
    default:
      return 24 * 60 * 60_000; // daily
  }
}

/** Whether a schedule rule is due since its last run (1-min slack absorbs drift). */
function scheduleDue(rule: AutomationRule, nowMs: number): boolean {
  const last = rule.stats.lastRunAt ? Date.parse(rule.stats.lastRunAt) : 0;
  if (!last) return true; // never run → run now
  return nowMs - last >= cadenceMs(rule.trigger) - 60_000;
}

/** Enqueue a set of rules as pending queue items, skipping any that already have
 *  a live (pending/retry) item so the queue doesn't pile up. Returns queued ids. */
async function enqueueRules(ctx: RequestContext, rules: AutomationRule[]): Promise<string[]> {
  if (rules.length === 0) return [];
  const queue = await automationStore.listQueue(ctx.tenantId, ctx.orgId);
  const liveQueued = new Set(queue.filter((q) => q.state !== "dead").map((q) => q.ruleId));
  const settings = await automationStore.getSettings(ctx.tenantId, ctx.orgId);
  const toQueue = rules.filter((r) => !liveQueued.has(r.id));
  for (const rule of toQueue) {
    await automationStore.enqueue({
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      ruleId: rule.id,
      ruleName: rule.name,
      state: "pending",
      attempts: 0,
      maxAttempts: settings.maxRetries,
      nextAttemptAt: null,
      enqueuedAt: ctx.at,
      input: { scheduledAt: ctx.at },
    });
  }
  return toQueue.map((r) => r.id);
}

/** Free execution slots right now = max concurrency − automations already running. */
async function freeSlots(ctx: RequestContext): Promise<number> {
  const settings = await automationStore.getSettings(ctx.tenantId, ctx.orgId);
  const concurrency = Math.max(1, settings.maxConcurrent || 1);
  return Math.max(0, concurrency - runningCount(ctx.tenantId, ctx.orgId));
}

/**
 * Run active schedule-triggered rules, honouring the **max-concurrency** limit:
 * up to `maxConcurrent` rules run at once; any further due rules are pushed to the
 * processing queue (and drained later as slots free up). Returns the rules that
 * ran now (the queued overflow is reflected in the queue).
 *
 * The cron tick (manual "Run now" / external scheduler) passes `force: true` to
 * treat every active schedule rule as due; the in-process scheduler omits it, so
 * each rule only runs once its cadence (minutely/hourly/daily/weekly) has elapsed.
 */
export async function runScheduledAutomations(
  ctx: RequestContext,
  opts: { force?: boolean } = {},
): Promise<{ ruleId: string; status: RunStatus }[]> {
  const all = await automationStore.listRules(ctx.tenantId, ctx.orgId);
  const nowMs = Date.parse(ctx.at) || Date.now();
  const due = all.filter(
    (r) => r.status === "active" && r.trigger.kind === "schedule" && (opts.force || scheduleDue(r, nowMs)),
  );
  if (due.length === 0) return [];

  const slots = await freeSlots(ctx);
  const runNow = due.slice(0, slots);
  const overflow = due.slice(slots);
  // Anything over the concurrency limit waits in the queue.
  if (overflow.length) await enqueueRules(ctx, overflow);

  const settled = await Promise.allSettled(
    runNow.map((rule) => executeRule(rule, ctx, { scheduledAt: ctx.at }, { test: false, trigger: "schedule" })),
  );
  return runNow.map((rule, i) => {
    const s = settled[i];
    const status: RunStatus = s.status === "fulfilled" ? s.value.status : "failed";
    return { ruleId: rule.id, status };
  });
}

/**
 * Enqueue active schedule-triggered rules onto the processing queue so they run
 * through the queue (drained by `processQueue`). `force` ignores per-rule cadence;
 * otherwise only due rules are queued. Returns the queued rule ids.
 */
export async function enqueueScheduled(ctx: RequestContext, opts: { force?: boolean } = {}): Promise<string[]> {
  const all = await automationStore.listRules(ctx.tenantId, ctx.orgId);
  const nowMs = Date.parse(ctx.at) || Date.now();
  const rules = all.filter(
    (r) => r.status === "active" && r.trigger.kind === "schedule" && (opts.force || scheduleDue(r, nowMs)),
  );
  return enqueueRules(ctx, rules);
}

export interface QueueDrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
  remaining: number;
}

/**
 * Drain the processing queue to completion: repeatedly take the next processable
 * item (a `pending` item, or a `retry` whose backoff has elapsed), re-run its
 * rule, and remove it on success/skip — or advance its attempts (→ `retry` with
 * backoff, then `dead` once max attempts are hit) on failure. Loops until nothing
 * is immediately processable (capped by `max`). This is what keeps queued work
 * "running until the queue is complete" — driven by the in-process scheduler and
 * the manual "Run now" / "Process queue" actions.
 */
export async function processQueue(ctx: RequestContext, opts: { max?: number } = {}): Promise<QueueDrainResult> {
  const max = opts.max ?? 200;
  const settings = await automationStore.getSettings(ctx.tenantId, ctx.orgId);
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let dead = 0;

  // Drain in waves: each wave runs up to `freeSlots` items concurrently (so we
  // never exceed the max-concurrency limit), then loops until nothing is
  // immediately processable. `processed` caps total work as a backstop.
  for (let guard = 0; guard < max; guard++) {
    const items = await automationStore.listQueue(ctx.tenantId, ctx.orgId);
    const nowMs = Date.now();
    const processable = items.filter(
      (it) => it.state === "pending" || (it.state === "retry" && (!it.nextAttemptAt || Date.parse(it.nextAttemptAt) <= nowMs)),
    );
    if (processable.length === 0) break;
    const slots = await freeSlots(ctx);
    if (slots === 0) break; // at capacity (other runs in flight) — leave for the next tick
    const wave = processable.slice(0, slots);

    await Promise.all(
      wave.map(async (item) => {
        const rule = await automationStore.getRule(ctx.tenantId, ctx.orgId, item.ruleId);
        if (!rule) {
          await automationStore.removeQueueItem(ctx.tenantId, ctx.orgId, item.id);
          return; // rule was deleted — drop the orphaned item
        }
        const run = await executeRule(rule, ctx, item.input, { test: false, trigger: "queue", fromQueue: true });
        processed += 1;
        if (run.status === "success" || run.status === "skipped") {
          await automationStore.removeQueueItem(ctx.tenantId, ctx.orgId, item.id);
          succeeded += 1;
        } else {
          const attempts = item.attempts + 1;
          const maxAttempts = item.maxAttempts || settings.maxRetries;
          if (attempts >= maxAttempts) {
            await automationStore.updateQueueItem(ctx.tenantId, ctx.orgId, item.id, { state: "dead", attempts, lastError: run.error, nextAttemptAt: null });
            dead += 1;
          } else {
            await automationStore.updateQueueItem(ctx.tenantId, ctx.orgId, item.id, {
              state: "retry",
              attempts,
              lastError: run.error,
              nextAttemptAt: new Date(Date.now() + attempts * 60_000).toISOString(),
            });
            failed += 1;
          }
        }
      }),
    );
  }

  const remaining = (await automationStore.listQueue(ctx.tenantId, ctx.orgId)).filter((it) => it.state !== "dead").length;
  return { processed, succeeded, failed, dead, remaining };
}
