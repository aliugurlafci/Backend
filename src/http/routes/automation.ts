/**
 * The automation platform — rules, runs, the processing queue, assignment rules
 * and the integration hub they deliver through.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import {
  automationStore,
  buildCatalog,
  executeRule,
  enqueueScheduled,
  processQueue,
  getLiveActivity,
  INTEGRATION_PROVIDERS,
  fieldApplies,
  type AssignmentRule,
  type AutomationAction,
  type ConditionGroup,
} from "@/lib/automation";
import {
  assignmentRuleSchema,
  automationRollbackSchema,
  automationRunSchema,
  automationStatusSchema,
  createAutomationSchema,
  integrationToggleSchema,
  integrationTestSchema,
  parseBody,
  settingsBagSchema,
  updateAutomationSchema,
} from "@/lib/http/body";
import { BadRequestError, NotFoundError } from "@/lib/enforcement/errors";
import { sendSms } from "@/lib/integrations/sms-transport";
import { sendWhatsApp } from "@/lib/integrations/whatsapp-transport";
import { sendSlack } from "@/lib/integrations/slack-transport";
import { restTestConnection } from "@/lib/integrations/rest-transport";
import { erpTestConnection } from "@/lib/integrations/erp-transport";
import { systemContext } from "@/lib/context/resolver";
import { adminOnly } from "./shared";

/** Fields referenced as `{{record.X}}` in a rule's message recipients (email / SMS
 *  / WhatsApp / notify) — so a manual run can pick a record that actually yields a
 *  deliverable recipient. */
const MESSAGING_ACTIONS = new Set(["send_email", "send_sms", "send_whatsapp", "notify"]);
function emailRecipientFields(rule: { actions?: Array<{ type: string; to?: unknown }> }): string[] {
  const out = new Set<string>();
  for (const a of rule.actions ?? []) {
    if (MESSAGING_ACTIONS.has(a.type) && typeof a.to === "string") {
      for (const m of a.to.matchAll(/\{\{\s*record\.(\w+)\s*\}\}/g)) {
        if (m[1]) out.add(m[1]);
      }
    }
  }
  return [...out];
}

export function registerAutomationRoutes(r: Router): void {
  // ---- automation platform (admin only) --------------------------------
  // User-defined Trigger → Condition → Action rules, their run logs, processing
  // queue, assignment rules, settings and the builder catalog.

  // Builder catalog (entities, fields, operators, action types) + assignable users.
  r.get("/automation/catalog", runApi(async (rc) => {
    adminOnly(rc);
    const domain = await getDomainService();
    // Assignee picker: a missing user is a rule that cannot be authored, so the
    // list must be complete rather than a page.
    const users = await domain.listComplete(rc, "user", { sort: [{ field: "displayName", dir: "asc" }] });
    return {
      catalog: buildCatalog(),
      users: users.map((u) => ({ id: String(u.id), displayName: String(u.displayName ?? u.email ?? u.id) })),
    };
  }));

  // Dashboard stats (aggregated across the tenant's rules + recent runs).
  r.get("/automation/stats", runApi(async (rc) => {
    adminOnly(rc);
    const rules = await automationStore.listRules(rc.tenantId, rc.orgId);
    const runs = await automationStore.listRuns(rc.tenantId, rc.orgId, { limit: 500 });
    const totals = rules.reduce(
      (acc, r) => {
        acc.runs += r.stats.runs;
        acc.success += r.stats.success;
        acc.failure += r.stats.failure;
        acc.impact += r.stats.impact;
        acc.avgMsSum += r.stats.avgMs * Math.max(1, r.stats.runs);
        acc.avgMsCount += Math.max(1, r.stats.runs);
        return acc;
      },
      { runs: 0, success: 0, failure: 0, impact: 0, avgMsSum: 0, avgMsCount: 0 },
    );
    const queue = await automationStore.listQueue(rc.tenantId, rc.orgId);
    return {
      active: rules.filter((r) => r.status === "active").length,
      paused: rules.filter((r) => r.status === "paused").length,
      draft: rules.filter((r) => r.status === "draft").length,
      total: rules.length,
      runs: totals.runs,
      success: totals.success,
      failure: totals.failure,
      successRate: totals.runs ? Math.round((totals.success / totals.runs) * 100) : 0,
      avgMs: totals.avgMsCount ? Math.round(totals.avgMsSum / totals.avgMsCount) : 0,
      impact: totals.impact,
      queue: {
        pending: queue.filter((q) => q.state === "pending").length,
        retry: queue.filter((q) => q.state === "retry").length,
        dead: queue.filter((q) => q.state === "dead").length,
      },
      recentRuns: runs.slice(0, 8),
      topRules: [...rules].sort((a, b) => b.stats.runs - a.stats.runs).slice(0, 5).map((r) => ({
        id: r.id,
        name: r.name,
        runs: r.stats.runs,
        successRate: r.stats.runs ? Math.round((r.stats.success / r.stats.runs) * 100) : 0,
        status: r.status,
      })),
    };
  }));

  // List + create rules.
  r.get("/automations", runApi(async (rc) => {
    adminOnly(rc);
    return { rules: await automationStore.listRules(rc.tenantId, rc.orgId) };
  }));

  r.post(
    "/automations",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, createAutomationSchema);
        // Trigger, conditions and actions are validated by the automation engine,
        // which owns those vocabularies; the schema checks only that they are
        // present and structurally sane. Two definitions of a trigger would drift.
        const conditions = (body.conditions ?? { type: "group", logic: "AND", children: [] }) as unknown as ConditionGroup;
        return await automationStore.createRule({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          name: body.name,
          description: body.description,
          status: body.status,
          trigger: body.trigger as never,
          conditions,
          actions: (body.actions ?? []) as unknown as AutomationAction[],
          tags: body.tags,
          requiresApproval: body.requiresApproval,
          by: rc.userId,
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/automations/:id", runApi(async (rc, req) => {
    adminOnly(rc);
    const rule = await automationStore.getRule(rc.tenantId, rc.orgId, pathParam(req, "id"));
    if (!rule) throw new NotFoundError("automation", pathParam(req, "id"));
    return rule;
  }));

  r.patch(
    "/automations/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, updateAutomationSchema) as Record<string, unknown>;
        const updated = await automationStore.updateRule(rc.tenantId, rc.orgId, pathParam(req, "id"), body, rc.userId);
        if (!updated) throw new NotFoundError("automation", pathParam(req, "id"));
        return updated;
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automations/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeRule(rc.tenantId, rc.orgId, pathParam(req, "id")))) {
          throw new NotFoundError("automation", pathParam(req, "id"));
        }
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/automations/:id/status",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, automationStatusSchema);
        if (!body.status) throw new BadRequestError("status is required");
        const updated = await automationStore.setStatus(rc.tenantId, rc.orgId, pathParam(req, "id"), body.status, rc.userId);
        if (!updated) throw new NotFoundError("automation", pathParam(req, "id"));
        return updated;
      },
      { mutating: true },
    ),
  );

  r.post(
    "/automations/:id/rollback",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, automationRollbackSchema);
        if (typeof body.version !== "number") throw new BadRequestError("version is required");
        const updated = await automationStore.rollback(rc.tenantId, rc.orgId, pathParam(req, "id"), body.version, rc.userId);
        if (!updated) throw new NotFoundError("automation version", String(body.version));
        return updated;
      },
      { mutating: true },
    ),
  );

  // Run a rule on demand. Default is a REAL run (performs the actions) against
  // the most recent record of the trigger entity (so {{record.field}} resolves to
  // real data); pass `{ test: true }` for a side-effect-free dry run, or
  // `{ recordId }` / `{ sample }` to target a specific/synthetic record.
  r.post(
    "/automations/:id/run",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, pathParam(req, "id"));
        if (!rule) throw new NotFoundError("automation", pathParam(req, "id"));
        const body = parseBody(req, automationRunSchema);
        const isTest = body.test === true;
        const domain = await getDomainService();
        let record: Record<string, unknown> = body.sample ?? {};
        if (body.recordId && rule.trigger.entity) {
          try {
            record = await domain.get(rc, rule.trigger.entity, body.recordId);
          } catch {
            /* fall back to whatever sample was provided */
          }
        } else if (rule.trigger.entity && Object.keys(record).length === 0) {
          // No explicit record → run against a recent record of the trigger
          // entity so the rule executes with real data. Prefer the newest record
          // that actually populates the message-recipient field(s) (so a
          // {{record.email}} send has a deliverable address), else the newest.
          // `createdAt` isn't a declared sortable field, so order in JS rather
          // than relying on the query engine's sort.
          try {
            const page = await domain.list(rc, rule.trigger.entity, { pageSize: 50 });
            const items = [...page.items].sort((a, b) =>
              String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
            const refs = emailRecipientFields(rule);
            const usable = refs.length
              ? items.find((r) => refs.every((f) => r[f] != null && String(r[f]).trim() !== ""))
              : undefined;
            const chosen = usable ?? items[0];
            if (chosen) record = chosen;
          } catch {
            /* entity not readable / empty — fall through to the placeholder */
          }
        }
        // No fabricated placeholder. When nothing resolved, run with an explicit
        // empty record so the engine reports hasRecord=false and SKIPS
        // record-dependent actions with a clear reason — instead of interpolating
        // a fake {id:"manual", name:"Manual run"} into a notify/email.
        const run = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), record, {
          test: isTest,
          trigger: isTest ? "manual test" : "manual run",
        });
        return run;
      },
      { mutating: true },
    ),
  );

  // Execution logs.
  r.get("/automation/runs", runApi(async (rc, req) => {
    adminOnly(rc);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    return {
      runs: await automationStore.listRuns(rc.tenantId, rc.orgId, {
        ruleId: req.query.ruleId ? String(req.query.ruleId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit,
      }),
    };
  }));

  r.get("/automation/runs/:id", runApi(async (rc, req) => {
    adminOnly(rc);
    const run = await automationStore.getRun(rc.tenantId, rc.orgId, pathParam(req, "id"));
    if (!run) throw new NotFoundError("run", pathParam(req, "id"));
    return run;
  }));

  // Re-run a past execution live, replaying its captured input.
  r.post(
    "/automation/runs/:id/retry",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const run = await automationStore.getRun(rc.tenantId, rc.orgId, pathParam(req, "id"));
        if (!run) throw new NotFoundError("run", pathParam(req, "id"));
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, run.ruleId);
        if (!rule) throw new NotFoundError("automation", run.ruleId);
        const fresh = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), run.input, {
          test: false,
          trigger: "manual re-run",
        });
        return fresh;
      },
      { mutating: true },
    ),
  );

  // Live activity: which rules are running right now + the most recent completed
  // runs — polled by the Automations screen for "what's running" indicators.
  r.get("/automation/live", runApi(async (rc) => {
    adminOnly(rc);
    return getLiveActivity(rc.tenantId, rc.orgId);
  }));

  // Run now: queue every active schedule-triggered automation, then drain the
  // whole queue to completion (so multiple automations are processed in order).
  r.post(
    "/automation/run-now",
    runApi(
      async (rc) => {
        adminOnly(rc);
        const ctx = systemContext(rc.tenantId, rc.orgId);
        const queued = await enqueueScheduled(ctx, { force: true });
        const result = await processQueue(ctx);
        return { queued: queued.length, ...result };
      },
      { mutating: true },
    ),
  );

  // Processing queue (pending / retry / dead-letter).
  r.get("/automation/queue", runApi(async (rc) => {
    adminOnly(rc);
    return { items: await automationStore.listQueue(rc.tenantId, rc.orgId) };
  }));

  // Drain the queue to completion (pending + due-retry items run until clear).
  r.post(
    "/automation/queue/process",
    runApi(
      async (rc) => {
        adminOnly(rc);
        return processQueue(systemContext(rc.tenantId, rc.orgId));
      },
      { mutating: true },
    ),
  );

  r.post(
    "/automation/queue/:id/retry",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const item = await automationStore.getQueueItem(rc.tenantId, rc.orgId, pathParam(req, "id"));
        if (!item) throw new NotFoundError("queue item", pathParam(req, "id"));
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, item.ruleId);
        if (!rule) throw new NotFoundError("automation", item.ruleId);
        const run = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), item.input, {
          test: false,
          trigger: "queue retry",
          fromQueue: true,
        });
        if (run.status === "success" || run.status === "skipped") {
          await automationStore.removeQueueItem(rc.tenantId, rc.orgId, item.id);
        } else {
          item.attempts += 1;
          item.lastError = run.error;
          item.state = item.attempts >= item.maxAttempts ? "dead" : "retry";
          await automationStore.updateQueueItem(rc.tenantId, rc.orgId, item.id, {
            attempts: item.attempts,
            lastError: item.lastError,
            state: item.state,
          });
        }
        return { run, item };
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automation/queue/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeQueueItem(rc.tenantId, rc.orgId, pathParam(req, "id")))) {
          throw new NotFoundError("queue item", pathParam(req, "id"));
        }
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  // Assignment rules.
  r.get("/automation/assignment", runApi(async (rc) => {
    adminOnly(rc);
    return { rules: await automationStore.listAssignment(rc.tenantId, rc.orgId) };
  }));

  r.post(
    "/automation/assignment",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, assignmentRuleSchema) as Partial<AssignmentRule>;
        if (!body.name || !body.entity || !body.strategy) {
          throw new BadRequestError("name, entity and strategy are required");
        }
        return await automationStore.upsertAssignment({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          id: body.id,
          name: body.name,
          entity: body.entity,
          strategy: body.strategy,
          pool: body.pool ?? [],
          territoryMap: body.territoryMap,
          enabled: body.enabled ?? true,
        });
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automation/assignment/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeAssignment(rc.tenantId, rc.orgId, pathParam(req, "id")))) {
          throw new NotFoundError("assignment rule", pathParam(req, "id"));
        }
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  // Settings / governance.
  r.get("/automation/settings", runApi(async (rc) => {
    adminOnly(rc);
    return await automationStore.getSettings(rc.tenantId, rc.orgId);
  }));

  r.patch(
    "/automation/settings",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, settingsBagSchema) as Record<string, unknown>;
        return await automationStore.updateSettings(rc.tenantId, rc.orgId, body);
      },
      { mutating: true },
    ),
  );

  // ---- integration hub (admin only; values stored in the DB) -----------
  r.get("/automation/integrations", runApi(async (rc) => {
    adminOnly(rc);
    return {
      providers: INTEGRATION_PROVIDERS,
      integrations: await automationStore.listIntegrations(rc.tenantId, rc.orgId),
    };
  }));

  r.patch(
    "/automation/integrations/:provider",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const provider = pathParam(req, "provider");
        if (!INTEGRATION_PROVIDERS.some((p) => p.key === provider)) {
          throw new NotFoundError("integration", provider);
        }
        const body = parseBody(req, integrationToggleSchema);
        return await automationStore.upsertIntegration(rc.tenantId, rc.orgId, provider, {
          enabled: body.enabled,
          config: body.config,
        });
      },
      { mutating: true },
    ),
  );

  // Lightweight connection check: confirms required variables are present.
  r.post(
    "/automation/integrations/:provider/test",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const provider = pathParam(req, "provider");
        const def = INTEGRATION_PROVIDERS.find((p) => p.key === provider);
        if (!def) throw new NotFoundError("integration", provider);
        const state = await automationStore.getIntegration(rc.tenantId, rc.orgId, provider);
        if (provider === "email") {
          const cfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
          return {
            ok: cfg.smtpConfigured || cfg.imapConfigured,
            message: `SMTP ${cfg.smtpConfigured ? "ready" : "not configured"} · IMAP ${cfg.imapConfigured ? "ready" : "not configured"}`,
          };
        }
        const isBlank = (key: string) => {
          const v = state.config[key];
          return v === undefined || v === null || String(v).trim() === "";
        };
        if (!state.enabled) {
          return { ok: false, message: "Integration is disabled — enable it to connect." };
        }
        // Only validate the fields the chosen provider actually uses (each field's
        // `showWhen` is evaluated against the saved config).
        const activeFields = def.fields.filter((f) => fieldApplies(f, state.config));
        // Every active field flagged `required` must be present…
        const missing = activeFields.filter((f) => f.required && isBlank(f.key)).map((f) => f.label);
        // …and each `requireOneOf` group needs at least one of its active fields.
        const oneOfMissing = (def.requireOneOf ?? [])
          .map((grp) => grp.filter((k) => activeFields.some((f) => f.key === k)))
          .filter((grp) => grp.length > 0 && grp.every(isBlank))
          .map((grp) => grp.map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join(" / "));
        if (missing.length || oneOfMissing.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`Missing required: ${missing.join(", ")}`);
          if (oneOfMissing.length) parts.push(`Provide at least one of: ${oneOfMissing.join("; ")}`);
          return { ok: false, message: parts.join(" · ") };
        }
        // Live check: actually exercise the connection so the admin gets real
        // confirmation, not just "settings look complete".
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const testTo = String((parseBody(req, integrationTestSchema)).to ?? "").trim();
        if (provider === "sms" && testTo) {
          const res = await sendSms(scope, testTo, "Aula CRM — SMS gateway test ✓");
          return res.ok
            ? { ok: true, message: `Test SMS sent to ${testTo}${res.id ? ` (${res.id})` : ""}` }
            : { ok: false, message: `Test SMS failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "whatsapp" && testTo) {
          const res = await sendWhatsApp(scope, testTo, "Aula CRM — WhatsApp test ✓");
          return res.ok
            ? { ok: true, message: `Test WhatsApp sent to ${testTo}${res.id ? ` (${res.id})` : ""}` }
            : { ok: false, message: `Test WhatsApp failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "slack") {
          const res = await sendSlack(scope, "Aula CRM — Slack integration test ✓");
          return res.ok
            ? { ok: true, message: "Test message posted to Slack" }
            : { ok: false, message: `Slack test failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "rest") {
          const res = await restTestConnection(scope);
          return res.ok
            ? { ok: true, message: `REST endpoint reachable (HTTP ${res.status ?? "200"})` }
            : { ok: false, message: `REST test failed: ${res.error ?? "unknown error"}${res.status ? ` (HTTP ${res.status})` : ""}` };
        }
        if (provider === "erp") {
          const res = await erpTestConnection(scope);
          return res.ok
            ? { ok: true, message: `ERP reachable${res.status ? ` (HTTP ${res.status})` : ""}${res.error ? ` — ${res.error}` : ""}` }
            : { ok: false, message: `ERP test failed: ${res.error ?? "unknown error"}` };
        }
        const filled = activeFields.filter((f) => !isBlank(f.key)).length;
        return {
          ok: true,
          message: `All required settings present — ${filled} field(s) configured, connection looks ready.`,
        };
      },
      { mutating: true },
    ),
  );

}
