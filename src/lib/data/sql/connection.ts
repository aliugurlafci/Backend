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
