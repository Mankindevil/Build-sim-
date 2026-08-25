import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { stableDefinition, validateSkillManifest } from "./contract-validation";
import type { AgentSkillManifest, LoadedAgentSkill } from "./contracts";
import type { AgentToolRegistry } from "./tool-registry";

export interface AgentSkillCatalogEntry {
  manifest: AgentSkillManifest;
  definitionHash: string;
}

interface DiscoveredSkill extends AgentSkillCatalogEntry {
  file: string;
}

const MANIFEST_KEYS = new Set([
  "contractVersion", "id", "name", "version", "description", "allowedTools", "readOnly", "contextBudget", "triggers",
]);

function scalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed) as string;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function parseSkillFile(raw: string, file: string): { manifest: AgentSkillManifest; instructions: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`Agent Skill must start with frontmatter: ${file}`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`Agent Skill frontmatter is not closed: ${file}`);
  const record: Record<string, unknown> = {};
  let activeArray: string | null = null;
  for (const sourceLine of normalized.slice(4, end).split("\n")) {
    const line = sourceLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item) {
      if (!activeArray) throw new Error(`Agent Skill array item has no key: ${file}`);
      (record[activeArray] as unknown[]).push(scalar(item[1]!));
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/);
    if (!pair) throw new Error(`Unsupported Agent Skill frontmatter syntax: ${file}`);
    const key = pair[1]!;
    if (!MANIFEST_KEYS.has(key)) throw new Error(`Unknown Agent Skill manifest field ${key}: ${file}`);
    if (key in record) throw new Error(`Duplicate Agent Skill manifest field ${key}: ${file}`);
    const value = pair[2];
    if (value === undefined || value === "") {
      record[key] = [];
      activeArray = key;
    } else {
      record[key] = scalar(value);
      activeArray = null;
    }
  }
  const instructions = normalized.slice(end + 5).trim();
  if (!instructions) throw new Error(`Agent Skill instructions are empty: ${file}`);
  return { manifest: record as unknown as AgentSkillManifest, instructions };
}

export class AgentSkillLoader {
  private discovered: Map<string, DiscoveredSkill> | null = null;

  constructor(private readonly root: string, private readonly tools: AgentToolRegistry) {}

  private async scan(): Promise<Map<string, DiscoveredSkill>> {
    if (this.discovered) return this.discovered;
    const entries = await readdir(this.root, { withFileTypes: true });
    const discovered = new Map<string, DiscoveredSkill>();
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(this.root, entry.name, "SKILL.md");
      const parsed = parseSkillFile(await readFile(file, "utf8"), file);
      const errors = validateSkillManifest(parsed.manifest, new Set(this.tools.names()));
      if (errors.length) throw new Error(`Invalid Agent Skill ${parsed.manifest.id || entry.name}: ${errors.join("; ")}`);
      if (entry.name !== parsed.manifest.id) throw new Error(`Agent Skill directory must match id: ${file}`);
      if (discovered.has(parsed.manifest.id)) throw new Error(`Duplicate Agent Skill: ${parsed.manifest.id}`);
      const instructionBytes = Buffer.byteLength(parsed.instructions);
      if (instructionBytes > parsed.manifest.contextBudget) throw new Error(`Agent Skill exceeds contextBudget: ${parsed.manifest.id}`);
      const definitionHash = createHash("sha256")
        .update(stableDefinition({ manifest: parsed.manifest, instructions: parsed.instructions }))
        .digest("hex");
      discovered.set(parsed.manifest.id, { manifest: parsed.manifest, definitionHash, file });
    }
    this.discovered = discovered;
    return discovered;
  }

  async catalog(): Promise<AgentSkillCatalogEntry[]> {
    const discovered = await this.scan();
    return [...discovered.values()].map(({ manifest, definitionHash }) => ({ manifest: structuredClone(manifest), definitionHash }));
  }

  async load(skillId: string): Promise<LoadedAgentSkill> {
    const discovered = (await this.scan()).get(skillId);
    if (!discovered) throw new Error(`Unknown Agent Skill: ${skillId}`);
    const parsed = parseSkillFile(await readFile(discovered.file, "utf8"), discovered.file);
    const definitionHash = createHash("sha256")
      .update(stableDefinition({ manifest: parsed.manifest, instructions: parsed.instructions }))
      .digest("hex");
    if (definitionHash !== discovered.definitionHash) throw new Error(`Agent Skill changed after discovery: ${skillId}`);
    return { manifest: structuredClone(parsed.manifest), instructions: parsed.instructions, definitionHash };
  }
}
