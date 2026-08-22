import {
  buildAssembly,
  type AssemblyPlan,
  type DeclaredRule,
  type InstallTravelDecl,
  type PreinstalledDecl,
} from "../../core/assembly";
import type { PlacedPart } from "../../core/geometry";
import type { RoutedCable } from "../../core/routing";
import assembly from "../../../data/cases/jonsbo-n6/assembly.json";

/**
 * N6 assembly order. The adapter only supplies the case's declarations; the
 * ordering itself is derived in `src/core/assembly.ts` from the geometry and the
 * routed cables, so a changed anchor moves the order without anyone editing a
 * list of steps.
 */
export function buildN6Assembly(parts: PlacedPart[], cables: RoutedCable[]): AssemblyPlan {
  return buildAssembly({
    parts,
    cables,
    preinstalled: assembly.preinstalled as PreinstalledDecl[],
    install: assembly.install as InstallTravelDecl[],
    declared: assembly.declared as DeclaredRule[],
  });
}
