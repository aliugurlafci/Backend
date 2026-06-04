/**
 * Phase 11 — lightweight tracing.
 *
 * `withSpan` times an operation, records a duration metric, and logs a debug
 * span line carrying the correlation id. The shape mirrors OpenTelemetry so it
 * can be swapped for a real tracer/exporter without touching call sites.
 */
import { logger } from "./logger";
import { metrics } from "./metrics";

export interface SpanAttributes {
  correlationId?: string;
  [key: string]: unknown;
}

export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs: SpanAttributes = {},
): Promise<T> {
  const start = Date.now();
  metrics.increment(`span.${name}.count`);
  try {
    const result = await fn();
    const ms = Date.now() - start;
    metrics.observe(`span.${name}.ms`, ms);
    logger.debug("span", { span: name, ms, status: "ok", ...attrs });
    return result;
  } catch (error) {
    const ms = Date.now() - start;
    metrics.observe(`span.${name}.ms`, ms);
    metrics.increment(`span.${name}.error`);
    logger.warn("span failed", {
      span: name,
      ms,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      ...attrs,
    });
    throw error;
  }
}
