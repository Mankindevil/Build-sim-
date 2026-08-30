import type { FileArtifactRepository } from "../artifacts/repository.mjs";
import type { ReplayableInferenceTrace } from "./inference-policy";
import type { GovernedInferenceRuleArtifact } from "./inference-candidate-runtime.mjs";

export const GOVERNED_INFERENCE_RULE_MEDIA_TYPE: "application/vnd.buildsim.inference-rule+json";
export const GOVERNED_INFERENCE_RULE_ARTIFACT_KIND: "fact-inference-rule";
export const GOVERNED_INFERENCE_IMPLEMENTATION_MEDIA_TYPE: "application/javascript";
export const GOVERNED_INFERENCE_IMPLEMENTATION_ARTIFACT_KIND: "fact-inference-rule-implementation";

export interface GovernedInferenceArtifactRegistrationAuthority {
  readonly ruleId: string;
  readonly implementationId: string;
  readonly implementationHash: string;
  readonly artifactRef: `sha256:${string}`;
  readonly execute: (...args: never[]) => unknown;
}

export type GovernedInferenceArtifactInspection = Readonly<
  | { ok: false; reason: string }
  | {
    ok: true;
    artifactHash: string;
    artifactRef: `sha256:${string}`;
    implementationRef: `sha256:${string}`;
    rule: GovernedInferenceRuleArtifact;
  }
>;

export function inspectGovernedInferenceArtifactAtRoot(input: {
  artifacts: FileArtifactRepository;
  activeRoot: string;
  artifactRef: `sha256:${string}`;
  trace?: ReplayableInferenceTrace;
  registration?: GovernedInferenceArtifactRegistrationAuthority;
}): Promise<GovernedInferenceArtifactInspection>;
