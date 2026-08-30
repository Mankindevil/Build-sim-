import type { HardwareStandard, HardwareStandardFamily, HardwareStandardLibrary } from "./contracts";
import { validateHardwareStandardLibrary, verifyHardwareStandardLibrary } from "./contracts";

export class HardwareStandardRegistry {
  readonly libraryVersion: string;
  readonly contentHash: string;
  private readonly byId: ReadonlyMap<string, HardwareStandard>;

  private constructor(library: HardwareStandardLibrary) {
    this.libraryVersion = library.libraryVersion;
    this.contentHash = library.contentHash;
    this.byId = new Map(library.standards.map((standard) => [standard.standardId, standard]));
  }

  static async create(library: HardwareStandardLibrary): Promise<HardwareStandardRegistry> {
    const errors = validateHardwareStandardLibrary(library);
    if (errors.length || !await verifyHardwareStandardLibrary(library)) {
      throw new TypeError(errors.length ? errors.join("; ") : "hardware standard library content hash mismatch");
    }
    return new HardwareStandardRegistry(library);
  }

  get(standardId: string): HardwareStandard | null {
    const standard = this.byId.get(standardId.normalize("NFC"));
    return standard ? structuredClone(standard) : null;
  }

  list(family?: HardwareStandardFamily): HardwareStandard[] {
    return [...this.byId.values()]
      .filter((standard) => family === undefined || standard.family === family)
      .map((standard) => structuredClone(standard));
  }

  /** Explicit compatibility edges only; names and prefixes have no authority. */
  canMate(leftStandardId: string, rightStandardId: string): boolean {
    const left = this.byId.get(leftStandardId.normalize("NFC"));
    const right = this.byId.get(rightStandardId.normalize("NFC"));
    if (!left || !right) return false;
    if (left.standardId === right.standardId) return true;
    return left.matesWithStandardIds.includes(right.standardId)
      && right.matesWithStandardIds.includes(left.standardId);
  }

  supersedes(newStandardId: string, oldStandardId: string): boolean {
    const current = this.byId.get(newStandardId.normalize("NFC"));
    return current?.supersedesStandardIds.includes(oldStandardId.normalize("NFC")) ?? false;
  }
}
