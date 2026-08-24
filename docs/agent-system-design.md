# Build Sim Agent System

Status: A0-A7 implemented. Final gate evidence and unverified live-provider boundaries are listed in `agent-implementation-matrix.md`.

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

`ProviderAdapter.createTurn()` consumes internal messages and tool definitions and returns normalized text, tool calls, usage, stop reason, model, provider request id, and latency. DeepSeek Chat Completions and Claude Messages wire formats stay inside their respective adapters. Claude is registered only when explicitly enabled and configured; otherwise it does not appear as an unusable model option.

## Initial tools

| Tool | Effect | Initial state |
|---|---|---|
| `get_build_evaluation` | read | implemented A3 |
| `compare_builds` | read | implemented A3 |
| `get_sku_facts` | read | implemented A3 |
| `get_price_snapshot` | read | implemented A3 |
| `search_official_catalog` | external-read | implemented A3 |
| `inspect_catalog_candidate` | external-read | implemented A3 |
| `search_price_candidates` | external-read | implemented A3 |

A3 implementation registers these seven Tools as read-only, exposes their definition hashes in `/api/agent/tools`, and applies strict input schemas, per-Tool timeouts/result budgets, per-run turn/call/repetition budgets, cancellation, and structured error results. External-read Tools connect only to the fixed local catalog/price service and retain candidate/unaudited labels.

Write tools are not exposed in the initial release.

## Initial skills

| Skill | Allowed capability |
|---|---|
| `build-diagnosis` | evaluation and SKU evidence |
| `upgrade-advisor` | evaluation, comparison, SKU and price snapshots |
| `shopping-research` | official catalog and price candidates |
| `assembly-and-wiring` | deterministic evaluation projection |

Skill metadata is discovered first. Instructions are loaded only after activation and included in the skill definition hash.

A4 implements a strict frontmatter parser, manifest validation against the live Tool registry, directory/id matching, context-budget enforcement, definition-integrity checks, metadata-only `/api/agent/skills` discovery, and per-run activation. An activated Skill contributes its instructions to the system context and restricts both provider-visible Tool definitions and dispatcher authorization to `allowedTools`. All four built-in Skills are read-only.

## Delivery gates

- A0: contracts, design, baseline and contract tests.
- A1: server/browser evaluation parity.
- A2: persistent multi-turn DeepSeek streaming chat with cancellation and usage. Implemented with provider fixtures and local disabled-provider HTTP/SSE smoke; live provider behavior remains unverified without an enabled key.
- A3: registry, schema validation, dispatcher, budgets and seven read-only tools.
- A4: lazy Skill loader and four built-in skills. Implemented with manifest/hash/integrity tests and runtime enforcement of `allowedTools`.
- A5: real chat UI and browser end-to-end flow. Implemented with model/Skill selection, current BuildConfig snapshots, persistent sessions, SSE text/Tool/usage events, cancellation, disabled-service handling, desktop/mobile QA, and a local DeepSeek-protocol fixture. The fixture is not live-provider evidence.
- A6: audit, redaction, definition hashes and write-approval contract; writes remain disabled. Implemented with atomic `0600` run records, content hashes rather than raw prompts/results, credential-shaped redaction, integrity verification, a read-only audit endpoint, and a short-lived execution-bound approval envelope contract. The Tool dispatcher still rejects every write Tool.
- A7: Claude fixture adapter contract, full regression, browser QA, secret scan, documentation and implementation matrix. Implemented against Anthropic's official Messages streaming event flow and client Tool content blocks; live Claude remains unverified without an enabled key.

Each stage requires its focused tests plus the full test suite, typecheck, production build, an independent commit, push, and remote-ref equality check. A failed gate stops the sequence.
