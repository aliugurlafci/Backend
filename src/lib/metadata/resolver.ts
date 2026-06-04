/**
 * Phase 2 — Runtime metadata resolver.
 *
 * A thin read API over the active metadata version that the rest of the
 * platform uses to look up entities, fields and lifecycles at request time.
 */
import type { MetadataRegistry } from "./registry";
import type { EntityDef, FieldDef, LifecycleDef } from "./types";

export class MetadataResolver {
  constructor(private readonly registry: MetadataRegistry) {}

  get version(): number {
    return this.registry.active().version;
  }

  listEntities(): EntityDef[] {
    return Object.values(this.registry.active().entities);
  }

  findEntity(name: string): EntityDef | undefined {
    return this.registry.active().entities[name];
  }

  /** Resolve an entity or throw — used where the entity must exist. */
  getEntity(name: string): EntityDef {
    const entity = this.findEntity(name);
    if (!entity) throw new Error(`unknown entity "${name}"`);
    return entity;
  }

  getField(entityName: string, fieldName: string): FieldDef | undefined {
    return this.getEntity(entityName).fields.find((f) => f.name === fieldName);
  }

  getLifecycle(entityName: string): LifecycleDef | undefined {
    return this.getEntity(entityName).lifecycle;
  }

  piiFields(entityName: string): string[] {
    return this.getEntity(entityName).fields.filter((f) => f.pii).map((f) => f.name);
  }
}
