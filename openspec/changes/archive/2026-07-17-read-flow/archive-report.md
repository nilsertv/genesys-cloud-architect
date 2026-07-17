# Archive Report: `read-flow`

**Date**: 2026-07-17  
**Change**: read-flow — Read an existing flow in read-only mode for context  
**Status**: ARCHIVED  
**PR**: #4 (feat/read-flow-slice-a → main, merge commit dbc7598)

## Overview

The `read-flow` change has been successfully implemented, verified, and closed. This report documents the final state and traceability for the archived change.

## What Was Implemented

**Capability**: Added a new read-only MCP tool (`read_flow`) that exports the full YAML definition of an existing Genesys Cloud Architect flow without acquiring locks. This allows LLM callers (authoring `updateFlow` bodies) to see the complete flow structure before editing it.

**Three deployment slices**:
1. **Slice A (Phase 1)**: Core deploy-runner `readFlow()` function and `--mode read` flag, with unit tests for the truncation logic
2. **Slice B (Phase 2)**: MCP tool `read_flow` with schema validation and NDJSON protocol handling, plus integration tests
3. **Slice C (Phase 3)**: Documentation (SKILL.md, sdk-patterns.md, gotchas.md) and final empirical verification against the real "Calidda" organization

## Implementation Details

### Source Code Locations

| Component | File | Details |
|-----------|------|---------|
| Deploy-runner core | `src/deploy-runner/index.ts` | New `readFlow()` function; new `mode === "read"` branch |
| Helper functions | `src/deploy-runner/update-helpers.ts` | New `truncateContent()` helper (shared with future readers); `resolveFlowIdentifier` reused |
| Unit tests | `src/deploy-runner/update-helpers.test.ts` | 3 new tests for truncation logic; 20 total after prior changes |
| MCP tool | `src/mcp-server/tools/read-flow.ts` | New tool handler with NDJSON parsing and error classification |
| Tool tests | `src/mcp-server/tools/read-flow.test.ts` | 6 new tests: tools/list schema validation + cross-field validation |
| Tool registration | `src/mcp-server/index.ts` | New tool registration with read-only annotations |
| Documentation | `skills/write-flow/SKILL.md` | New section: "Reading an Existing Flow Before Editing It" |
| SDK patterns docs | `skills/write-flow/references/sdk-patterns.md` | New section: "The `read_flow` Contract" |
| Gotchas docs | `skills/write-flow/references/gotchas.md` | Notes on truncation (200k char limit) and flowVersion values |

### Test Coverage

- **Unit tests**: 26/26 passing (20 in update-helpers, 6 in read-flow)
- **Linting**: Clean (biome)
- **TypeScript**: 0 errors (pnpm exec tsc --noEmit)
- **Build**: Clean (esbuild)
- **Empirical verification**: 3 phases against real "Calidda" org, including gap closures via 5 additional test calls (task 3.5)

### Artifacts

| Artifact | Location | Status |
|----------|----------|--------|
| Proposal | `archive/2026-07-17-read-flow/proposal.md` | Complete, intent and scope documented |
| Specification | `specs/read-flow/spec.md` (merged) + `archive/.../specs/read-flow/spec.md` (copy) | Complete; 7 requirements, 12 scenarios, all verified |
| Design | `archive/2026-07-17-read-flow/design.md` | Complete; technical approach + architecture decisions |
| Tasks | `archive/2026-07-17-read-flow/tasks.md` | Complete; 14 tasks across 3 phases, all checked off |
| Verification | `archive/2026-07-17-read-flow/verify-report.md` | Complete; PASS WITH WARNINGS (0 CRITICAL, 0 blocking); 3 closure gaps found and fixed by sdd-apply task 3.5 |
| State | `archive/2026-07-17-read-flow/state.yaml` | Complete; all phases marked done, 5 open decisions documented |

## Spec Merge

The delta specification from `openspec/changes/read-flow/specs/read-flow/spec.md` was copied directly to `openspec/specs/read-flow/spec.md` as the new source of truth. No existing requirements were modified (this is the first spec for the read-flow capability).

## Verification Results

**Final verdict**: PASS WITH WARNINGS

- All 14 implementation tasks verified against code
- Test suite: 26/26 passing
- TypeScript: 0 errors
- No regressions

**Key verification completions** (sdd-apply task 3.5):
1. CRITICAL gap closed: flowType mismatch scenario confirmed to fold into "not-found" error
2. WARNING #1 closed: flowName+flowType code path exercised end-to-end via real tool
3. WARNING #2 closed: flowVersion "debug" and explicit numeric versions tested
4. SUGGESTION closed: test count stale note corrected

**Non-blocking observations**:
- Two spec.md scenarios retain "(unverified)" labels despite having real evidence in tasks.md — cosmetic documentation gap, does not block archive
- `architect:flow:view` permission not isolated (same limitation as update-flow); empirically confirmed sufficient but not minimal
- MAX_YAML_CHARS truncation value (200k) is a conservative starting estimate; adjustable without breaking the contract

## PR and Merge

- **PR**: #4, `feat/read-flow-slice-a` → `main`
- **Merge commit**: dbc7598 (merge commit, not squashed)
- **Merge resolution**: Resolved real merge conflicts in package.json, SKILL.md, sdk-patterns.md, and src/mcp-server/index.ts (brought in both package.json script additions, folded docs sections per design intent, re-ordered tool registration)
- **Post-merge validation**: pnpm test (26/26), tsc --noEmit (0 errors), lint, build all clean

## Open Decisions (Final)

| ID | Decision | Confirmed |
|----|-----------|-----------| 
| tool-name | `read_flow` (verbo + noun pattern, symmetric with update_flow) | Yes |
| flow-format-param | YAML fixed, not exposed (no use case for architect format) | Yes |
| size-guard-strategy | Truncate at MAX_YAML_CHARS=200k with truncated flag; validate empirically | Yes (empirically: works, value may be adjustable) |
| resolve-flow-identifier-sharing | Reuse from update-helpers.ts without extraction (2 consumers only) | Yes |
| architect-flow-view-permission | NOT isolated; sufficient permissions confirmed, minimal not determined | No (by design — same pattern as update-flow) |

## Dependencies and Rollback

- **No external dependencies**: Change is purely additive; `update_flow`, `deploy_flow`, and `flow_dependencies` are untouched
- **Rollback**: Remove the new tool registration, remove `read_flow.ts` and `read-flow.test.ts`, remove `--mode read` branch from deploy-runner, remove doc sections
- **Side effects**: None on the organization (read-only operation, no flow state mutations)

## Next Steps

The read-flow change is now **complete and closed**. No further work is required unless:

1. **Cosmetic documentation fix** (future, non-blocking): Update spec.md's "(unverified)" labels for the "Invalid version value" and "Published requested" scenarios to reflect that evidence already exists
2. **Minimal permission isolation** (future, if needed): Determine the exact minimal `architect:flow:view` permission required via a separate test org with fine-grained role controls
3. **MAX_YAML_CHARS tuning** (future, if observed): Adjust the truncation threshold if flows larger than the current estimate are encountered in production

## Traceability

- **Change folder**: `openspec/changes/archive/2026-07-17-read-flow/`
- **Artifacts persisted**: proposal, specs (delta + merged), design, tasks, verify-report, state
- **Spec merged to**: `openspec/specs/read-flow/spec.md`
- **Code live in**: feat/read-flow-slice-a (all 3 slices) → PR #4 → main (merge commit dbc7598)
- **Documentation live in**: main branch, visible via skills system (`skills/write-flow/...`)

## Approval and Sign-Off

This archive report is generated by the SDD archive phase on 2026-07-17 after verification of all implementation tasks, test coverage, and manual empirical confirmation against the production "Calidda" organization. The change is ready for production use.
