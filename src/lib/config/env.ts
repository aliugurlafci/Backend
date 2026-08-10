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

/** Parse an optional, case-insensitive enum with a default. */
const lowerEnum = <T extends readonly [string, ...string[]]>(values: T, def: T[number]) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : def))
    .pipe(z.enum(values));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // HTTP server
  PORT: intish(4000),
  CORS_ORIGINS: z.string().optional().default("http://localhost:3000"),

  /**
   * How many reverse proxies sit in front of this process.
   *
   * This is a security setting, not a convenience one. Express derives `req.ip`
   * from `X-Forwarded-For`, and that header is written by the client — only the
   * hops we actually trust may overwrite it. Saying "trust everything" makes
   * `req.ip` whatever the caller types, which silently defeats every IP-based
   * control we have (the login brute-force throttle above all: rotate one header
   * and the counter never repeats a key).
   *
   * Set it to the number of proxies between the internet and this process — 1
   * behind a single nginx/Traefik, 2 behind a CDN in front of that. A list of
   * IPs/CIDRs is also accepted for a fixed ingress. The default trusts nothing,
   * so `req.ip` is the socket address, which is correct for a direct listener
   * and merely useless (not dangerous) behind an unconfigured proxy.
   */
  AULA_TRUST_PROXY: z.string().optional().default("0"),

  /**
   * Edge request cap per client IP per minute, across the whole API.
   *
   * Deliberately generous: this is a flood backstop, not fairness. An internal
   * deployment usually reaches the server from ONE office NAT address, so every
   * member of staff shares this budget — a tight number here locks out the whole
   * company at the busiest moment, which is the opposite of the goal. Per-user
   * fairness is the per-principal limiter's job, and it can see the user.
   */
  AULA_EDGE_RATE_LIMIT: intish(3000),

  // Which SQL engine the durable backend talks to: "mssql" (SQL Server, default)
  // or "mysql" (MySQL 8.0+ / MariaDB 10.2+). Ignored when AULA_PERSISTENCE=memory.
  DB_CLIENT: lowerEnum(["mssql", "mysql"] as const, "mssql"),

  // MSSQL
  MSSQL_SERVER: z.string().default("localhost"),
  MSSQL_PORT: intish(1433),
  MSSQL_DATABASE: z.string().default("aula_crm"),
  MSSQL_USER: z.string().default("sa"),
  MSSQL_PASSWORD: z.string().default(""),
  MSSQL_ENCRYPT: boolish(false),
  MSSQL_TRUST_SERVER_CERTIFICATE: boolish(true),
  MSSQL_INSTANCE: z.string().optional(),
  // Connection pool. `max` is the hard ceiling on concurrent DB operations for
  // this instance and is the app's real throughput limit under load — a write
  // holds a connection for a whole transaction, a read releases it after one
  // query. Size it to (SQL Server's usable connections ÷ number of app
  // instances); 30 is a safe single-instance production default. `min` keeps a
  // few warm connections so a burst after idle doesn't pay the TLS/handshake
  // cost on the first requests.
  MSSQL_POOL_MAX: intish(30),
  MSSQL_POOL_MIN: intish(2),

  // MySQL (used when DB_CLIENT=mysql). Same pool sizing rationale as MSSQL above.
  MYSQL_HOST: z.string().default("localhost"),
  MYSQL_PORT: intish(3306),
  MYSQL_DATABASE: z.string().default("aula_crm"),
  MYSQL_USER: z.string().default("root"),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_SSL: boolish(false),
  MYSQL_POOL_MAX: intish(30),
  MYSQL_POOL_MIN: intish(2),

  // Auth / secrets
  AULA_JWT_SECRET: z.string().optional(),
  AULA_JWT_TTL: intish(3600),
  AULA_ENCRYPTION_KEY: z.string().optional(),

  /**
   * Currency new documents default to, and the one the ledger is kept in.
   *
   * Defaults to TRY. The previous USD default meant every invoice, order and
   * receipt was created in a currency the company does not trade in — a `$` in
   * front of a lira amount on every screen. Note the GL does NOT convert between
   * currencies, so using a second one is a reporting problem until FX handling
   * lands; this setting decides the one the books are in.
   */
  AULA_BASE_CURRENCY: z.enum(["TRY", "USD", "EUR", "GBP"]).default("TRY"),

  // Tenant identity: the scope stamped on every row (`tenantId` / `orgId`).
  // Single-tenant deployments keep the defaults; changing them after data
  // exists requires re-scoping the existing rows (scripts/retenant.ts). The
  // organisation name belongs to the deployment, not to the source — set it in
  // .env before the first run.
  AULA_TENANT_ID: z.string().min(1).default("AULA-CRM"),
  AULA_ORG_ID: z.string().min(1).default("Default Org"),

  // The organisation's working language. Texts the backend WRITES rather than
  // answers with — notification rows, auto-created tasks, ops-alert titles —
  // have no request locale to follow, so they follow this. Turkish by default:
  // the platform ships for a Turkish company.
  AULA_DEFAULT_LOCALE: z.enum(["en", "tr", "de"]).default("tr"),

  // Bootstrap administrator, created only when the database has no admin
  // position yet (see lib/security/auth-seed). Change the password from
  // Settings → Security after the first sign-in.
  //
  // Deliberately has NO default password. A shipped default is a published
  // credential: anyone who deploys without setting this gets an admin account
  // whose password is readable in the repository. Outside production the dev
  // fallback below applies (and is logged); production refuses to start.
  AULA_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  AULA_ADMIN_PASSWORD: z.string().min(8).optional(),
  AULA_ADMIN_NAME: z.string().min(1).default("Administrator"),

  // Persistence: "sql" (default, durable — the engine is picked by DB_CLIENT) or
  // "memory" (process-local, no DB — handy for local dev, CI and integration
  // tests; data is lost on restart). Legacy values "mssql"/"mysql" are accepted
  // and treated as "sql" (set DB_CLIENT to choose the engine).
  AULA_PERSISTENCE: z
    .string()
    .optional()
    .transform((v) => ((v ?? "sql").trim().toLowerCase() === "memory" ? "memory" : "sql"))
    .pipe(z.enum(["sql", "memory"])),

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
    // DB credentials are only required when actually persisting to a SQL engine.
    if (env.AULA_PERSISTENCE !== "memory") {
      if (env.DB_CLIENT === "mysql" && !env.MYSQL_PASSWORD) {
        problems.push("MYSQL_PASSWORD must be set");
      } else if (env.DB_CLIENT === "mssql" && !env.MSSQL_PASSWORD) {
        problems.push("MSSQL_PASSWORD must be set");
      }
    }
    // The bootstrap admin is a real login with full authority. Omitting it used
    // to fall back to a password committed to this repository.
    if (!env.AULA_ADMIN_PASSWORD) {
      problems.push("AULA_ADMIN_PASSWORD must be set (no default is provided)");
    }
    // TLS verification off by default is fine on a developer's box and wrong
    // against a production database, where it defeats the point of encrypting.
    if (env.AULA_PERSISTENCE !== "memory" && env.DB_CLIENT === "mssql" && env.MSSQL_TRUST_SERVER_CERTIFICATE) {
      problems.push("MSSQL_TRUST_SERVER_CERTIFICATE must be false (it disables TLS verification)");
    }
    // `*` with credentials:true reflects whatever Origin the browser sends,
    // which hands any site a session-authenticated cross-origin request.
    if (env.CORS_ORIGINS.trim() === "*") {
      problems.push("CORS_ORIGINS must list explicit origins, not '*' (credentials are enabled)");
    }
    // Running generated DDL against a production database on every boot is a
    // deploy step masquerading as a startup default.
    if (env.AULA_AUTO_MIGRATE) {
      problems.push("AULA_AUTO_MIGRATE must be false; run `npm run migrate` as a deliberate deploy step");
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

/**
 * Password for the bootstrap administrator.
 *
 * There is no default in the schema on purpose — production refuses to start
 * without one (see `load`). Outside production a well-known dev value is used so
 * a fresh checkout still boots, and `ensureAdminSeed` announces it loudly on the
 * one boot where it actually creates the account.
 */
export const INSECURE_ADMIN_PASSWORD = "dev-insecure-admin-change-me";
export const adminPassword = env.AULA_ADMIN_PASSWORD ?? INSECURE_ADMIN_PASSWORD;
export const adminPasswordIsInsecureDefault = !env.AULA_ADMIN_PASSWORD;

export const isProduction = env.NODE_ENV === "production";

/** The currency new documents are created in — see `AULA_BASE_CURRENCY`. */
export const BASE_CURRENCY = env.AULA_BASE_CURRENCY;

/**
 * The tenant scope every record is written under. Multi-tenancy is enforced
 * throughout the data layer, but a deployment serves one organisation: these two
 * values are the `tenantId` / `orgId` stamped on every row, the JWT claims and
 * the system contexts used by seeds, jobs and auth lookups.
 */
export const TENANT_ID = env.AULA_TENANT_ID;
export const ORG_ID = env.AULA_ORG_ID;

/**
 * Express `trust proxy` value, parsed from `AULA_TRUST_PROXY`.
 *
 * Returns a hop count for a number, a CIDR/IP list for a comma-separated value,
 * and `false` for anything falsy. `true` is accepted but is the one value worth
 * arguing about: it trusts every hop, which means the leftmost `X-Forwarded-For`
 * entry wins and that entry is written by the caller. Configure the real hop
 * count instead — the point of this setting is to know where the address stops
 * being forgeable.
 */
export const trustProxy: boolean | number | string[] = (() => {
  const raw = env.AULA_TRUST_PROXY.trim();
  if (!raw || ["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  if (["true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
})();

/** Requests per minute per client IP at the edge — see `AULA_EDGE_RATE_LIMIT`. */
export const EDGE_RATE_LIMIT = env.AULA_EDGE_RATE_LIMIT;

/** Allowed CORS origins (parsed from the comma-separated env var). */
export const corsOrigins: string | string[] =
  env.CORS_ORIGINS.trim() === "*"
    ? "*"
    : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Whether record persistence runs in process-local memory (no SQL database).
 * Drives the store wiring and the /health backend-mode report. Defaults to a
 * durable SQL backend (the engine is chosen by {@link env.DB_CLIENT}).
 */
export const usingInMemoryBackends = env.AULA_PERSISTENCE === "memory";

/** The active SQL engine for the durable backend (meaningful unless in memory mode). */
export const sqlClient = env.DB_CLIENT;

/** True when the durable backend talks to MySQL rather than SQL Server. */
export const usingMysql = !usingInMemoryBackends && env.DB_CLIENT === "mysql";

/** True when enough SMTP settings are present to actually send mail. */
export const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER);

/** True when enough IMAP settings are present to actually fetch mail. */
export const imapConfigured = Boolean(env.IMAP_HOST && env.IMAP_USER);
