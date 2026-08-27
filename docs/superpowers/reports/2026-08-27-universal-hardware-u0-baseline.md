# Universal hardware platform U0 baseline

- Captured: 2026-08-27 UTC
- Branch: `codex/complete-universal-hardware-platform`
- Base commit: `3115748ff979b3cdd1bb4e0ca49e4c67ee9a4bb0`
- User-facing workspace: `/home/linuxuser/Code/build-sim`
- Resolved worktree: `/home/linuxuser/Code/build-sim-releases/9d5d5a4`
- Scope: U0 contract and regression baseline only; this is not a staging or production-release record.

## Working-tree provenance

The branch was created without cleaning the existing worktree. At capture time the
repository already contained 98 modified tracked files and 28 untracked paths.
Those files are preserved as user work. U0 additions are reviewed and tested in
place; no reset, checkout-based discard, force push, production write, or user-data
mutation was performed.

`tests/fixtures/baseline/u0-source-hashes.json` freezes the pre-U0 catalog, case
profile, geometry, routing, assembly, constraints, price snapshot, V2 config and
plan-contract source hashes. `tests/fixtures/builds/v2-empty.json` and
`tests/fixtures/builds/v2-jonsbo-n6.json` freeze the two V2 export shapes.

## Test baseline

The first full Vitest run completed 643 of 644 tests. The sole failing test was
`tests/price-catalog-runtime-routes.test.ts`: the managed sandbox denied a local
`127.0.0.1` listen with `EPERM`. The exact test passed 1/1 when rerun with the
approved loopback permission. This is an execution-environment restriction, not
a product assertion.

After the contract and fixture reviews converged, the managed-sandbox run passed
123/124 files and 744/745 tests; its only failure was the same loopback `EPERM`.
The exact route test then passed 1/1 with approved loopback permission, for a
combined 124 files and 745 assertions with no product failure.

The following checks passed before the U0 checkpoint was cut:

- `npm run typecheck`
- `npm run build`
- `npm run agent:secret-scan` (459 scanned files, zero findings; Git child-process
  access required the approved sandbox permission)
- `git diff --check`
- `npx vitest run tests/platform-cleanup.test.ts` (2/2)
- the U0-focused contract suites and the isolated full browser path

## Browser and UI baseline

`npm run test:platform:browser` ran against a fresh temporary Plan/Evidence/
Transaction root and dedicated Workspace port. Existing services on ports
5174-5176 and persisted production-like state were not touched. The run covered
blank-plan creation, explicit template creation, edit/evaluate/save, duplication,
plan switching, 3D repair routing, approved Agent proposal application,
transaction archive, build-task reconciliation, desktop/tablet/mobile layouts,
mobile completion, refresh persistence and seven actual browser Web Crypto
HashSpec golden vectors for config, requirement, fact, observation, adapter,
simulation model and artifact domains.

Measured on the local Chromium/Vite development lane:

| Metric | Baseline |
|---|---:|
| First usable load | 978 ms |
| Deterministic re-evaluation plus UI settle | 1,045 ms |
| Plan switch | 163 ms |
| 3D initialization/fallback settle | 219 ms |
| Browser HashSpec goldens | 7/7 exact Node/Chromium matches |
| Visible unnamed buttons | 0 |
| Broken labelled dialogs | 0 |
| ARIA live regions | 22 |

The screenshot artifacts were deliberately temporary and removed after the run;
their audit hashes were desktop `d872d3e0a59441637e161fb3619b3e9f6b28c6508c5f780b1ec25114a7c18cd7`,
tablet `ca385a8532066e91ec9595d160a4518e9ea6ede385a2d6a88729d13bb0be6e4b`,
and mobile `e435917cbd60bb94029e9c5cc6a0b0004f2c9d1cdf4bd8c35faf304264efece8`.

The isolated lane intentionally did not start Price or Agent providers. Their Vite
proxy 500/502 diagnostics are an expected degraded-service condition for this
test, not evidence that those services are healthy. Provider and evidence-network
behavior remain later-stage gates.

## Memory-release baseline

Chromium's heap was garbage-collected through CDP immediately before and after a
full page reload that recreated the plan shell, controllers and spatial view:

| Measurement | Bytes |
|---|---:|
| Used heap before reload | 13,603,200 |
| Used heap after reload | 10,048,720 |
| Delta | -3,554,480 |

The negative retained-heap delta, the refresh-persistence assertion and the
resource cleanup tests form the U0 baseline. This is a single-run local
measurement, not a production memory SLO; U12 must repeat it on the immutable
release artifact and check long-running process/container memory.

## API and in-memory payload baseline

The same isolated browser run measured UTF-8 response/payload sizes after the
full workflow:

| Payload | Bytes |
|---|---:|
| `GET /api/workspace/plans` | 1,393 |
| `GET /api/workspace/plans/{planId}` | 1,357 |
| Browser `evaluationSnapshot` JSON | 89,282 |

These are comparison points, not hard maximums. U1/U2 repository and V3 payload
work must add explicit request limits and production telemetry before they become
operational gates.

## Build artifact baseline

Source maps and bundled manuals are excluded from the runtime bundle comparison.

| Artifact | Raw bytes | gzip bytes |
|---|---:|---:|
| Browser boot JS | 473,156 | 156,628 |
| Three renderer JS (lazy chunk) | 557,534 | 141,377 |
| Legacy runtime JS | 75,546 | 28,013 |
| Browser index JS | 103,946 | 26,630 |
| Browser CSS | 105,170 | 15,633 |
| Agent server bundle | 359,545 | 95,074 |
| Workspace server bundle | 332,333 | 86,265 |

Vite reports the Three renderer above its 500 kB advisory limit. It remains a lazy
chunk and is a recorded non-blocking U0 limitation; later UI/performance gates must
ensure it does not move onto the blank-plan initial path.

## Known release-relevant limitations at U0

- Existing deterministic evaluation and physical/wiring adapters still contain
  N6-specific imports; the frozen architecture test prevents new debt but U5-U9
  must remove the legacy debt rather than weakening the baseline.
- Current catalog discovery jobs contain process-memory authority and are not yet
  restart-safe; U1/U4 must move them to durable repositories.
- Current deployment health checks, data backup/restore, immutable-build proof and
  rollback verification are insufficient for production release. They are tracked
  as blocking U1/U12 work.
- The current test environment has no real staging provider or public TLS probe in
  this baseline. No production-health claim is made here.
