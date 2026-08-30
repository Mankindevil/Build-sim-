import type { FacetPredicate } from "../requirements/contracts";
import type { LogicalLayoutSelection, VdevTopology } from "../topology/contracts";
import type { StorageLayoutEvaluation } from "./contracts";
import { minimumDiskCount } from "./capacity";

const predicates = (): FacetPredicate[] => [];

export function deriveExpansionOptions(selection: LogicalLayoutSelection): StorageLayoutEvaluation["expansionOptions"] {
  const options: StorageLayoutEvaluation["expansionOptions"] = [];
  const seen = new Set<VdevTopology>();
  for (const vdev of selection.vdevs) {
    if (seen.has(vdev.topology)) continue;
    seen.add(vdev.topology);
    options.push({
      optionId: `expansion.add-vdev.${vdev.topology}`,
      operation: "add_vdev",
      requiredInstanceCount: minimumDiskCount(vdev.topology),
      constraints: predicates(),
      riskDecisionIds: [`decision.storage.expansion.${vdev.topology}`],
    });
    options.push({
      optionId: `expansion.replace-drives.${vdev.topology}`,
      operation: "replace_drives",
      requiredInstanceCount: vdev.diskInstanceIds.length,
      constraints: predicates(),
      riskDecisionIds: [`decision.storage.resilver.${vdev.vdevId}`],
    });
  }
  options.push({
    optionId: "expansion.add-spare",
    operation: "add_spare",
    requiredInstanceCount: 1,
    constraints: predicates(),
    riskDecisionIds: ["decision.storage.spare.not-capacity"],
  });
  return options.sort((left, right) => left.optionId.localeCompare(right.optionId));
}
