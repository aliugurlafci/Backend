/**
 * System / environment settings catalog.
 *
 * Describes the runtime-editable configuration that used to live only in `.env`
 * so it can be managed from the app and stored in the database. Each entry knows
 * its group, type, env-derived default, and whether it's a secret (masked) or a
 * bootstrap value (read-only — e.g. the DB connection and crypto secrets, which
 * cannot move into the database the server connects to).
 */
import { env } from "@/lib/config/env";

export type SystemSettingType = "text" | "password" | "number" | "boolean" | "select";

export interface SystemSettingDef {
  key: string;
  label: string;
  group: string;
  type: SystemSettingType;
  options?: { value: string; label: string }[];
  /** Masked in transport + UI. */
  secret?: boolean;
  /** Bootstrap-only: editable in the UI is disabled (requires env + restart). */
  readonly?: boolean;
  /** Editing takes effect only after a server restart. */
  restart?: boolean;
  help?: string;
  /** The current env-derived default (source of truth before a DB override). */
  envValue: () => string;
}

const b = (v: boolean) => (v ? "true" : "false");

export const SYSTEM_SETTINGS: SystemSettingDef[] = [
  // ---- server ----
  { key: "NODE_ENV", label: "Environment", group: "Server", type: "text", readonly: true, envValue: () => env.NODE_ENV },
  { key: "PORT", label: "HTTP port", group: "Server", type: "number", readonly: true, restart: true, envValue: () => String(env.PORT) },
  { key: "CORS_ORIGINS", label: "CORS origins", group: "Server", type: "text", restart: true, help: "Comma-separated allowed origins", envValue: () => env.CORS_ORIGINS },

  // ---- security ----
  { key: "AULA_DEV_AUTH", label: "Dev persona auth", group: "Security", type: "boolean", restart: true, help: "Allow x-actor/aula_actor login (dev only)", envValue: () => b(env.AULA_DEV_AUTH) },
  { key: "AULA_JWT_TTL", label: "Session lifetime (sec)", group: "Security", type: "number", envValue: () => String(env.AULA_JWT_TTL) },
  { key: "AULA_JWT_SECRET", label: "JWT secret", group: "Security", type: "password", secret: true, readonly: true, help: "Bootstrap secret — set in env", envValue: () => env.AULA_JWT_SECRET ?? "" },
  { key: "AULA_ENCRYPTION_KEY", label: "Encryption key", group: "Security", type: "password", secret: true, readonly: true, help: "Bootstrap secret — set in env", envValue: () => env.AULA_ENCRYPTION_KEY ?? "" },

  // ---- persistence (bootstrap — read-only) ----
  { key: "AULA_PERSISTENCE", label: "Persistence mode", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.AULA_PERSISTENCE },
  { key: "DB_CLIENT", label: "SQL engine", group: "Persistence", type: "text", readonly: true, restart: true, help: "mssql (SQL Server) or mysql", envValue: () => env.DB_CLIENT },
  // SQL Server connection (used when DB_CLIENT=mssql).
  { key: "MSSQL_SERVER", label: "SQL Server host", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MSSQL_SERVER },
  { key: "MSSQL_PORT", label: "SQL Server port", group: "Persistence", type: "number", readonly: true, restart: true, envValue: () => String(env.MSSQL_PORT) },
  { key: "MSSQL_DATABASE", label: "SQL Server database", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MSSQL_DATABASE },
  { key: "MSSQL_USER", label: "SQL Server user", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MSSQL_USER },
  { key: "MSSQL_PASSWORD", label: "SQL Server password", group: "Persistence", type: "password", secret: true, readonly: true, restart: true, envValue: () => env.MSSQL_PASSWORD },
  { key: "MSSQL_ENCRYPT", label: "Encrypt connection", group: "Persistence", type: "boolean", readonly: true, restart: true, envValue: () => b(env.MSSQL_ENCRYPT) },
  // MySQL connection (used when DB_CLIENT=mysql).
  { key: "MYSQL_HOST", label: "MySQL host", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MYSQL_HOST },
  { key: "MYSQL_PORT", label: "MySQL port", group: "Persistence", type: "number", readonly: true, restart: true, envValue: () => String(env.MYSQL_PORT) },
  { key: "MYSQL_DATABASE", label: "MySQL database", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MYSQL_DATABASE },
  { key: "MYSQL_USER", label: "MySQL user", group: "Persistence", type: "text", readonly: true, restart: true, envValue: () => env.MYSQL_USER },
  { key: "MYSQL_PASSWORD", label: "MySQL password", group: "Persistence", type: "password", secret: true, readonly: true, restart: true, envValue: () => env.MYSQL_PASSWORD },

  // ---- storage ----
  { key: "UPLOAD_DIR", label: "Upload directory", group: "Storage", type: "text", restart: true, help: "Where uploaded file bytes are stored", envValue: () => env.UPLOAD_DIR || "<cwd>/uploads" },

  // ---- bootstrap ----
  { key: "AULA_AUTO_MIGRATE", label: "Auto-migrate on boot", group: "Bootstrap", type: "boolean", restart: true, envValue: () => b(env.AULA_AUTO_MIGRATE) },
  { key: "AULA_AUTO_SEED", label: "Auto-seed on boot", group: "Bootstrap", type: "boolean", restart: true, envValue: () => b(env.AULA_AUTO_SEED) },
];

export function getSystemSettingDef(key: string): SystemSettingDef | undefined {
  return SYSTEM_SETTINGS.find((s) => s.key === key);
}

/** The keys an admin may write (everything not bootstrap/read-only). */
export function editableSystemKeys(): Set<string> {
  return new Set(SYSTEM_SETTINGS.filter((s) => !s.readonly).map((s) => s.key));
}

/** Mask a secret value for transport (keeps "is it set?" without leaking it). */
export function maskSecret(value: string): string {
  return value ? "••••••••" : "";
}
