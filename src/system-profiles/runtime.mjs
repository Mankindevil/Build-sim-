import { sha256Utf8Runtime } from "../hash/sha256-runtime.mjs";

const PROFILE_IDS = new Set([
  "system.windows-11",
  "system.linux-desktop",
  "system.truenas-scale",
  "system.proxmox-ve",
]);
const INTENTS = new Set(["pc", "workstation", "nas"]);
const FAMILIES = new Set(["desktop", "storage", "hypervisor"]);
const CHECKS = new Set([
  "firmware_path", "uefi", "tpm", "secure_boot", "boot_device", "display_path",
  "network_driver", "storage_driver", "hba_it_mode", "ecc", "ipmi",
  "boot_data_separation", "disk_unique_locator",
]);
const RELEASE_OWNERS = new Map([
  ["system-release.windows-11.24h2", "system.windows-11"],
  ["system-release.truenas-scale.25.04", "system.truenas-scale"],
  ["system-release.proxmox-ve.9", "system.proxmox-ve"],
]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields) {
  return record(value) && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}
function strings(value, { nonEmpty = true } = {}) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0)
    && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("system profile contains non-JSON data");
  return encoded;
}

export function validateSystemProfileDefinitionRuntime(value) {
  try {
    const fields = ["schemaVersion", "profileId", "releaseFactId", "label", "family", "machineIntents", "helpRef", "alternativeProfileIds", "requiredChecks", "officialSourceRefs"];
    if (!exact(value, fields)) return ["system profile fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "system-profile-v1" || !PROFILE_IDS.has(value.profileId)) errors.push("system profile identity invalid");
    if (typeof value.releaseFactId !== "string" || value.releaseFactId.length === 0
      || typeof value.label !== "string" || value.label.length === 0) errors.push("system profile release/label invalid");
    if (!strings(value.machineIntents) || value.machineIntents.some((item) => !INTENTS.has(item))) errors.push("system profile machine intents invalid");
    if (!strings(value.requiredChecks) || value.requiredChecks.some((item) => !CHECKS.has(item))) errors.push("system profile required checks invalid");
    if (!strings(value.officialSourceRefs) || value.officialSourceRefs.some((ref) => !ref.startsWith("official:"))) errors.push("system profile official sources invalid");
    if (typeof value.helpRef !== "string" || value.helpRef !== `help.${value.profileId}`) errors.push("system profile helpRef invalid");
    if (!strings(value.alternativeProfileIds) || value.alternativeProfileIds.some((id) => !PROFILE_IDS.has(id) || id === value.profileId)) errors.push("system profile alternatives invalid");
    if (!FAMILIES.has(value.family)) errors.push("system profile family invalid");
    const releaseOwner = RELEASE_OWNERS.get(value.releaseFactId);
    if (releaseOwner !== undefined && releaseOwner !== value.profileId) errors.push("system profile release belongs to another profile");
    return errors;
  } catch { return ["system profile is inaccessible or invalid"]; }
}

export function validateSystemProfileRegistryRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "profiles"]) || value.schemaVersion !== "system-profile-registry-v1"
      || !Array.isArray(value.profiles) || value.profiles.length === 0) return ["system profile registry shape invalid"];
    const errors = value.profiles.flatMap((profile, index) => validateSystemProfileDefinitionRuntime(profile).map((error) => `profiles.${index}: ${error}`));
    const ids = value.profiles.map((profile) => profile?.profileId);
    if (new Set(ids).size !== ids.length) errors.push("system profile registry IDs must be unique");
    return errors;
  } catch { return ["system profile registry is inaccessible or invalid"]; }
}

export function systemProfileRegistryContentHashRuntime(value) {
  try {
    if (validateSystemProfileRegistryRuntime(value).length > 0) return null;
    return sha256Utf8Runtime(`buildsim:system-profile-registry:${canonicalJson(value)}`);
  } catch { return null; }
}

export function validateWorkspaceSystemProfilePayloadRuntime(value) {
  try {
    if (!exact(value, ["schemaVersion", "registry", "registryHash", "supportedPlanSchemas", "sources"])
      || value.schemaVersion !== "workspace-system-profile-v2") return ["workspace system profile payload fields invalid"];
    const errors = validateSystemProfileRegistryRuntime(value.registry);
    const expectedHash = systemProfileRegistryContentHashRuntime(value.registry);
    if (expectedHash === null || value.registryHash !== expectedHash) errors.push("workspace system profile registry hash invalid");
    if (!strings(value.supportedPlanSchemas)
      || value.supportedPlanSchemas.length !== 2
      || !value.supportedPlanSchemas.includes("2.0.0")
      || !value.supportedPlanSchemas.includes("3.0.0")) errors.push("workspace system profile supported schemas invalid");
    if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.some((source) => !exact(source, ["moduleId", "bytes"])
      || typeof source.moduleId !== "string" || source.moduleId.length === 0 || typeof source.bytes !== "string" || source.bytes.length === 0)
      || new Set(value.sources.map(({ moduleId }) => moduleId)).size !== value.sources.length) errors.push("workspace system profile sources invalid");
    const dataSources = Array.isArray(value.sources) ? value.sources.filter(({ moduleId }) => moduleId === "data/systems/profiles") : [];
    if (dataSources.length !== 1) errors.push("workspace system profile registry source missing or duplicated");
    else {
      try {
        if (canonicalJson(JSON.parse(dataSources[0].bytes)) !== canonicalJson(value.registry)) errors.push("workspace system profile registry differs from locked source bytes");
      } catch { errors.push("workspace system profile registry source is not JSON"); }
    }
    return errors;
  } catch { return ["workspace system profile payload is inaccessible or invalid"]; }
}

export function workspaceSystemProfileReferencesRuntime(value) {
  if (validateWorkspaceSystemProfilePayloadRuntime(value).length > 0) return null;
  return value.registry.profiles.flatMap((profile) => profile.officialSourceRefs.map((sourceRef) => ({
    ref: sourceRef,
    necessity: "informational",
  })));
}
