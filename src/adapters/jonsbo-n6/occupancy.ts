import type { BuildConfig } from "../../config/types";
import type { ConflictHit, OccupancyModel, Occupant } from "../../core/occupancy";
import type { PlacedPart } from "../../core/geometry";
import type { EngineFinding } from "../../core/engine";
import type { SkuCatalog } from "../../sku/types";
import { loadRawCatalog } from "../../sku/catalog";
import profile from "../../../data/cases/jonsbo-n6/profile.json";
import geometryDocument from "../../../data/cases/jonsbo-n6/geometry.json";
import { createDeclarativeCaseGeometry, type GeometryEnv } from "../declarative-case/geometry";
import { createDeclarativeCaseOccupancy } from "../declarative-case/occupancy";

const geometry = createDeclarativeCaseGeometry(profile, geometryDocument);
const runtime = createDeclarativeCaseOccupancy(profile, geometryDocument, geometry);

/** Flag-off rollback exports. */
export const N6_ENVELOPE = runtime.envelope;
export const buildN6Slots = (): OccupancyModel["slots"] => runtime.buildSlots();
export const occupantsFromGeometry = (parts: PlacedPart[]): Occupant[] => runtime.occupantsFromGeometry(parts);
export const conflictMarkerParts = (parts: PlacedPart[], hits: ConflictHit[]): PlacedPart[] =>
  runtime.conflictMarkerParts(parts, hits);
export const occupantsFromConfig = (
  config: BuildConfig,
  catalog: SkuCatalog = loadRawCatalog(),
  env: GeometryEnv = {},
): Occupant[] => runtime.occupantsFromConfig(config, catalog, env);
export const n6DomainFindings = (
  config: BuildConfig,
  catalog: SkuCatalog = loadRawCatalog(),
): EngineFinding[] => runtime.domainFindings(config, catalog);
export const buildN6Occupancy = (
  config: BuildConfig,
  catalog: SkuCatalog = loadRawCatalog(),
  env: GeometryEnv = {},
): OccupancyModel => runtime.buildOccupancy(config, catalog, env);
export const n6PsuPlacement = geometry.psuPlacement;
