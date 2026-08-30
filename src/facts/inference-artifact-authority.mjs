import { sha256Bytes } from "../runtime/fs.mjs";
import { validateGovernedInferenceRuleArtifactRuntime } from "./inference-candidate-runtime.mjs";

export const GOVERNED_INFERENCE_RULE_MEDIA_TYPE = "application/vnd.buildsim.inference-rule+json";
export const GOVERNED_INFERENCE_RULE_ARTIFACT_KIND = "fact-inference-rule";
export const GOVERNED_INFERENCE_IMPLEMENTATION_MEDIA_TYPE = "application/javascript";
export const GOVERNED_INFERENCE_IMPLEMENTATION_ARTIFACT_KIND = "fact-inference-rule-implementation";

function failed(reason) { return Object.freeze({ ok: false, reason }); }

/**
 * Verifies the complete root-bound rule -> executable artifact closure. When a
 * registration is supplied, the exact executable function bytes are also
 * pinned to the production allowlist rather than merely trusting metadata.
 */
export async function inspectGovernedInferenceArtifactAtRoot({
  artifacts,
  activeRoot,
  artifactRef,
  trace,
  registration,
}) {
  try {
    const match = /^sha256:([a-f0-9]{64})$/.exec(String(artifactRef ?? ""));
    if (!match || !artifacts || typeof artifacts.repositoryRoot !== "function" || typeof artifacts.getAt !== "function") {
      return failed("governed inference artifact request is invalid");
    }
    const artifactRoot = await artifacts.repositoryRoot(activeRoot);
    const artifact = await artifacts.getAt(artifactRoot, artifactRef, { initialize: false });
    if (!artifact || artifact.record.kind !== GOVERNED_INFERENCE_RULE_ARTIFACT_KIND
      || artifact.record.mediaType !== GOVERNED_INFERENCE_RULE_MEDIA_TYPE
      || artifact.record.privacyClass !== "runtime_internal" || artifact.record.sha256 !== match[1]
      || sha256Bytes(Buffer.from(artifact.bytes)) !== match[1]) {
      return failed("governed inference rule artifact metadata/bytes are invalid");
    }
    let rule;
    try { rule = JSON.parse(Buffer.from(artifact.bytes).toString("utf8")); }
    catch { return failed("governed inference rule artifact is not valid JSON"); }
    const errors = validateGovernedInferenceRuleArtifactRuntime(rule);
    if (errors.length) return failed(errors.join("; "));
    if (trace && (trace.engine !== "rule" || trace.ruleOrModelArtifactHash !== match[1]
      || trace.ruleOrModelId !== rule.ruleId || trace.ruleOrModelVersion !== rule.ruleVersion)) {
      return failed("governed inference trace identity/version does not match its rule artifact");
    }
    if (registration && (registration.artifactRef !== artifactRef || registration.ruleId !== rule.ruleId
      || registration.implementationId !== rule.implementationId
      || registration.implementationHash !== rule.implementationHash || typeof registration.execute !== "function")) {
      return failed("governed inference rule is not the allowlisted executable registration");
    }
    const implementationRef = `sha256:${rule.implementationHash}`;
    if (!Array.isArray(artifact.record.references) || artifact.record.references.length !== 1
      || artifact.record.references[0]?.ref !== implementationRef
      || artifact.record.references[0]?.necessity !== "required_for_replay") {
      return failed("governed inference rule does not bind one required executable artifact");
    }
    const implementation = await artifacts.getAt(artifactRoot, implementationRef, { initialize: false });
    if (!implementation || implementation.record.kind !== GOVERNED_INFERENCE_IMPLEMENTATION_ARTIFACT_KIND
      || implementation.record.mediaType !== GOVERNED_INFERENCE_IMPLEMENTATION_MEDIA_TYPE
      || implementation.record.privacyClass !== "runtime_internal"
      || implementation.record.sha256 !== rule.implementationHash
      || sha256Bytes(Buffer.from(implementation.bytes)) !== rule.implementationHash) {
      return failed("governed inference executable artifact metadata/bytes are invalid");
    }
    if (registration) {
      const executableBytes = Buffer.from(Function.prototype.toString.call(registration.execute), "utf8");
      if (sha256Bytes(executableBytes) !== rule.implementationHash
        || !Buffer.from(implementation.bytes).equals(executableBytes)) {
        return failed("governed inference executable bytes differ from the production allowlist");
      }
    }
    return Object.freeze({
      ok: true,
      artifactHash: match[1],
      artifactRef,
      implementationRef,
      rule: structuredClone(rule),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : "governed inference artifact inspection failed");
  }
}
