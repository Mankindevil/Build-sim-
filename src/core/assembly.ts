import type { EngineFinding } from "./engine";
import type { EvidenceLevel } from "./evidence";
import { AXES, overlapOn, type Axis, type CenteredBox, type PlacedPart } from "./geometry";
import type { RoutedCable } from "./routing";

/**
 * Assembly order, derived rather than written down.
 *
 * Three inputs decide it. The `mountedOn` tree says a part cannot go in before
 * whatever it bolts to. An **install sweep** — the corridor a part travels
 * through on its way to its seat — says that whatever sits in that corridor has
 * to go in *later*. The routed cables say a plug that something will cover has
 * to be connected before the cover arrives.
 *
 * Everything the manual states outright stays a *declared* rule in
 * `assembly.json` with its section number, because a published instruction is
 * better evidence than any reconstruction of ours: §13.1 says the left fan
 * bracket comes off before the backplane is wired, and the bracket we
 * reconstructed does not actually block those inlets. Declared and derived
 * constraints then order the same graph, each carrying its own evidence.
 *
 * The module answers with a sequence and, where a sequence cannot exist, says
 * so. It never claims a build is impossible on the strength of a reconstructed
 * anchor: an unsatisfiable loop is reported as a loop for someone to check.
 */

export type InstallAxis = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export interface InstallTravelDecl {
  /** Part id, or an id prefix (`ram.`) covering a family. */
  match: string;
  axis: InstallAxis;
  /** Travel in mm, or `"self"` for the part's own extent along that axis. */
  travelMm: number | "self";
  source: string;
}

export interface PreinstalledDecl {
  match: string;
  /** True only where the manual documents taking it off again. */
  removable: boolean;
  source: string;
}

export interface DeclaredRule {
  id: string;
  /** Step id or step-id prefix, e.g. `off:fan.left_bracket`, `plug:run.backplane.power`. */
  before: string;
  after: string;
  evidence: EvidenceLevel;
  source: string;
}

export interface AssemblyDecls {
  preinstalled: PreinstalledDecl[];
  install: InstallTravelDecl[];
  declared: DeclaredRule[];
}

export type StepKind = "part" | "plug" | "remove" | "refit";

export interface AssemblyStep {
  /** `part:<partId>`, `plug:<cableId>@<portId>`, `off:<partId>`, `on:<partId>`. */
  id: string;
  kind: StepKind;
  label: string;
  partId?: string;
  cableId?: string;
  portId?: string;
  /** Why it cannot come any earlier, in the words of the constraints on it. */
  reasons: string[];
  /** Set when the step sits in a loop no order can satisfy. */
  deadlocked?: boolean;
}

export type ConstraintKind =
  | "mount"
  | "socket"
  | "clearance"
  | "access"
  /** Straight from the manual, carrying its section number as the reason. */
  | "declared"
  /** Puts a removed part back once the work that needed it off is done. */
  | "refit";

export interface OrderConstraint {
  before: string;
  after: string;
  kind: ConstraintKind;
  reason: string;
  evidence: EvidenceLevel;
}

export interface AssemblyPlan {
  /** Steps in one satisfying order; deadlocked ones are appended and marked. */
  steps: AssemblyStep[];
  constraints: OrderConstraint[];
  findings: EngineFinding[];
}

export interface AssemblyInput extends AssemblyDecls {
  parts: PlacedPart[];
  cables: RoutedCable[];
}

/** Kinds that are volumes or reservations, not things anybody installs. */
const NOT_A_STEP = new Set(["clearance", "conflict", "reserve", "empty", "connector"]);

const AXIS_OF: Record<InstallAxis, Axis> = {
  "+x": "x",
  "-x": "x",
  "+y": "y",
  "-y": "y",
  "+z": "z",
  "-z": "z",
};
const SIZE: Record<Axis, "w" | "h" | "d"> = { x: "w", y: "h", z: "d" };
const INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

function matches(id: string, pattern: string): boolean {
  return id === pattern || id.startsWith(pattern);
}

/**
 * The corridor a part passes through on its way in: its own cross-section,
 * extruded from the face it enters by outward the declared travel. The final
 * seat is *not* included — something sitting there is a collision, which the
 * occupancy engine already owns; something in the corridor is an ordering
 * question, which is this module's.
 */
export function installSweep(part: PlacedPart, decl: InstallTravelDecl): CenteredBox {
  const axis = AXIS_OF[decl.axis];
  const i = INDEX[axis];
  const sign = decl.axis.startsWith("+") ? 1 : -1;
  const extent = part.box[SIZE[axis]];
  const travel = decl.travelMm === "self" ? extent : decl.travelMm;
  const c = [...part.box.c] as [number, number, number];
  c[i] += (sign * (extent + travel)) / 2;
  const box: CenteredBox = { c, w: part.box.w, h: part.box.h, d: part.box.d };
  box[SIZE[axis]] = travel;
  return box;
}

function overlapsBy(a: CenteredBox, b: CenteredBox, tol: number): number {
  let least = Infinity;
  for (const axis of AXES) {
    const o = overlapOn(a, b, axis);
    if (o <= tol) return 0;
    least = Math.min(least, o);
  }
  return least;
}

/** Parent chain, so a part is never asked to go in before its own subassembly. */
function family(part: PlacedPart, byId: Map<string, PlacedPart>): Set<string> {
  const ids = new Set<string>([part.id]);
  let cursor: PlacedPart | undefined = part;
  while (cursor?.mountedOn) {
    ids.add(cursor.mountedOn);
    cursor = byId.get(cursor.mountedOn);
  }
  for (const other of byId.values()) {
    let up: PlacedPart | undefined = other;
    while (up?.mountedOn) {
      if (up.mountedOn === part.id) {
        ids.add(other.id);
        break;
      }
      up = byId.get(up.mountedOn);
    }
  }
  return ids;
}

function sameGroup(a: PlacedPart, b: PlacedPart): boolean {
  return a.group !== undefined && a.group === b.group;
}

export function buildAssembly(input: AssemblyInput): AssemblyPlan {
  const { parts, cables } = input;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const preinstalled = new Map<string, PreinstalledDecl>();
  for (const part of parts) {
    const decl = input.preinstalled.find((d) => matches(part.id, d.match));
    if (decl) preinstalled.set(part.id, decl);
  }

  const steps = new Map<string, AssemblyStep>();
  const constraints: OrderConstraint[] = [];
  const findings: EngineFinding[] = [];
  const weight = new Map<string, number>();

  const installable = parts.filter((p) => !NOT_A_STEP.has(p.kind) && !preinstalled.has(p.id));
  installable.forEach((part, i) => {
    const id = `part:${part.id}`;
    steps.set(id, { id, kind: "part", label: part.name, partId: part.id, reasons: [] });
    weight.set(id, i * 10);
  });

  const partBase = installable.length * 10;
  cables.forEach((cable, ci) => {
    [cable.from, cable.to].forEach((port, ei) => {
      const id = `plug:${cable.id}@${port.id}`;
      const owner = byId.get(port.partId);
      steps.set(id, {
        id,
        kind: "plug",
        label: `${cable.label} · ${owner?.name ?? port.partId} 端`,
        cableId: cable.id,
        portId: port.id,
        reasons: [],
      });
      weight.set(id, partBase + ci * 10 + ei);
      if (steps.has(`part:${port.partId}`)) {
        constraints.push({
          before: `part:${port.partId}`,
          after: id,
          kind: "socket",
          reason: `插座在${owner?.name ?? port.partId}上，它得先到位`,
          evidence: "standard",
        });
      }
    });
  });

  // Steps that need a pre-installed part off first; each entry becomes an
  // off/refit pair around the work, which is what "先拆再装回" actually is.
  const needsOff = new Map<string, { decl: PreinstalledDecl; steps: Set<string>; evidence: EvidenceLevel }>();
  const requireOff = (
    partId: string,
    stepId: string,
    kind: ConstraintKind,
    reason: string,
    evidence: EvidenceLevel,
  ): void => {
    const decl = preinstalled.get(partId);
    if (!decl?.removable) return;
    const entry = needsOff.get(partId) ?? { decl, steps: new Set<string>(), evidence };
    entry.steps.add(stepId);
    needsOff.set(partId, entry);
    constraints.push({ before: `off:${partId}`, after: stepId, kind, reason, evidence });
  };

  // ---- mounting: a child cannot precede what it bolts to -------------------
  for (const part of installable) {
    const parent = part.mountedOn;
    if (!parent || !steps.has(`part:${parent}`)) continue;
    constraints.push({
      before: `part:${parent}`,
      after: `part:${part.id}`,
      kind: "mount",
      reason: `${part.name}装在${byId.get(parent)?.name ?? parent}上`,
      evidence: part.anchorEvidence,
    });
  }

  // ---- install corridors: whatever stands in one goes in later -------------
  const serviceTraps = new Map<string, { blocker: PlacedPart; parts: PlacedPart[]; depthMm: number }>();
  for (const part of installable) {
    const decl = input.install.find((d) => matches(part.id, d.match));
    if (!decl) continue;
    const sweep = installSweep(part, decl);
    const kin = family(part, byId);
    for (const other of parts) {
      if (other.id === part.id || kin.has(other.id) || NOT_A_STEP.has(other.kind)) continue;
      if (sameGroup(part, other)) continue;
      const depth = overlapsBy(sweep, other.box, 1);
      if (depth === 0) continue;
      const reason = `${other.name}压在${part.name}的装入行程上（约 ${Math.round(depth)}mm）`;
      if (steps.has(`part:${other.id}`)) {
        constraints.push({
          before: `part:${part.id}`,
          after: `part:${other.id}`,
          kind: "clearance",
          reason,
          evidence: "inferred",
        });
        const trap = serviceTraps.get(other.id) ?? { blocker: other, parts: [], depthMm: 0 };
        trap.parts.push(part);
        trap.depthMm = Math.max(trap.depthMm, depth);
        serviceTraps.set(other.id, trap);
      } else if (preinstalled.get(other.id)?.removable) {
        requireOff(other.id, `part:${part.id}`, "clearance", reason, "inferred");
      } else if (preinstalled.has(other.id)) {
        findings.push({
          id: `assembly.corridor-blocked:${part.id}`,
          verdict: "warn",
          evidence: "inferred",
          message: `${part.name}的装入行程被固定结构「${other.name}」占住约 ${Math.round(depth)}mm，且手册没有拆它的步骤——装入行程是推算值，需实物核对`,
          related: [part.id, other.id],
        });
      }
    }
  }

  // ---- plug access: connect before the cover arrives ----------------------
  for (const cable of cables) {
    for (const ins of cable.insertion) {
      const stepId = `plug:${cable.id}@${ins.portId}`;
      for (const block of ins.blocks) {
        const reason = `${block.partName}挡住 ${ins.portId} 的插拔空间 ${block.depthMm}mm，线要先接`;
        if (steps.has(`part:${block.partId}`)) {
          constraints.push({
            before: stepId,
            after: `part:${block.partId}`,
            kind: "access",
            reason,
            evidence: "inferred",
          });
        } else {
          requireOff(block.partId, stepId, "access", reason, "inferred");
        }
      }
    }
  }

  // ---- declared rules: what the manual says, with its section --------------
  // Declared rules address steps by pattern, with `*` for "any run / any index",
  // so §13.1 can name the backplane end of the power runs and nothing else.
  const expand = (pattern: string): string[] => {
    if (pattern.startsWith("off:") || pattern.startsWith("on:")) return [pattern];
    if (!pattern.includes("*")) return [...steps.keys()].filter((id) => matches(id, pattern));
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return [...steps.keys()].filter((id) => re.test(id));
  };
  for (const rule of input.declared) {
    const befores = expand(rule.before);
    const afters = expand(rule.after);
    for (const before of befores) {
      for (const after of afters) {
        if (before.startsWith("off:")) {
          const partId = before.slice(4);
          if (!preinstalled.get(partId)?.removable) continue;
          requireOff(partId, after, "declared", rule.source, rule.evidence);
          continue;
        }
        if (!steps.has(before) || !steps.has(after)) continue;
        constraints.push({
          before,
          after,
          kind: "declared",
          reason: rule.source,
          evidence: rule.evidence,
        });
      }
    }
  }

  // Off/refit steps exist only where something needed the part out of the way.
  for (const [partId, entry] of needsOff) {
    const part = byId.get(partId)!;
    const first = Math.min(...[...entry.steps].map((s) => weight.get(s) ?? 0));
    const off = `off:${partId}`;
    const on = `on:${partId}`;
    steps.set(off, { id: off, kind: "remove", label: part.name, partId, reasons: [] });
    steps.set(on, { id: on, kind: "refit", label: part.name, partId, reasons: [] });
    weight.set(off, first - 1);
    weight.set(on, first + 0.5);
    for (const stepId of entry.steps) {
      constraints.push({
        before: stepId,
        after: on,
        kind: "refit",
        reason: `${part.name}要等这一步做完才装回`,
        evidence: entry.evidence,
      });
    }
    findings.push({
      id: `assembly.remove-refit:${partId}`,
      verdict: "ok",
      evidence: entry.evidence,
      message: `装机顺序：先拆下「${part.name}」，完成 ${entry.steps.size} 项工序后装回（${entry.decl.source}）`,
      related: [partId],
    });
  }

  // Later servicing is the part a build sheet forgets: if installing A had to
  // precede B, then swapping A afterwards means taking B off again.
  for (const [, trap] of serviceTraps) {
    findings.push({
      id: `assembly.service-order:${trap.blocker.id}`,
      verdict: "warn",
      evidence: "inferred",
      message: `先装 ${trap.parts.map((p) => p.name).join(" / ")}，再装「${trap.blocker.name}」：它压在前者的装入行程上约 ${Math.round(trap.depthMm)}mm，日后单独更换前者要重新拆它（装入行程为推算值）`,
      related: [trap.blocker.id, ...trap.parts.map((p) => p.id)],
    });
  }

  const ordered = topoSort(steps, constraints, weight);
  for (const step of ordered) {
    const reasons = constraints.filter((c) => c.after === step.id).map((c) => c.reason);
    step.reasons = [...new Set(reasons)];
  }
  if (ordered.some((s) => s.deadlocked)) {
    const loop = ordered.filter((s) => s.deadlocked);
    findings.push({
      id: "assembly.deadlock",
      verdict: "warn",
      evidence: "inferred",
      message: `这些工序互相要求对方先做，推不出可行顺序：${loop.map((s) => s.label).join(" / ")}。约束里至少有一条来自推算坐标，需实物核对`,
      related: loop.flatMap((s) => (s.partId ? [s.partId] : [])),
    });
  }

  return { steps: ordered, constraints, findings };
}

/**
 * Kahn's algorithm with a stable tie-break: among steps that are ready, the one
 * with the lowest declared weight goes first, so an unconstrained pair always
 * comes out in the same order. Whatever survives the queue is a loop.
 */
function topoSort(
  steps: Map<string, AssemblyStep>,
  constraints: OrderConstraint[],
  weight: Map<string, number>,
): AssemblyStep[] {
  const indegree = new Map<string, number>([...steps.keys()].map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const c of constraints) {
    if (!steps.has(c.before) || !steps.has(c.after)) continue;
    indegree.set(c.after, (indegree.get(c.after) ?? 0) + 1);
    next.set(c.before, [...(next.get(c.before) ?? []), c.after]);
  }

  const ready = (): string[] =>
    [...indegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => id)
      .sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));

  const out: AssemblyStep[] = [];
  const done = new Set<string>();
  for (;;) {
    const pick = ready()[0];
    if (pick === undefined) break;
    indegree.delete(pick);
    done.add(pick);
    out.push(steps.get(pick)!);
    for (const to of next.get(pick) ?? []) {
      if (!indegree.has(to)) continue;
      indegree.set(to, (indegree.get(to) ?? 1) - 1);
    }
  }

  const left = [...steps.keys()]
    .filter((id) => !done.has(id))
    .sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));
  for (const id of left) out.push({ ...steps.get(id)!, deadlocked: true });
  return out;
}
