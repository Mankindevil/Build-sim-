# U0 universal build fixtures

These fixtures are declarative, offline, and product-agnostic. They freeze input
facts and expected verdicts for the U0 contract; they are not an evaluator
implementation and do not assert that any runtime currently supports the
listed capability.

Each JSON file uses `u0.fixture/1.0.0` and contains:

- `input`: a raw frozen domain payload: `BuildConfigV3` where the scenario owns
  hardware, or requirement, evidence, simulation, job, portability, price,
  storage, execution, or Doctor inputs for capability-specific fixtures;
- `expected.decisions`: domain verdicts (`pass`, `fail`, or `blocked`);
- `expected.requirements`: explicit hard/soft requirements or residuals;
- `expected.invariants`: assertions that must remain true across evaluators.

Resolved hardware uses stable synthetic `fixture.*` SKUs from
`u0-generic-catalog-fact-snapshot.json`; identity claims, variant facts and
price bindings must resolve through that same offline catalog/FactSnapshot.
The namespace is deliberately non-production and never claims owned/paid or
official evidence. Unknown safety-critical facts never produce a green verdict.
`v2-empty.json` and `v2-jonsbo-n6.json` are historical migration fixtures and
are retained unchanged.

`manifest.json` is the offline index and coverage matrix. U0 validators and the
independent negative-case oracle reject malformed or internally inconsistent
inputs; the oracle is not the future authoritative evaluator. U6 must run these
same immutable inputs through the production evaluator and may add derived
facts, domain hashes, or artifacts, but must not mutate the inputs or reinterpret
`blocked` as `pass`.
