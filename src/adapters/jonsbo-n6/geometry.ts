import type { BuildConfig } from "../../config/types";
import type { CenteredBox, PlacedPart } from "../../core/geometry";
import type { SkuCatalog } from "../../sku/types";
import profile from "../../../data/cases/jonsbo-n6/profile.json";
import geometry from "../../../data/cases/jonsbo-n6/geometry.json";
import {
  createDeclarativeCaseGeometry,
  type GeometryEnv,
  type PsuPlacement,
} from "../declarative-case/geometry";

const runtime = createDeclarativeCaseGeometry(profile, geometry);

/** Flag-off rollback exports. Flag-on execution compiles the locked data model. */
export const N6_ENVELOPE_BOX: CenteredBox = runtime.envelopeBox;
export const N6_INTERIOR_BOX: CenteredBox = runtime.interiorBox;
export const N6_DECK_Y = runtime.deckY;
export const n6PsuPlacement = (config: BuildConfig, catalog: SkuCatalog): PsuPlacement =>
  runtime.psuPlacement(config, catalog);
export const psuInLowerChamber = runtime.psuInLowerChamber;
export const unionBox = runtime.unionBox;
export const trayCageBox = runtime.trayCageBox;
export const buildN6Geometry = (
  config: BuildConfig,
  catalog: SkuCatalog,
  env: GeometryEnv = {},
): PlacedPart[] => runtime.buildGeometry(config, catalog, env);

export type { GeometryEnv, PsuPlacement };
