/**
 * Versioned production handler manifest. Runtime composition loads the TypeScript
 * handler factory from src/evidence/jobs; this JS manifest is intentionally data
 * only so deploy/doctor tooling can inspect owned types without executing jobs.
 */
export const EVIDENCE_PIPELINE_HANDLER_MANIFEST = Object.freeze({
  schemaVersion: "evidence-job-handler-manifest-v1",
  handlerVersion: "1",
  handlers: Object.freeze([
    Object.freeze({ stage: "official_discovery", type: "evidence.official.discovery", networkRequired: true }),
    Object.freeze({ stage: "official_acquisition", type: "evidence.official.acquire", networkRequired: true }),
    Object.freeze({ stage: "archive", type: "evidence.archive", networkRequired: false }),
    Object.freeze({ stage: "parse_ocr", type: "evidence.parse-ocr", networkRequired: false }),
    Object.freeze({ stage: "excerpt", type: "evidence.excerpt", networkRequired: false }),
    Object.freeze({ stage: "claim_extraction", type: "evidence.claim.extract", networkRequired: false }),
    Object.freeze({ stage: "third_party_fallback", type: "evidence.third-party.fallback", networkRequired: true }),
    Object.freeze({ stage: "fact_impact", type: "evidence.fact-impact", networkRequired: false }),
    Object.freeze({ stage: "adapter_generation", type: "evidence.adapter.generate", networkRequired: false }),
    Object.freeze({ stage: "binding_proposal", type: "evidence.binding.propose", networkRequired: false }),
  ]),
});
