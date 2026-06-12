/**
 * Slack transport — post messages to the tenant's configured Slack integration
 * (Automation → Integrations → Slack), via an incoming webhook or a bot token.
 */
import { automationStore } from "@/lib/automation/store";
import { logger } from "@/lib/observability/logger";
import { str, num, notConfigured, httpRequest, errMessage, type MessageResult, type TenantScope } from "./transport-util";

export interface SlackMessage {
  /** Override the default channel (bot mode only). */
  channel?: string;
}

/** Post a message to Slack. */
export async function sendSlack(scope: TenantScope, text: string, opts: SlackMessage = {}): Promise<MessageResult> {
  const state = await automationStore.getIntegration(scope.tenantId, scope.orgId, "slack");
  if (!state.enabled) return notConfigured("Slack integration is disabled");
  const c = state.config;
  const mode = str(c, "mode") || "webhook";
  const timeoutMs = num(c, "timeoutMs", 10000);

  const mention = str(c, "mentionUsers");
  const fullText = mention ? `${mention} ${text}` : text;
  const username = str(c, "username") || undefined;
  const iconEmoji = str(c, "iconEmoji") || undefined;

  try {
    if (mode === "webhook") {
      const url = str(c, "webhookUrl");
      if (!url) return notConfigured("Slack webhook URL missing");
      const res = await httpRequest(
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: fullText, username, icon_emoji: iconEmoji }) },
        timeoutMs,
      );
      if (res.ok) {
        logger.info("slack posted", { mode });
        return { ok: true };
      }
      const body = await res.text().catch(() => "");
      return { ok: false, error: body ? body.slice(0, 200) : `Slack webhook HTTP ${res.status}` };
    }

    // bot mode — chat.postMessage
    const token = str(c, "botToken");
    if (!token) return notConfigured("Slack bot token missing");
    const channel = opts.channel || str(c, "defaultChannel");
    if (!channel) return notConfigured("Slack channel missing (set a default channel)");
    const res = await httpRequest(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel, text: fullText, username, icon_emoji: iconEmoji }),
      },
      timeoutMs,
    );
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
    if (res.ok && data.ok) {
      logger.info("slack posted", { mode, channel });
      return { ok: true, id: data.ts };
    }
    return { ok: false, error: data.error || `Slack API HTTP ${res.status}` };
  } catch (e) {
    const error = errMessage(e, timeoutMs);
    logger.warn("slack post error", { mode, error });
    return { ok: false, error };
  }
}
