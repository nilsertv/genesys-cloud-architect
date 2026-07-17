# Archive Report: `update-flow`

**Date**: 2026-07-17  
**Change**: update-flow — Edit Existing Architect Flows Without Delete-and-Recreate  
**Status**: ARCHIVED  
**PRs**: #1 (feat/update-flow-slice-a → main, merge commit 1a1f537), #2 (feat/update-flow-slice-b → main, merge commit c4d5f5e), #3 (feat/update-flow-slice-b-docs → main, merge commit 997c3bf)

## Overview

The `update-flow` change has been successfully implemented, verified, and closed. This report documents the final state and traceability for the archived change.

## What Was Implemented

**Capability**: Added a new non-destructive MCP tool (`update_flow`) and supporting deploy-runner export (`updateFlow`) that edits an existing Genesys Cloud Architect flow in place using checkout-edit-checkin/publish workflow, without deleting and recreating it.

**Two deployment slices**:
1. **Slice A (Phase 1)**: Core deploy-runner `updateFlow()` function, identifier resolution logic, orphaned-lock prevention, and `node:test` for validation paths
2. **Slice B (Phase 2)**: MCP tool `update_flow` with schema validation and NDJSON protocol handling, plus documentation updates to `write-flow` skill and SDK patterns

## Implementation Details

### Source Code Locations

| Component | File | Details |
|-----------|------|---------|
| Deploy-runner core | `src/deploy-runner/index.ts` | New `updateFlow()` function; new `--mode update` branch; CLI args for flow identifier + options |
| Helper functions | `src/deploy-runner/update-helpers.ts` | New `resolveFlowIdentifier()` (flowId vs flowName+flowType), `applyUpdateAndSave()` (checkout/edit/save with orphaned-lock prevention) |
| Unit tests | `src/deploy-runner/update-helpers.test.ts` | 13 node:test cases: identifier resolution (6 cases), save-with-unlock (7 cases) |
| MCP tool | `src/mcp-server/tools/update-flow.ts` | New tool handler with schema validation, process spawn, NDJSON parsing, and error classification |
| Tool registration | `src/mcp-server/index.ts` | New tool registration with non-destructive annotations |
| Documentation | `skills/write-flow/SKILL.md` | New "New flow vs. updating an existing flow" branch question and "Updating an Existing Flow" section |
| SDK patterns docs | `skills/write-flow/references/sdk-patterns.md` | New "The `updateFlow` Contract" section explaining the user's flow file export signature |
| Gotchas docs | `skills/write-flow/references/gotchas.md` | Promoted checkout-and-edit pattern, added flowType enforcement notes, documented mismatched-flowType behavior |
| Package config | `package.json` | Added `"test": "node --experimental-strip-types --test src/**/*.test.ts"` script |

### Test Coverage

- **Unit tests**: 13/13 passing (all in `update-helpers.test.ts`, covering pure logic)
- **Integration tests**: 6/6 in `read-flow.test.ts` (coverage for MCP schema regression, side-benefit from prior change)
- **CI smoke test**: Tools list includes `update_flow` with full parameter schema advertised (run 29590331340)
- **Empirical verification**: Real org "Calidda" testing confirmed:
  - Core claim: flowId preserved across update, no delete-and-recreate
  - Orphaned-lock prevention: 3 different failure scenarios validated empirically
  - `publish:true` invokes `publishAsync()` correctly
  - Error classification: `not-found` confirmed for both missing-by-id (HTTP 404) and missing-by-name (SDK "no matches")
  - `type-mismatch` discovered to be unreachable (SDK doesn't enforce flowType on byId checkout; byName returns generic "no matches" for both mismatched-type and genuinely-missing names)

### Artifacts

| Artifact | Location | Status |
|----------|----------|--------|
| Proposal | `archive/2026-07-17-update-flow/proposal.md` | Complete; scope, approach, risks documented |
| Specification | `specs/update-flow/spec.md` (merged) + `archive/.../specs/update-flow/spec.md` (copy) | Complete; 6 requirements, 16 scenarios, behavior-verified (not mechanism-verified for all scenarios) |
| Design | `archive/2026-07-17-update-flow/design.md` | Complete; architecture decisions, data flow, zod schema, error handling |
| Tasks | `archive/2026-07-17-update-flow/tasks.md` | Complete; 2 slices, 6+6 tasks across phases, all checked off |
| Verification | `archive/2026-07-17-update-flow/verify-report.md` | Complete; PASS WITH WARNINGS (1 CRITICAL formal pre-existing, 5 WARNING, 2 SUGGESTION, none blocking) |
| State | `archive/2026-07-17-update-flow/state.yaml` | Complete; all phases marked done, archive phase done, 3 open decisions documented |

## Spec Merge

The delta specification from `openspec/changes/update-flow/specs/update-flow/spec.md` was copied directly to `openspec/specs/update-flow/spec.md` as the new source of truth. This is the first `update-flow` specification in the system.

## Verification Results

**Final verdict**: PASS WITH WARNINGS

- All 13 node:test cases passing
- All 6 MCP schema regression tests passing (inherited from read-flow change)
- No TypeScript errors, linting clean, build clean
- CI green on merged state (run 29590331340)
- No regressions to existing tools

**Key verification findings**:

1. **Core non-destructive claim**: VERIFIED — Real flowId preserved across update, no delete-and-recreate path executed.

2. **Orphaned-lock prevention**: VERIFIED EMPIRICALLY 3X — Unlock fires correctly on mutate failure, checkIn failure, and publishAsync failure against real org.

3. **Not-found error classification**: VERIFIED EMPIRICALLY — Both missing-by-id (HTTP 404, exact text `"Could not find flow with specified ID. (architect.flow.not.found)"`) and missing-by-name (generic SDK `"no matches"`) correctly classified.

4. **Type-mismatch behavior**: DISCOVERED EMPIRICALLY — Unreachable in practice. Checkout by flowId ignores flowType entirely; checkout by flowName with mismatched type returns identical `"no matches"` as genuinely missing name. SDK provides no signal to distinguish them. Kept in `UpdateErrorKind` union for forward compatibility, not actively detected.

5. **Lock-handling completeness**: **CRITICAL formal limitation** (pre-existing, user-accepted) — "locked-by-other-user" scenario has zero runtime evidence. `classifyUpdateError()` regex pattern exists and is reasonable, but no unit test (function never extracted to testable module), no empirical confirmation (requires second real OAuth identity), no regression protection. Documented as permanent infrastructure limitation, not a defect.

## Known Gaps (Non-Blocking, Documented for Future Work)

| Gap | Severity | Category | Note |
|-----|----------|----------|------|
| `classifyUpdateError()` unextracted, no unit tests | WARNING | Testing | Pure function, should be extracted to update-helpers.ts with regex fixtures for SDK error text |
| `update-flow.ts` has no dedicated test file | WARNING | Testing | `read-flow.test.ts` has MCP schema regression tests; equivalent missing for `update_flow` (smoke test catches empty schema, not full schema validation) |
| Lock-handling empirical verification absent | CRITICAL (formal) | Infrastructure | Requires second real user/OAuth identity; explicitly out of scope per user decision 2026-07-16 |
| `design.md` Open Questions checkboxes not updated | WARNING | Documentation | Partial resolution (not-found/type-mismatch) not reflected in checkboxes |
| `spec.md` § Flow Identifier Resolution mechanism stale | WARNING | Documentation | References `.refine()` that was reverted; behavior is correct, mechanism name is wrong |
| ~~`workflow.md` example uses non-existent `addVariableString()`~~ | Fixed | Documentation | Was found by this verify pass, fixed same-day (commit `d5d0de8`, before archiving) — `flow.addVariable("callbackNumber", flow.dataTypes.string)` now matches `sdk-patterns.md` |
| `openspec/config.yaml` testing section stale | SUGGESTION | Configuration | Predates node:test addition; shows "zero tests" when 26 tests now pass |
| `tasks.md` 1.3 documents outdated test script | SUGGESTION | Documentation | Describes glob pattern; actual script uses `find` command (changed in commit d1cff39) |

## PR and Merge History

- **PR #1**: feat/update-flow-slice-a → main  
  Merge commit: `1a1f537`  
  Content: deploy-runner core, update-helpers.ts, node:test infrastructure, CLI flags, empirical verification phase 1

- **PR #2**: feat/update-flow-slice-b → main (retargeted from feat/update-flow-slice-a)  
  Merge commit: `c4d5f5e`  
  Content: MCP tool `update-flow.ts`, tool registration, empirical verification phase 2

- **PR #3**: feat/update-flow-slice-b-docs → main (retargeted from feat/update-flow-slice-b)  
  Merge commit: `997c3bf`  
  Content: `write-flow` skill documentation updates, SDK patterns docs, gotchas docs

**Integration note**: Confirmed via `git diff 997c3bf dbc7598 -- src/mcp-server/index.ts` that the subsequent `read-flow` merge (commit dbc7598, PR #4) only added 9 lines (read_flow registration) after update_flow's block, with zero modifications to update_flow's config/handler. CI green on merged state confirms no regressions.

## Open Decisions (Final)

| ID | Decision | Confirmed | Rationale |
|----|-----------|-----------|----|
| tool-surface | Dedicated `update_flow` tool | Yes | MCP annotations static per-tool; separate tool avoids `.refine()` gymnastics and mode-inference risks |
| test-strategy | Narrow `node:test` extraction | Yes | Tests cover pure logic only; full vitest migration deferred |
| pr-slicing | Two slices (core + MCP/docs) | Yes | Slice B depends on Slice A's export; split successful, code reviewed independently |

## Dependencies and Rollback

- **No external dependencies**: Change is purely additive; `deploy_flow`, `create` path, and other tools untouched
- **Rollback**: Remove `update-flow.ts` + registration, remove `updateFlow()` export + helpers + tests, remove `--mode update` branch, remove doc sections
- **Side effects**: None on the org (non-destructive operation, no state mutations until user's flow file decides to edit)

## Next Steps

The update-flow change is now **complete and closed**. No further work is required unless:

1. **Lock-handling empirical verification** (future, if org admin access available): Use second real OAuth identity to test locked-by-another-user scenario
2. **Regression test extraction** (future, best-practice): Extract `classifyUpdateError()` to `update-helpers.ts`, add SDK error text fixtures as node:test cases
3. **`update-flow.test.ts` parity** (future, quality): Add MCP schema regression test for `update_flow` matching pattern from `read-flow.test.ts`
4. **Stale documentation cleanup** (future, low-priority): Update `spec.md` § mechanism reference, `design.md` checkboxes, `workflow.md` example, `config.yaml`

## Traceability

- **Change folder**: `openspec/changes/archive/2026-07-17-update-flow/`
- **Artifacts persisted**: proposal, specs (delta + merged), design, tasks, verify-report, state
- **Spec merged to**: `openspec/specs/update-flow/spec.md`
- **Code live in**: feat/update-flow-slice-a/b/b-docs (all 3 slices) → PR #1, #2, #3 → main (merge commits 1a1f537, c4d5f5e, 997c3bf)
- **Documentation live in**: main branch, visible via skills system (`skills/write-flow/...`)

## Approval and Sign-Off

This archive report is generated by the SDD archive phase on 2026-07-17 after verification of all implementation tasks, test coverage, and empirical confirmation against the production "Calidda" organization. The change is ready for production use with documented limitations on lock-handling verification (pre-existing, user-accepted) and minor quality gaps (none affecting runtime behavior).
