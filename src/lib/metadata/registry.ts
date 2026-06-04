/**
 * Phase 2 — Metadata storage, versioning and the publish pipeline.
 *
 * Metadata is immutable once published. Editing means creating a new draft
 * version and publishing it; the previously published version is archived.
 * The active version is always the most recently published one. Phase 14 adds
 * a governance gate in front of `publish`.
 */
import { entityDefSchema } from "./schema";
import type { EntityDef, MetadataVersion } from "./types";

export class MetadataValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid metadata:\n- ${issues.join("\n- ")}`);
    this.name = "MetadataValidationError";
  }
}

function validateEntities(entities: EntityDef[]): Record<string, EntityDef> {
  const issues: string[] = [];
  const byName: Record<string, EntityDef> = {};

  for (const entity of entities) {
    const result = entityDefSchema.safeParse(entity);
    if (!result.success) {
      for (const i of result.error.issues) {
        issues.push(`${entity.name}.${i.path.join(".")}: ${i.message}`);
      }
      continue;
    }
    if (byName[entity.name]) issues.push(`duplicate entity "${entity.name}"`);
    byName[entity.name] = entity;
  }

  // Cross-entity: reference fields must point at a known entity.
  for (const entity of Object.values(byName)) {
    for (const field of entity.fields) {
      if (field.type === "reference" && field.referenceEntity && !byName[field.referenceEntity]) {
        issues.push(
          `${entity.name}.${field.name} references unknown entity "${field.referenceEntity}"`,
        );
      }
    }
  }

  if (issues.length) throw new MetadataValidationError(issues);
  return byName;
}

export class MetadataRegistry {
  private versions: MetadataVersion[] = [];
  private counter = 0;

  /** Validate and store a new draft version. */
  createDraft(entities: EntityDef[]): MetadataVersion {
    const validated = validateEntities(entities);
    const version: MetadataVersion = {
      version: ++this.counter,
      status: "draft",
      publishedAt: null,
      publishedBy: null,
      entities: validated,
    };
    this.versions.push(version);
    return version;
  }

  /**
   * Publish a version, archiving any currently published one. An archived
   * version may be re-published — this is how a rollback restores a prior
   * metadata release (Phase 14).
   */
  publish(version: number, by: string, at: string): MetadataVersion {
    const target = this.versions.find((v) => v.version === version);
    if (!target) throw new Error(`metadata version ${version} not found`);
    for (const v of this.versions) {
      if (v.status === "published") v.status = "archived";
    }
    target.status = "published";
    target.publishedAt = at;
    target.publishedBy = by;
    return target;
  }

  /** The currently active (published) version. */
  active(): MetadataVersion {
    const published = [...this.versions].reverse().find((v) => v.status === "published");
    if (!published) throw new Error("no published metadata version");
    return published;
  }

  hasActive(): boolean {
    return this.versions.some((v) => v.status === "published");
  }

  getVersion(version: number): MetadataVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  list(): MetadataVersion[] {
    return [...this.versions];
  }
}
