import seed from "../../data/systems/profiles.json";
import { deepReadonly } from "../plans/canonical";
import {
  systemProfileRegistryContentHashRuntime,
  validateSystemProfileDefinitionRuntime,
  validateSystemProfileRegistryRuntime,
} from "./runtime.mjs";
import type { SystemProfileDefinition, SystemProfileRegistryDocument } from "./contracts";

export function validateSystemProfileDefinition(value: unknown): string[] {
  return validateSystemProfileDefinitionRuntime(value);
}

export function validateSystemProfileRegistry(value: unknown): string[] {
  return validateSystemProfileRegistryRuntime(value);
}

export class SystemProfileRegistry {
  readonly document: Readonly<SystemProfileRegistryDocument>;
  readonly contentHash: string;
  private readonly byId: ReadonlyMap<string, SystemProfileDefinition>;

  constructor(document: unknown = seed) {
    const errors = validateSystemProfileRegistry(document);
    if (errors.length) throw new TypeError(`Invalid system profile registry: ${errors.join("; ")}`);
    const cloned = structuredClone(document) as SystemProfileRegistryDocument;
    cloned.profiles.forEach((profile) => Object.freeze(profile));
    this.document = deepReadonly(cloned);
    this.byId = new Map(cloned.profiles.map((profile) => [profile.profileId, profile]));
    const hash = systemProfileRegistryContentHashRuntime(cloned);
    if (hash === null) throw new TypeError("system profile registry cannot be hashed");
    this.contentHash = hash;
  }

  resolve(profileId: string): SystemProfileDefinition {
    const profile = this.byId.get(profileId);
    if (!profile) throw new RangeError(`Unknown system profile: ${profileId}`);
    return structuredClone(profile);
  }

  list(): SystemProfileDefinition[] {
    return [...this.byId.values()].map((profile) => structuredClone(profile));
  }
}

export const DEFAULT_SYSTEM_PROFILE_REGISTRY = new SystemProfileRegistry();
