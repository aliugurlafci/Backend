/**
 * Phase 11 / Phase 13 — structured logger with secret + PII redaction.
 *
 * Emits one JSON line per event. Sensitive keys are masked so tokens and PII
 * never reach logs (secure logging). Child loggers carry base fields such as
 * correlationId for request tracing.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimum level actually written.
 *
 * Read straight from `process.env` rather than through `lib/config/env`, on
 * purpose: this is the lowest layer in the process and almost everything imports
 * it. Routing it through the config module would mean a logger that fails to
 * load when configuration is invalid — precisely the moment you need it to say
 * why. An unrecognised value falls back to the default instead of throwing, for
 * the same reason.
 *
 * `debug` was previously emitted unconditionally, which in production buried the
 * lines that matter under per-request chatter.
 */
function configuredLevel(): LogLevel {
  const raw = (process.env.AULA_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw in LEVEL_RANK) return raw as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const MIN_RANK = LEVEL_RANK[configuredLevel()];

const REDACT_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
  "apiKey",
  "email",
  "phone",
  "ssn",
]);

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redact(v as LogFields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class Logger {
  constructor(private readonly base: LogFields = {}) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields });
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < MIN_RANK) return;
    const entry = {
      at: new Date().toISOString(),
      level,
      msg,
      ...redact({ ...this.base, ...fields }),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
}

export const logger = new Logger({ service: "aula-crm" });
