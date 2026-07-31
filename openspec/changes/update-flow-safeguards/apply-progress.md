# Apply Progress: `update-flow-safeguards`

## Batch: Phase 1 (PR1, Work Unit 1 — Baseline Envelope + FlowId Sanitization)

Branch: `update-flow-safeguards-pr1` (off `main`). No PR opened (not requested this batch — first of 3 stacked-to-main PRs per `tasks.md`'s Chain strategy).

### Completed Tasks

- [x] 1.1 RED — `update-helpers.test.ts`: `baselineFilePath` rejects a flowId containing `/`, `\`, `..` (3 cases)
- [x] 1.2 GREEN — `update-helpers.ts`: `baselineFilePath(exportsDir, flowId)`, throws on unsafe input
- [x] 1.3 RED — `update-helpers.test.ts`: `BaselineEnvelope` round-trip via `os.tmpdir()` — write/read/delete, `readBaselineFile` returns `undefined` on ENOENT, `deleteBaselineFile` ignores ENOENT
- [x] 1.4 GREEN — `update-helpers.ts`: `BaselineEnvelope` interface, serialize/parse (`yaml`), `writeBaselineFile`/`readBaselineFile`/`deleteBaselineFile`
- [x] 1.5 Added `yaml` (2.9.0) to `package.json` dependencies via `pnpm add yaml`

### Blocked/Deferred

- [ ] 1.6 **Empirical (real org)** — export the same unmodified flow twice via `read_flow`, diff parsed structures, record volatile fields for Phase 2's `KNOWN_VOLATILE_FLOW_PATHS`. **BLOCKED**: this apply session has no live Genesys Cloud org credentials or MCP tool access (sandbox denies reading `.env`/credential files). Must be completed by a session with real org access before Phase 2 relies on a non-empty `KNOWN_VOLATILE_FLOW_PATHS` — Phase 2's tasks (2.1-2.4) can still start with the array shipping empty, per design.md's stated fallback ("ships empty").

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 1.1/1.2 `baselineFilePath` | Added 4 tests (safe path + 3 unsafe-input throws) referencing not-yet-exported `baselineFilePath` — confirmed failure: `SyntaxError: The requested module './update-helpers.ts' does not provide an export named 'baselineFilePath'` | Implemented `baselineFilePath` rejecting `/`, `\`, `..` in flowId — all 4 tests pass | Biome `lint:fix` applied (import sort only); no logic changes |
| 1.3/1.4 `BaselineEnvelope` + write/read/delete | Added 6 tests (full round-trip, no-`requestedContent` round-trip, overwrite-on-second-write, ENOENT-returns-undefined on read, delete-existing, delete-ignores-ENOENT) against not-yet-exported symbols — same module-export SyntaxError confirmed | Implemented `BaselineEnvelope` interface + `writeBaselineFile`/`readBaselineFile`/`deleteBaselineFile` using `yaml` parse/stringify + `node:fs/promises` — all 6 tests pass | Biome `lint:fix` applied (import sort only); no logic changes |

Both RED batches were run together in one `pnpm test` invocation before any implementation existed (confirmed via the module-export `SyntaxError`, since none of the new symbols existed yet — that failure mode itself proves the tests were written first and would fail without the implementation).

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `pnpm test` → `src/deploy-runner/update-helpers.test.ts`: 36 tests total across the file (10 new: 4 for `baselineFilePath`, 6 for baseline envelope round-trip/delete), all passing; 0 failures across the whole suite (`ℹ tests 36 / ℹ pass 36 / ℹ fail 0`) |
| Runtime harness command/scenario and exact result | Real filesystem I/O exercised directly in tests via `os.tmpdir()` + `mkdtemp`/`rm` — no mocking of `node:fs/promises`, so write/read/delete round-trips run against real files. `pnpm run typecheck` (`tsc --noEmit`) passes with no errors. `pnpm run lint` (`biome check`) passes clean after one `lint:fix` (import-sort only). Genesys-org-level integration harness (task 1.6) is N/A for this reason: no live org access in this sandboxed session — see Blocked/Deferred above. |
| Rollback boundary | Revert the additions to `src/deploy-runner/update-helpers.ts` (the `import` block + everything from `BaselineEnvelope` through `deleteBaselineFile`), revert the corresponding test additions in `src/deploy-runner/update-helpers.test.ts`, and drop the `yaml` entry from `package.json`/`pnpm-lock.yaml`. Nothing else in the codebase references these new exports yet (Phase 2/3 wiring not started), so this reverts cleanly in isolation. |

### Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/deploy-runner/update-helpers.ts` | Modified | Added `BaselineEnvelope` interface, `baselineFilePath`, `writeBaselineFile`, `readBaselineFile`, `deleteBaselineFile`; imports `yaml` parse/stringify and `node:fs/promises` |
| `src/deploy-runner/update-helpers.test.ts` | Modified | Added `baselineFilePath` describe block (4 tests) and baseline envelope describe block (6 tests) |
| `package.json` | Modified | Added `yaml: ^2.9.0` dependency |
| `pnpm-lock.yaml` | Modified | Lockfile updated by `pnpm add yaml` |
| `openspec/changes/update-flow-safeguards/tasks.md` | Modified | Marked 1.1-1.5 `[x]`; annotated 1.6 as blocked |
| `openspec/changes/update-flow-safeguards/state.yaml` | Modified | Added `phases.apply: status: partial` with note |

### Deviations from Design

None — implementation matches design.md's `BaselineEnvelope`/`baselineFilePath`/write/read/delete contracts verbatim (see design.md's "Interfaces / Contracts" section).

### Issues Found

Task 1.6 could not be executed in this apply session (no real Genesys Cloud org access available — see Blocked/Deferred). This does not block Phase 2 starting, since `KNOWN_VOLATILE_FLOW_PATHS` is designed to ship empty and be extended later as a one-line addition.

### Remaining Tasks

- [ ] 1.6 (blocked — see above)
- [ ] Phase 2 (PR2, base = this branch): 2.1-2.5 — `diffFlowYaml`, `evaluateFlowDiffGate`, `KNOWN_VOLATILE_FLOW_PATHS`
- [ ] Phase 3 (PR3, base = PR2 branch): 3.1-3.10 — two-call wiring, CLI/tool changes, skill docs, `.gitignore`, end-to-end empirical validation

### Workload / PR Boundary

- Mode: chained/stacked PR slice (stacked-to-main)
- Current work unit: Work Unit 1 — Baseline envelope (write/read/delete) + `flowId` path-traversal sanitization
- Boundary: starts from `main`, ends with `yaml` dependency + baseline envelope helpers fully tested; nothing in Phase 2/3 wired in yet
- Estimated review budget impact: within forecast (~230-260 lines estimated for PR1; actual diff is smaller — pure additive helper + tests, no existing code modified)

### Status

5/6 Phase 1 tasks complete (1.6 blocked pending real-org access). Ready for review/PR1, or for Phase 2 apply batch to begin (task 1.6 does not block Phase 2 per design's empty-array fallback).

