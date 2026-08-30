import bundledSeed from "../../data/standards/hardware-standards.json";
import {
  createHardwareStandardLibrary,
  type HardwareStandardLibrary,
  type HardwareStandardLibrarySeed,
} from "./contracts";

export * from "./contracts";
export * from "./registry";
export * from "./artifact";

let bundledPromise: Promise<HardwareStandardLibrary> | undefined;

export function loadBundledHardwareStandardLibrary(): Promise<HardwareStandardLibrary> {
  bundledPromise ??= createHardwareStandardLibrary(bundledSeed as HardwareStandardLibrarySeed);
  return bundledPromise;
}
