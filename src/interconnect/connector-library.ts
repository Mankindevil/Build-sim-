import type { ConnectorDefinition } from "./types";

const DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    connectorStandardId: "power.atx-24pin-plug", family: "power.atx-24pin", gender: "male", keying: "atx-24pin",
    ratedUses: ["motherboard-main-power"], matingStandards: ["power.atx-24pin-receptacle"], pinoutFamily: "atx-standard",
    defaultInsertionMm: 28, defaultSectionMm: [52, 11],
  },
  {
    connectorStandardId: "power.atx-24pin-receptacle", family: "power.atx-24pin", gender: "female", keying: "atx-24pin",
    ratedUses: ["motherboard-main-power"], matingStandards: ["power.atx-24pin-plug"], pinoutFamily: "atx-standard",
    defaultInsertionMm: 28, defaultSectionMm: [52, 11],
  },
  {
    connectorStandardId: "power.eps-8pin-plug", family: "power.mini-fit-jr-8", gender: "male", keying: "eps-4+4",
    ratedUses: ["cpu-power"], matingStandards: ["power.eps-8pin-receptacle"], pinoutFamily: "eps12v",
    defaultInsertionMm: 24, defaultSectionMm: [21, 11],
  },
  {
    connectorStandardId: "power.eps-8pin-receptacle", family: "power.mini-fit-jr-8", gender: "female", keying: "eps-4+4",
    ratedUses: ["cpu-power"], matingStandards: ["power.eps-8pin-plug"], pinoutFamily: "eps12v",
    defaultInsertionMm: 24, defaultSectionMm: [21, 11],
  },
  {
    connectorStandardId: "power.pcie-8pin-plug", family: "power.mini-fit-jr-8", gender: "male", keying: "pcie-6+2",
    ratedUses: ["gpu-power"], matingStandards: ["power.pcie-8pin-receptacle"], pinoutFamily: "pcie-8pin",
    defaultInsertionMm: 24, defaultSectionMm: [21, 11],
  },
  {
    connectorStandardId: "power.pcie-8pin-receptacle", family: "power.mini-fit-jr-8", gender: "female", keying: "pcie-6+2",
    ratedUses: ["gpu-power"], matingStandards: ["power.pcie-8pin-plug"], pinoutFamily: "pcie-8pin",
    defaultInsertionMm: 24, defaultSectionMm: [21, 11],
  },
  {
    connectorStandardId: "power.12v-2x6-plug", family: "power.12v-2x6", gender: "male", keying: "12v-2x6",
    ratedUses: ["gpu-power"], matingStandards: ["power.12v-2x6-receptacle"], pinoutFamily: "12v-2x6",
    defaultInsertionMm: 35, defaultSectionMm: [20, 10],
  },
  {
    connectorStandardId: "power.12v-2x6-receptacle", family: "power.12v-2x6", gender: "female", keying: "12v-2x6",
    ratedUses: ["gpu-power"], matingStandards: ["power.12v-2x6-plug"], pinoutFamily: "12v-2x6",
    defaultInsertionMm: 35, defaultSectionMm: [20, 10],
  },
  {
    connectorStandardId: "data.sata-plug", family: "data.sata", gender: "male", keying: "sata-data-l",
    ratedUses: ["storage-data"], matingStandards: ["data.sata-receptacle"], pinoutFamily: "sata-data",
    defaultInsertionMm: 18, defaultSectionMm: [15, 5],
  },
  {
    connectorStandardId: "data.sata-receptacle", family: "data.sata", gender: "female", keying: "sata-data-l",
    ratedUses: ["storage-data"], matingStandards: ["data.sata-plug"], pinoutFamily: "sata-data",
    defaultInsertionMm: 18, defaultSectionMm: [15, 5],
  },
  {
    connectorStandardId: "fan.pwm-4pin-plug", family: "fan.pwm-4pin", gender: "male", keying: "pwm-guide",
    ratedUses: ["fan-power-control"], matingStandards: ["fan.pwm-4pin-header"], pinoutFamily: "pwm-fan",
    defaultInsertionMm: 15, defaultSectionMm: [10, 5],
  },
  {
    connectorStandardId: "fan.pwm-4pin-header", family: "fan.pwm-4pin", gender: "female", keying: "pwm-guide",
    ratedUses: ["fan-power-control"], matingStandards: ["fan.pwm-4pin-plug"], pinoutFamily: "pwm-fan",
    defaultInsertionMm: 15, defaultSectionMm: [10, 5],
  },
];

export class ConnectorLibrary {
  readonly #byId: ReadonlyMap<string, ConnectorDefinition>;

  constructor(definitions: readonly ConnectorDefinition[] = DEFINITIONS) {
    const byId = new Map<string, ConnectorDefinition>();
    for (const definition of definitions) {
      if (!definition.connectorStandardId || byId.has(definition.connectorStandardId)
        || !definition.family || !definition.keying || definition.ratedUses.length === 0
        || !Number.isFinite(definition.defaultInsertionMm) || definition.defaultInsertionMm <= 0
        || definition.defaultSectionMm.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
        throw new TypeError("connector definition is invalid");
      }
      byId.set(definition.connectorStandardId, structuredClone(definition));
    }
    this.#byId = byId;
  }

  resolve(connectorStandardId: string): ConnectorDefinition {
    const value = this.#byId.get(connectorStandardId);
    if (!value) throw new TypeError(`connector standard ${connectorStandardId} is unknown`);
    return structuredClone(value);
  }

  compatible(leftId: string, rightId: string): boolean {
    const left = this.resolve(leftId);
    const right = this.resolve(rightId);
    return left.family === right.family
      && left.keying === right.keying
      && left.matingStandards.includes(right.connectorStandardId)
      && right.matingStandards.includes(left.connectorStandardId);
  }
}

export const DEFAULT_CONNECTOR_LIBRARY = new ConnectorLibrary();
