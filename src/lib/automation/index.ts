/** Automation platform barrel. */
import { automationStore } from "./store";

export * from "./types";
export { automationStore, AutomationStore } from "./store";

/** Seed demo automations for the demo tenant if none exist yet (idempotent). */
export async function seedAutomations(): Promise<void> {
  await automationStore.seedDemo();
}
export {
  registerAutomationEngine,
  executeRule,
  runScheduledAutomations,
  enqueueScheduled,
  processQueue,
  getLiveActivity,
  evaluateGroup,
  evaluateLeaf,
} from "./engine";
export type { LivePulse, QueueDrainResult } from "./engine";
export { buildCatalog } from "./catalog";
export type { AutomationCatalog, CatalogEntity, CatalogField } from "./catalog";
export {
  INTEGRATION_PROVIDERS,
  resolveEmailConfig,
  integrationDefaults,
  getProviderDef,
  fieldApplies,
} from "./integrations";
export type { IntegrationProviderDef, IntegrationField, IntegrationConfig, ResolvedEmailConfig } from "./integrations";
export { SYSTEM_SETTINGS } from "./system-config";
export type { IntegrationState, SystemSettingValue } from "./store";
