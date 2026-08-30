import type { PlacedPart } from "../../core/geometry";
import type { SkuCatalog } from "../../sku/types";
import type { WiringPlan } from "../../wiring/types";
import profile from "../../../data/cases/jonsbo-n6/profile.json";
import routingDocument from "../../../data/cases/jonsbo-n6/routing.json";
import {
  createDeclarativeCaseRouting,
  routingFindings,
  type DeclarativeRoutingResult,
} from "../declarative-case/routing";

const runtime = createDeclarativeCaseRouting(routingDocument, profile.trayCount);

/** Flag-off rollback export. */
export const buildN6Routing = (
  parts: PlacedPart[],
  plan: WiringPlan,
  catalog: SkuCatalog,
): DeclarativeRoutingResult => runtime.buildRouting(parts, plan, catalog);

export { routingFindings };
export type N6Routing = DeclarativeRoutingResult;
