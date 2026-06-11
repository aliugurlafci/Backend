/**
 * Environment configuration (backend).
 *
 * Loads `.env`, then validates and types `process.env` at startup. Secrets are
 * read here and surfaced as a typed object; missing/insecure required secrets in
 * production fail fast rather than silently using dev defaults.
 */
import "dotenv/config";
import { z } from "zod";

/** Parse common truthy/falsy env string representations into a boolean. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return def;
      return ["1", "true", "yes", "on"].includes(v.toLowerCase());
    });

const intish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // HTTP server
  PORT: intish(4000),
  CORS_ORIGINS: z.string().optional().default("http://localhost:3000"),

  // MSSQL
  MSSQL_SERVER: z.string().default("localhost"),
  MSSQL_PORT: intish(1433),
  MSSQL_DATABASE: z.string().default("aula_crm"),
  MSSQL_USER: z.string().default("sa"),
  MSSQL_PASSWORD: z.string().default(""),
  MSSQL_ENCRYPT: boolish(false),
  MSSQL_TRUST_SERVER_CERTIFICATE: boolish(true),
  MSSQL_INSTANCE: z.string().optional(),
  MSSQL_POOL_MAX: intish(10),
  MSSQL_POOL_MIN: intish(0),

  // Auth / secrets
  AULA_JWT_SECRET: z.string().optional(),
  AULA_JWT_TTL: intish(3600),
  AULA_ENCRYPTION_KEY: z.string().optional(),
  AULA_DEV_AUTH: boolish(true),

  // Persistence: "mssql" (default, durable) or "memory" (process-local, no DB —
  // handy for local dev, CI and integration tests; data is lost on restart).
  AULA_PERSISTENCE: z.enum(["mssql", "memory"]).optional().default("mssql"),

  // Email (SMTP send + IMAP receive). All optional — when unset the mailbox is
  // DB-only (compose just stores to "sent"; sync is a no-op).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: intish(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: boolish(false),
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: intish(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASS: z.string().optional(),
  IMAP_SECURE: boolish(true),
  IMAP_MAILBOX: z.string().optional().default("INBOX"),

  // File storage: directory for uploaded file bytes (default <cwd>/uploads).
  UPLOAD_DIR: z.string().optional().default(""),

  // Bootstrap behaviour
  AULA_AUTO_MIGRATE: boolish(true),
  AULA_AUTO_SEED: boolish(true),

  // Inventory policy: when false (default) a stock issue/transfer that would
  // drive on-hand negative is rejected; set true to permit overselling/backorders.
  AULA_ALLOW_NEGATIVE_STOCK: boolish(false),
});

export type Env = z.infer<typeof schema>;

const INSECURE_JWT = "dev-insecure-jwt-secret-change-me";
const INSECURE_KEY = "dev-insecure-key-change-me";

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    const problems: string[] = [];
    if (!env.AULA_JWT_SECRET || env.AULA_JWT_SECRET === INSECURE_JWT) {
      problems.push("AULA_JWT_SECRET must be set to a strong value");
    }
    if (!env.AULA_ENCRYPTION_KEY || env.AULA_ENCRYPTION_KEY === INSECURE_KEY) {
      problems.push("AULA_ENCRYPTION_KEY must be set to a strong value");
    }
    // MSSQL credentials are only required when actually persisting to MSSQL.
    if (env.AULA_PERSISTENCE !== "memory" && !env.MSSQL_PASSWORD) {
      problems.push("MSSQL_PASSWORD must be set");
    }
    if (env.AULA_DEV_AUTH) {
      problems.push("AULA_DEV_AUTH must be false in production");
    }
    if (problems.length) {
      throw new Error(`Insecure production configuration: ${problems.join("; ")}`);
    }
  }

  return env;
}

export const env = load();

/** The effective JWT secret (dev fallback used only outside production). */
export const jwtSecret = env.AULA_JWT_SECRET ?? INSECURE_JWT;

export const isProduction = env.NODE_ENV === "production";

/** Allowed CORS origins (parsed from the comma-separated env var). */
export const corsOrigins: string | string[] =
  env.CORS_ORIGINS.trim() === "*"
    ? "*"
    : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Whether record persistence runs in process-local memory (no MSSQL). Drives the
 * store wiring and the /health backend-mode report. Defaults to MSSQL.
 */
export const usingInMemoryBackends = env.AULA_PERSISTENCE === "memory";

/** True when enough SMTP settings are present to actually send mail. */
export const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER);

/** True when enough IMAP settings are present to actually fetch mail. */
export const imapConfigured = Boolean(env.IMAP_HOST && env.IMAP_USER);
