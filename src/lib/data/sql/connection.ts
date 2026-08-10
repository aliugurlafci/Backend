/**
 * Connection facade.
 *
 * Thin, driver-agnostic entry points used by boot, shutdown and the migrator.
 * The concrete pool lives inside the selected {@link getDriver} implementation.
 */
import { getDriver } from "./driver";

/** Ensure the target database exists (best-effort; see the driver). */
export async function ensureDatabase(): Promise<void> {
  await (await getDriver()).ensureDatabase();
}

/** Close the active connection pool (graceful shutdown / tests). */
export async function closePool(): Promise<void> {
  await (await getDriver()).close();
}

/**
 * Round-trip the pool so a health check reflects reality.
 *
 * `SELECT 1` is valid on both engines, needs no dialect support and touches no
 * schema — it proves a connection can be acquired and a statement executed,
 * which is exactly what a readiness probe should assert. Never throws: the
 * caller turns the outcome into a status code.
 */
export async function pingDatabase(): Promise<"ok" | "error"> {
  try {
    const driver = await getDriver();
    await driver.query("SELECT 1 AS ok", []);
    return "ok";
  } catch {
    return "error";
  }
}
