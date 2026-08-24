# Build Sim Agent System

Status: A0 contract baseline. This document defines the target and gates; it is not implementation evidence.

## Goal

Build a provider-neutral, auditable PC-build agent. DeepSeek is the first live provider. Claude must fit through the same internal contracts later. The deterministic `BuildEvaluation` remains authoritative for fit, wiring, power, thermal, BOM, physical, calibration, price, and unknown facts.

## Non-negotiable boundaries

1. Provider keys are server-only and never use a `VITE_` prefix.
2. The server recomputes `BuildEvaluation` from a validated `BuildConfig`; model-authored or browser-authored verdicts are never trusted.
3. Models may explain, compare, prioritize, and propose. They cannot downgrade `bad`, fill `unknown`, invent numbers, or silently mutate platform state.
4. Tools are typed atomic capabilities. Skills are lazy-loaded instructions that can only call their declared `allowedTools`.
5. Read tools are the initial release. Every future write tool requires an out-of-band approval token, idempotency key, audit entry, backup, and rollback data.
6. Tool inputs reject additional properties. Tool results are bounded, redacted, provenance-labelled, and never executed as instructions.
7. Every provider turn and tool call is constrained by time, count, repetition, result-size, and cancellation budgets.

## Provider boundary

`ProviderAdapter.createTurn()` consumes internal messages and tool definitions and returns normalized text, tool calls, usage, stop reason, model, provider request id, and latency. DeepSeek Chat Completions and Claude Messages wire formats stay inside their respective adapters.

## Initial tools

| Tool | Effect | Initial state |
|---|---|---|
| `get_build_evaluation` | read | planned A3 |
| `compare_builds` | read | planned A3 |
| `get_sku_facts` | read | planned A3 |
| `get_price_snapshot` | read | planned A3 |
| `search_official_catalog` | external-read | planned A3 |
| `inspect_catalog_candidate` | external-read | planned A3 |
| `search_price_candidates` | external-read | planned A3 |

Write tools are not exposed in the initial release.

## Initial skills

| Skill | Allowed capability |
|---|---|
| `build-diagnosis` | evaluation and SKU evidence |
| `upgrade-advisor` | evaluation, comparison, SKU and price snapshots |
| `shopping-research` | official catalog and price candidates |
| `assembly-and-wiring` | deterministic evaluation projection |

Skill metadata is discovered first. Instructions are loaded only after activation and included in the skill definition hash.

## Delivery gates

- A0: contracts, design, baseline and contract tests.
- A1: server/browser evaluation parity.
- A2: persistent multi-turn DeepSeek streaming chat with cancellation and usage.
- A3: registry, schema validation, dispatcher, budgets and seven read-only tools.
- A4: lazy Skill loader and four built-in skills.
- A5: real chat UI and browser end-to-end flow.
- A6: audit, redaction, definition hashes and write-approval contract; writes remain disabled.
- A7: Claude fixture adapter contract, full regression, browser QA, secret scan, documentation and implementation matrix.

Each stage requires its focused tests plus the full test suite, typecheck, production build, an independent commit, push, and remote-ref equality check. A failed gate stops the sequence.
