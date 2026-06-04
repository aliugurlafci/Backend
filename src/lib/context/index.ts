/** Phase 4 — Multi-tenant context barrel. */
export * from "./types";
export * from "./resolver";
export * from "./isolation";
export { ConfigStore, configStore, flagsFor } from "./config";
export {
  DEMO_TENANT,
  DEMO_ORG,
  DEMO_USERS,
  OTHER_TENANT,
  OTHER_ORG,
  OTHER_USER,
} from "./dev";
