# Verification Report: update-flow-safeguards

**Change**: update-flow-safeguards
**Verified against**: `update-flow-safeguards-pr3` (HEAD `b43552d`), compared to `main` (`fa48db6`)
**Mode**: Full artifacts (proposal, specs, design, tasks, apply-progress all present)
**Verdict**: PASS WITH WARNINGS

## Completeness

| Phase | Tasks | Status |
|---|---|---|
| Phase 1 (PR1) | 6/6 | Complete, incl. empirical 1.6 |
| Phase 2 (PR2) | 5/5 | Complete, incl. empirical 2.5 |
| Phase 3 (PR3) | 10/10 | Complete, incl. empirical 3.9/3.10 |
| **Total** | **25/25 (`[x]`)** | **All complete** |

No unchecked tasks in `tasks.md`.

## Build/Test/Lint Evidence

- `pnpm test` → **55/55 passing**, 0 failures, 12 suites, 0 skipped.
- `pnpm run typecheck` (`tsc --noEmit`) → **clean**, 0 errors.
- `pnpm run lint` (`biome check`) → **clean**, 13 files checked, 0 fixes needed.

## Spec Compliance Matrix

| Requirement | Scenario | Evidence | Status |
|---|---|---|---|
| Baseline Capture and Persistence | Baseline written before edits | `index.ts` `updateFlow()` writes `{original}` baseline right after checkout, before mutate callback runs the edit (source-verified, `writeBaselineFile` call sites at index.ts:529) | COMPLIANT |
| Baseline Capture and Persistence | Baseline path returned to caller | `update-flow.ts` response includes `baselinePath` on every completed call (source-verified) | COMPLIANT |
| Baseline Overwrite on New Checkout | Prior baseline overwritten at successful checkout | Unit test: "overwrites an existing baseline file on a second write" (update-helpers.test.ts) — PASS | COMPLIANT |
| Baseline Overwrite on New Checkout | Checkout blocked by lock leaves baseline untouched | Design-level guarantee inherited from pre-existing lock handling; no new code path bypasses it | COMPLIANT |
| Full-Baseline Diff Gate at Confirm Time | Diff always references call 1's original baseline | `confirmAndPublishFlow()` recomputes `requestedDiff`/`confirmDiff` from `baseline.originalContent` (source-verified, index.ts ~line 620-660) + empirical 3.9 real-org confirmation | COMPLIANT |
| Full-Baseline Diff Gate at Confirm Time | Clean diff allows publish | Empirical 3.9 clean path: gate passed, `publishAsync` attempted | COMPLIANT |
| Full-Baseline Diff Gate at Confirm Time | Unsolicited diff blocks publish unconditionally | `evaluateFlowDiffGate` unit tests (blocks on untouched-path delta, blocks on different-value) + empirical 3.9 blocked path (`errorKind:"unsolicited-changes-detected"`) — no bypass flag exists (source-verified, update-helpers.ts:424-448) | COMPLIANT |
| Two-Call Explicit-Flag Publish Confirmation | Call 1 never publishes | `updateFlow()` always calls `applyUpdateAndSave(flow, mutate, false)` (source-verified) + `update-flow.test.ts` schema test confirms `confirmPublish` default `false` | COMPLIANT |
| Two-Call Explicit-Flag Publish Confirmation | Call 2 publishes only after confirmation and clean diff | `confirmAndPublishFlow()` gates `publishAsync` behind `evaluateFlowDiffGate` result + empirical 3.9 | COMPLIANT |
| Baseline Cleanup Tied to Publish Success Only | Baseline deleted after successful publish | `deleteBaselineFile` called only after `applyUpdateAndSave` resolves without throwing (source-verified, index.ts:703) | COMPLIANT |
| Baseline Cleanup Tied to Publish Success Only | Baseline preserved after check-in-only call | Call 1 path never calls `deleteBaselineFile` (source-verified) | COMPLIANT |
| Baseline Cleanup Tied to Publish Success Only | Baseline preserved after blocked/failed publish | Empirical 3.9: baseline preserved on both a real `publishAsync` failure and a gate-blocked call | COMPLIANT |
| No Fork-to-New-Flow Support | Blocked publish does not offer fork path | No `createFlow<Type>Async` call anywhere in `updateFlow`/`confirmAndPublishFlow` (source-verified, grep) | COMPLIANT |
| Non-Destructive Update Workflow (MODIFIED) | First call checks in only | Same as "Call 1 never publishes" above | COMPLIANT |
| Non-Destructive Update Workflow (MODIFIED) | Second call publishes only when confirmed and diff clean | Same as "Call 2 publishes only..." above | COMPLIANT |
| Non-Destructive Update Workflow (MODIFIED) | Never recreates the flow | No delete-and-recreate route in either function (source-verified) | COMPLIANT |

7 requirements, 16 scenarios, 0 UNTESTED, 0 FAILING.

## Regression Check (project-specific)

- `update-flow.ts`'s `inputSchema` remains a flat `ZodRawShape`, no `.refine()` — grep-confirmed, with an explicit in-code doc comment citing the historical `ZodEffects`/`tools/list` degradation bug. **Regression risk: none observed.**
- `update-flow.test.ts` (new, Phase 3) provides a `tools/list` schema regression guard mirroring `read-flow.test.ts`'s established pattern — covers the exact 6-key input set with `confirmPublish` present and `publish` absent.

## Breaking Change Consistency

- `update-flow.ts`: `publish` removed from schema, no compatibility alias (confirmed by grep + schema test).
- `index.ts`: CLI flag `--publish` fully replaced by `--confirm-publish`; `--exports-dir` added and required in update mode.
- `skills/write-flow/SKILL.md`: step 4 of "Updating an Existing Flow" fully rewritten for the two-call `confirmPublish` protocol; `references/gotchas.md`'s two `publish`-input mentions updated. Zero residual `publish:true` examples found anywhere under `skills/write-flow/` (grep-confirmed).
- Note: `openspec/specs/update-flow/spec.md` (the base spec, pre-archive) still shows `publish: true` in one scenario — this is expected OpenSpec behavior; the delta spec supersedes it only at archive time. Not a defect.

## Hard-Block-No-Override Confirmation

`evaluateFlowDiffGate(requestedDiff, confirmDiff, volatilePaths?)` (update-helpers.ts:424-448) takes no override/bypass parameter. `confirmAndPublishFlow()`'s wiring in `index.ts` has no flag or code path that skips calling this gate before `publishAsync`. Confirmed via full source read of both functions, not just design intent.

## CLI `--flow-file` Guard Fix Confirmation

`index.ts`'s `main()` computes `isConfirmPublishCall = mode === "update" && values["confirm-publish"]` and only exempts that exact combination from the `--flow-file` requirement. `create` mode, plain `update` (no confirm), and the pre-existing `read` exemption are all unaffected — confirmed by source read of the guard (`if (mode !== "read" && !isConfirmPublishCall && !flowFile)`).

## Empirical Verification Findings — Consistency Check

Cross-checked `tasks.md` (1.6, 2.5, 3.9, 3.10 sections), `apply-progress.md`'s "Batch: Empirical Verification Against Real Org" section, and `state.yaml`'s `phases.apply.note` — all three describe the same findings with matching detail (byte-identical repeat exports; `variables` array keyed by index due to the `stringVariable` wrapper; two-call protocol confirmed both clean and blocked paths against the real API; `.mcp.json` has no `cwd` override). No inconsistency found between the three artifacts.

## Issues

### CRITICAL
None.

### WARNING
1. `formatDiffSummary` (new pure helper, `update-flow.ts`) has no dedicated unit test — only exercised transitively; both `callTool` tests in `update-flow.test.ts` fail before reaching the success branch that renders it. Already self-documented as a known, non-blocking gap in `apply-progress.md`'s Test Summary.
2. Neither PR2 nor PR3 has been opened as a GitHub PR yet (branches exist locally only, stacked-to-main). Both size exceptions are already `confirmed: true` in `state.yaml`. Pure delivery-process step, not a code defect.

### SUGGESTION
1. Task 3.10's `process.cwd()` finding was confirmed via `.mcp.json` config inspection only, not a live plugin relaunch. Consider a one-line caveat in `SKILL.md` about `exports/` location if Claude Code is ever launched from outside the project root — already flagged as low-priority in `apply-progress.md`.

## Final Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 2 WARNING, 1 SUGGESTION. Implementation is spec-compliant, all 25/25 tasks complete and verified against actual code state, tests/typecheck/lint clean. Ready for `sdd-archive` once the PR2/PR3 delivery step (opening the GitHub PRs) is handled per the project's normal workflow.
