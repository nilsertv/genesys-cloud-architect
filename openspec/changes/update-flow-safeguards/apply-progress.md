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

## Batch: Phase 2 (PR2, Work Unit 2 — Structural Diff Engine + Diff Gate)

Branch: `update-flow-safeguards-pr2`, created from `update-flow-safeguards-pr1` (stacked-to-main, per `tasks.md`'s Chain strategy). No PR opened (not requested this batch). PR1's changes remain uncommitted in the working tree, carried forward onto this new branch pointer (same base commit as PR1 — PR1 itself has not been committed yet); PR2's changes are layered on top of them in the same working tree.

### Completed Tasks

- [x] 2.1 RED — `update-helpers.test.ts`: `diffFlowYaml` tests — identical YAML (no diff), changed leaf, added leaf, removed leaf, changed leaf inside nested structure, array reorder tolerated via `name` key, array reorder tolerated via `id` key, array reorder without name/id falls back to index (registers as a diff)
- [x] 2.2 GREEN — `update-helpers.ts`: `diffFlowYaml(baselineYaml, candidateYaml): FlowDiffResult` — parses both YAML documents, flattens each to a `path -> leaf value` map (`flattenFlowYaml`/`arrayElementKey` helpers), compares the two maps for added/removed/changed leaf paths
- [x] 2.3 RED — `update-helpers.test.ts`: `evaluateFlowDiffGate` tests — clean confirm diff allows, confirm diff exactly matching requested diff allows, confirm diff touching an untouched path blocks, confirm diff resolving a requested path to a different value blocks, volatile-listed path always allows even if untouched, `KNOWN_VOLATILE_FLOW_PATHS` defaults to `[]` so nothing is silently allowed today
- [x] 2.4 GREEN — `update-helpers.ts`: `evaluateFlowDiffGate(requestedDiff, confirmDiff, volatilePaths = KNOWN_VOLATILE_FLOW_PATHS)` — resolves both diffs to `path -> {kind, value}` deltas (`resolveDeltas`), blocks any confirm-time path not in `volatilePaths` and not resolving to the identical kind+value the requested diff produced; exported `KNOWN_VOLATILE_FLOW_PATHS: readonly string[]` ships empty

### Blocked/Deferred

- [ ] 2.5 **Empirical (real org)** — confirm Architect flow YAML arrays carry stable `name`/`id` keys. **BLOCKED**: same reason as task 1.6 — this apply session has no live Genesys Cloud org credentials or MCP tool access. Does NOT block Phase 3: `diffFlowYaml`'s keying (`name` present → key by name; else `id` present → key by id; else index) degrades safely to index-based comparison if the assumption turns out wrong — that fallback is strictly MORE conservative (more likely to flag a diff), never less, so no safety property depends on this confirmation.

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 1.1/1.2 `baselineFilePath` | Added 4 tests (safe path + 3 unsafe-input throws) referencing not-yet-exported `baselineFilePath` — confirmed failure: `SyntaxError: The requested module './update-helpers.ts' does not provide an export named 'baselineFilePath'` | Implemented `baselineFilePath` rejecting `/`, `\`, `..` in flowId — all 4 tests pass | Biome `lint:fix` applied (import sort only); no logic changes |
| 1.3/1.4 `BaselineEnvelope` + write/read/delete | Added 6 tests (full round-trip, no-`requestedContent` round-trip, overwrite-on-second-write, ENOENT-returns-undefined on read, delete-existing, delete-ignores-ENOENT) against not-yet-exported symbols — same module-export SyntaxError confirmed | Implemented `BaselineEnvelope` interface + `writeBaselineFile`/`readBaselineFile`/`deleteBaselineFile` using `yaml` parse/stringify + `node:fs/promises` — all 6 tests pass | Biome `lint:fix` applied (import sort only); no logic changes |
| 2.1/2.2 `diffFlowYaml` | Added 8 tests importing not-yet-exported `diffFlowYaml`/`FlowDiffResult` — confirmed failure: `SyntaxError: The requested module './update-helpers.ts' does not provide an export named 'KNOWN_VOLATILE_FLOW_PATHS'` (the last-added import in the same batch; module load fails atomically so all 8 new `diffFlowYaml` tests plus all `evaluateFlowDiffGate` tests failed together as one RED batch) | Implemented `flattenFlowYaml`/`arrayElementKey`/`leafValuesEqual`/`diffFlowYaml` — all 8 tests pass; full suite 50/50 | Biome `lint:fix` reformatted 2 files (line-wrapping only, e.g. `flattenFlowYaml`'s multi-arg signature and a multi-line object literal in tests); no logic changes |
| 2.3/2.4 `evaluateFlowDiffGate` + `KNOWN_VOLATILE_FLOW_PATHS` | Added 6 tests against not-yet-exported `evaluateFlowDiffGate`/`KNOWN_VOLATILE_FLOW_PATHS` — same module-export SyntaxError confirmed (part of the same RED batch as 2.1) | Implemented `resolveDeltas` + `evaluateFlowDiffGate` + exported `KNOWN_VOLATILE_FLOW_PATHS = []` — all 6 tests pass; full suite 50/50 | Covered by the same `lint:fix` pass above |

Both new RED batches (diffFlowYaml's 8 tests and evaluateFlowDiffGate's 6 tests) were written and run together in one `pnpm test` invocation before any Phase 2 implementation existed — confirmed via the module-export `SyntaxError` referencing `KNOWN_VOLATILE_FLOW_PATHS` (the last new symbol imported), since none of `diffFlowYaml`/`FlowDiffResult`/`evaluateFlowDiffGate`/`KNOWN_VOLATILE_FLOW_PATHS` existed yet.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | PR1: `pnpm test` → 36/36 passing (see above). PR2: `pnpm test` → 50/50 passing (36 prior + 14 new: 8 `diffFlowYaml` + 6 `evaluateFlowDiffGate`), 0 failures (`ℹ tests 50 / ℹ pass 50 / ℹ fail 0`) |
| Runtime harness command/scenario and exact result | PR1: real filesystem I/O via `os.tmpdir()` (see above). PR2: `diffFlowYaml`/`evaluateFlowDiffGate` are pure functions over parsed-YAML fixtures — no I/O boundary to exercise beyond the unit tests themselves (parsing real YAML strings via the same `yaml` library used in production, not mocked). `pnpm run typecheck` (`tsc --noEmit`) passes with no errors. `pnpm run lint` (`biome check`) passes clean after one `lint:fix` (formatting only). Genesys-org-level integration harness (task 2.5, confirming stable `name`/`id` array keys in real Architect exports) is N/A for this reason: no live org access in this sandboxed session — see Blocked/Deferred above. |
| Rollback boundary | Revert the Phase 2 additions to `src/deploy-runner/update-helpers.ts` (everything from `FlowDiffEntry` through `evaluateFlowDiffGate`) and the corresponding Phase 2 test additions (the `diffFlowYaml` and `evaluateFlowDiffGate` describe blocks, and the added imports) in `update-helpers.test.ts`. Nothing in Phase 1's baseline-envelope code or Phase 3's (not-yet-started) wiring depends on these new exports, so this reverts cleanly in isolation, independent of PR1. |

### Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/deploy-runner/update-helpers.ts` | Modified | PR1: added `BaselineEnvelope`, `baselineFilePath`, `writeBaselineFile`, `readBaselineFile`, `deleteBaselineFile`. PR2 (this batch): added `FlowDiffEntry`, `FlowDiffResult`, `flattenFlowYaml`, `arrayElementKey`, `leafValuesEqual`, `diffFlowYaml`, `KNOWN_VOLATILE_FLOW_PATHS`, `ResolvedDelta`, `resolveDeltas`, `evaluateFlowDiffGate` |
| `src/deploy-runner/update-helpers.test.ts` | Modified | PR1: added `baselineFilePath` + baseline envelope describe blocks (10 tests). PR2 (this batch): added `diffFlowYaml` describe block (8 tests) and `evaluateFlowDiffGate` describe block (6 tests) |
| `package.json` | Modified | PR1: added `yaml: ^2.9.0` dependency (no change this batch) |
| `pnpm-lock.yaml` | Modified | PR1: lockfile updated by `pnpm add yaml` (no change this batch) |
| `openspec/changes/update-flow-safeguards/tasks.md` | Modified | PR1: marked 1.1-1.5 `[x]`, annotated 1.6 blocked. PR2 (this batch): marked 2.1-2.4 `[x]`, annotated 2.5 blocked |
| `openspec/changes/update-flow-safeguards/state.yaml` | Modified | PR1: added `phases.apply: status: partial` note. PR2 (this batch): updated the note to cover Phase 2 completion |

### Deviations from Design

None — implementation matches design.md's `FlowDiffEntry`/`FlowDiffResult`/`diffFlowYaml`/`KNOWN_VOLATILE_FLOW_PATHS`/`evaluateFlowDiffGate` contracts verbatim (see design.md's "Interfaces / Contracts" section), including the confirmed `diff-gate-scope: strict-full-baseline-diff` posture (the gate compares against the full original baseline delta, not an optimistic-concurrency-only delta — this is exercised by callers in Phase 3, but `evaluateFlowDiffGate` itself is diff-source-agnostic and works correctly either way since it only ever sees the two `FlowDiffResult`s it's given) and `diff-gate-posture: hard-block-no-override` (no bypass parameter exists on `evaluateFlowDiffGate`).

### Issues Found

Task 2.5 could not be executed in this apply session (no real Genesys Cloud org access available — see Blocked/Deferred). This does not block Phase 3 starting: `diffFlowYaml`'s array-keying fallback (index-based when no `name`/`id`) is a safe degradation, not a missing safety property.

### Remaining Tasks

- [ ] 1.6 (blocked — see above)
- [ ] 2.5 (blocked — see above)
- [ ] Phase 3 (PR3, base = this branch / PR2): 3.1-3.10 — two-call wiring, CLI/tool changes, skill docs, `.gitignore`, end-to-end empirical validation

### Workload / PR Boundary

- Mode: chained/stacked PR slice (stacked-to-main)
- Current work unit: Work Unit 2 — `diffFlowYaml` structural diff + `evaluateFlowDiffGate` + `KNOWN_VOLATILE_FLOW_PATHS`
- Boundary: starts from `update-flow-safeguards-pr1`'s tip, ends with the diff engine and gate fully tested; nothing in Phase 3 (index.ts/update-flow.ts wiring) touched yet
- Estimated review budget impact: within forecast (~260-300 lines estimated for PR2; actual diff is smaller — pure additive helper + tests, no existing code modified beyond the new imports in the test file)

### Status

10/11 tasks complete across Phase 1 + Phase 2 (1.6 and 2.5 blocked pending real-org access, neither blocks further phases per design's documented safe-degradation/fallback behavior). Ready for review/PR2, or for Phase 3 apply batch to begin.
