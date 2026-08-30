import type { AgentToolContext } from "../agent/contracts";
import type { ProvisionalCaseAdapterApprovalInput } from "./runtime-registry-repository";
import { RuntimeCaseAdapterRegistryRepository } from "./runtime-registry-repository";
import type { RootBoundProvisionalCaseAdapterAuthority } from "./provisional";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";

/**
 * Narrow production action consumed by the Agent write Tool. The caller input
 * is never treated as authority: approve() re-reads the candidate, current
 * plan/facts/job/registry CAS and the branded durable proof inside one writer.
 */
export function createProductionProvisionalCaseAdapterActions(options: {
  coordinator: RuntimeCoordinator;
  authority: RootBoundProvisionalCaseAdapterAuthority;
  now?: () => string;
}): {
  registerProvisionalCaseAdapter(input: ProvisionalCaseAdapterApprovalInput, context: AgentToolContext): Promise<unknown>;
} {
  const registry = new RuntimeCaseAdapterRegistryRepository(
    options.coordinator,
    options.authority,
    options.now,
  );
  return Object.freeze({
    async registerProvisionalCaseAdapter(input: ProvisionalCaseAdapterApprovalInput, context: AgentToolContext) {
      if (!context.writeApprovalProof) throw new Error("server-issued durable Agent approval proof is required");
      return registry.approve(input.candidateId, context.writeApprovalProof);
    },
  });
}
