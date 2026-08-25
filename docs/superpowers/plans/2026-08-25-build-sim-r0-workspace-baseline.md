# R0 workspace baseline

- Captured: 2026-08-25 UTC
- Branch: `main`
- HEAD: `541614be8bfdc757aeb4b6cd770d581d04fb86e0`
- Worktree reported by Git: `/home/linuxuser/Code/build-sim-releases/9d5d5a4`
- User-facing workspace alias: `/home/linuxuser/Code/build-sim`

## Pre-existing dirty files

- `index.html`: unfinished workspace and transaction markup draft. It is baseline evidence, not accepted R0-R10 functionality.
- `src/agent/contracts.ts`, `src/agent/providers/deepseek.ts`, `src/agent/runtime.ts`, `src/server/agent-server.ts`: DeepSeek reasoning replay and server-side redaction work.
- `tests/agent-deepseek-provider.test.ts`, `tests/agent-runtime.test.ts`: tests for the reasoning replay/redaction work.
- The lifecycle goal prompt and follow plan were already untracked.

R0 plan-domain work is isolated under `src/plans/`, new plan tests, and this baseline record. No pre-existing dirty file is overwritten in R0.

The current configuration, overview, SVG spatial views, transaction dialog, and Agent panel anchors are recorded in `tests/fixtures/workspace/r0-dom-baseline.json`. This DOM fixture is the chosen baseline evidence because browser screenshots are not required to freeze contracts and would not prove lifecycle behavior.
