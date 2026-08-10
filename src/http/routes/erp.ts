/**
 * The SAP PI/PO interface: one endpoint they call, and the operator's view of
 * everything that has crossed in either direction.
 */

import { type Request, type Response, type Router } from "express";
import { runApi, setApiHeaders, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { parseBody, erpSyncSchema } from "@/lib/http/body";
import { BadRequestError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { adminOnly } from "./shared";

export function registerErpRoutes(r: Router): void {
  /**
   * Everything PI/PO sends us.
   *
   * Outside `runApi` on purpose. That pipeline authenticates a person — a
   * session cookie or a bearer JWT — and PI/PO is a machine that authenticates
   * with HTTP Basic against a technical user, the way every SAP channel does.
   * Forcing it through the session path would mean issuing a JWT to middleware
   * and rotating it by hand forever.
   *
   * It also answers in XML or JSON rather than our error envelope, because
   * PI/PO correlates the reply to the request by message id and a channel that
   * receives an unexpected shape reports our interface as down.
   */
  r.post("/erp/inbound", (req: Request, res: Response) => {
    void (async () => {
      const { erpConfig } = await import("@/lib/erp/sync");
      const { receiveMessage } = await import("@/lib/erp/inbound");
      const { ack } = await import("@/lib/erp/codec");
      const { systemContext } = await import("@/lib/context/resolver");
      const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");

      const ctx = systemContext(TENANT_ID, ORG_ID);
      const config = await erpConfig(ctx);
      const contentType = req.get("content-type") ?? undefined;
      const wantsJson = contentType?.includes("json") ?? false;

      // Basic auth against the configured technical user. Checked before the
      // body is looked at: an unauthenticated caller learns nothing about
      // whether their payload would have parsed.
      if (config.username) {
        const header = req.get("authorization") ?? "";
        const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
        if (header !== expected) {
          logger.warn("erp inbound unauthenticated", { ip: req.ip });
          setApiHeaders(res);
          res
            .status(401)
            .type(wantsJson ? "application/json" : "text/xml")
            .send(ack("", wantsJson ? "json" : "xml", "error", "unauthorised"));
          return;
        }
      }

      const body = typeof req.body === "string" ? req.body : "";
      const result = await receiveMessage(ctx, body, contentType);
      setApiHeaders(res);
      res
        // 200 even for a business error, with the failure in the acknowledgement
        // body — EXCEPT when there was no readable message at all. PI/PO treats
        // an HTTP error as "the channel is broken" and retries the transport,
        // which does nothing for a payload it will re-send identically; the
        // acknowledgement is where an application-level rejection belongs.
        .status(result.messageId ? 200 : 400)
        .type(result.format === "json" ? "application/json" : "text/xml")
        .send(ack(result.messageId, result.format, result.status, result.detail));
    })().catch((error: unknown) => {
      logger.error("erp inbound crashed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.status(500).type("text/plain").send("internal error");
    });
  });

  /** The message log — what crossed, when, and what SAP said. Admin only. */
  r.get("/erp/messages", runApi(async (rc, req) => {
    adminOnly(rc);
    const domain = await getDomainService();
    const filters = [];
    const direction = req.query.direction;
    const status = req.query.status;
    if (typeof direction === "string" && direction) filters.push({ field: "direction", op: "eq" as const, value: direction });
    if (typeof status === "string" && status) filters.push({ field: "status", op: "eq" as const, value: status });
    return domain.list(rc, "erpMessage", { filters, sort: [{ field: "createdAt", dir: "desc" }], pageSize: 100 });
  }));

  /** Send everything that is due now, rather than waiting for the job. */
  r.post(
    "/erp/dispatch",
    runApi(
      async (rc) => {
        adminOnly(rc);
        const { dispatchOutbound } = await import("@/lib/erp/sync");
        return dispatchOutbound(rc);
      },
      { mutating: true },
    ),
  );

  /** Re-queue a dead-lettered message, once somebody has fixed the cause. */
  r.post(
    "/erp/messages/:id/retry",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const { retryMessage } = await import("@/lib/erp/sync");
        return retryMessage(rc, pathParam(req, "id"));
      },
      { mutating: true },
    ),
  );

  /**
   * Push one record to SAP now.
   *
   * The manual counterpart to the automatic triggers, and the same code path —
   * so a record sent by hand produces the identical message, which is what makes
   * "resend it and see" a usable diagnostic rather than a different experiment.
   */
  r.post(
    "/erp/sync",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, erpSyncSchema);
        const { queueRecord } = await import("@/lib/erp/sync");
        const { OUTBOUND_TYPES } = await import("@/lib/erp/messages");
        if (!(OUTBOUND_TYPES as readonly string[]).includes(body.messageType)) {
          throw new BadRequestError(`unknown interface "${body.messageType}"`).withKey("err.unknownInterface", { type: body.messageType });
        }
        const message = await queueRecord(rc, body.messageType as never, body.id);
        return { messageId: message.messageId, status: message.status };
      },
      { mutating: true, status: 201 },
    ),
  );
}
