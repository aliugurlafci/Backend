/**
 * Phase 11 / Phase 13 — structured logger with secret + PII redaction.
 *
 * Emits one JSON line per event. Sensitive keys are masked so tokens and PII
 * never reach logs (secure logging). Child loggers carry base fields such as
 * correlationId for request tracing.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

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
