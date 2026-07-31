# Proposal: `update_flow` Safeguards — Persisted Baseline, Diff-Gated Publish, Two-Call Confirmation

## Intent

`update_flow` edits an existing flow in place but has no safety net:
no export-before-edit, no persisted reference of what the flow looked
like before the edit, no check that publish only ships the intended
change, and no confirmation step before going live. A caller (agent
or human) can silently publish more than they meant to, with no
record to compare against afterward. This change closes that gap in
code, not just in skill instructions.

## Scope

### In Scope
- Persist a pre-edit export to `<project-root>/exports/<flowId>.baseline.yaml` at checkout time, before any mutation runs (overwrites any prior baseline for that `flowId` — checkout's exclusive lock guarantees an existing file is abandoned/stale).
- Structural diff at confirm-time between the persisted baseline and the flow's live content, always against the **full original baseline** captured before any edit ran (call 1's pre-edit export) — not against an intermediate snapshot taken between call 1 and call 2. The goal is to catch whether the edit itself (by the user or anyone else) touched more of the flow than was requested, not merely to detect a third party's concurrent edit.
- Hard-block publish, no override flag, when that diff shows the live flow differs from the original baseline in any way beyond the requested edit. (The exact mechanism for telling "requested" delta apart from "unrequested" delta inside that diff is a design-level decision deferred to `sdd-design` — see Risks.)
- Two-call explicit-flag publish protocol: call 1 (no `confirmPublish`) checks out, edits, checks in (never publishes), and returns a diff summary plus the baseline path. Call 2 (`confirmPublish: true`) re-checks out, re-diffs the live flow against the same persisted original baseline (unchanged since call 1), and only then calls `publishAsync`.
- Baseline cleanup: delete on terminal success (call 1's check-in, call 2's publish); keep on any failure or block for inspection.
- Update `write-flow` skill and `openspec/specs/update-flow/spec.md` to document the new flow.

### Out of Scope
- Fork-to-new-flow support — edit-in-place only (confirmed decision).
- MCP elicitation for confirmation — client-side support unverified.
- Any override/bypass flag for the diff gate.
- Final diff algorithm choice (raw text vs. parsed-YAML) — depends on the unresolved empirical question below; `sdd-design`/`sdd-apply` decide once verified.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `update-flow`: adds baseline capture/persistence, diff-gated publish, and the two-call `confirmPublish` protocol to the existing checkout → edit → check-in/publish requirements.

## Approach

Two new pure helpers in `update-helpers.ts`: `captureBaseline` (export + write to `exports/`) and `diffFlowContent` (baseline vs. candidate), both wired inside `applyUpdateAndSave`'s existing lock-guaranteed try/catch — never around it. `confirmPublish` (default `false`) is a new boolean input on `update_flow`, mirroring the existing `forceUnlock` precedent. Call 1's baseline file is the single source of truth call 2 diffs against; no extra token/hash needs to round-trip through the caller since only one baseline can exist per locked `flowId` at a time.

The diff-gate is a **full-baseline comparison, not an optimistic-concurrency check**: `diffFlowContent` always compares the live flow against the original baseline captured before any edit ran, never against an intermediate state. That means it surfaces every delta the edit introduced, not just changes a third party made between call 1 and call 2 — catching third-party interference is a side effect of that full comparison, not its purpose. Which of those deltas the user actually requested versus which are incidental/unrequested is not something the codebase can express today (no "declared intent" mechanism exists — see Risks); this proposal only commits to the comparison being against the full original baseline. Resolving how to tell requested from unrequested delta is a design-level decision for `sdd-design`.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `src/deploy-runner/update-helpers.ts` | Modified | `captureBaseline`, `diffFlowContent` helpers |
| `src/deploy-runner/index.ts` | Modified | Wire baseline/diff/confirm gate into `updateFlow` |
| `src/mcp-server/tools/update-flow.ts` | Modified | New `confirmPublish` input, diff summary in response |
| `exports/` | New | Persisted baseline files, gitignored |
| `skills/write-flow/SKILL.md` | Modified | Document two-call publish protocol |
| `openspec/specs/update-flow/spec.md` | Modified | New requirements for baseline/diff/confirm |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| Unconfirmed: repeated exports of an unmodified flow may not be byte-identical | Med | Verify empirically in `sdd-apply` against a real org before fixing the diff algorithm |
| No structured way for the caller to declare "this is the requested change" — nothing in the codebase expresses declared intent today, so `diffFlowContent` cannot yet distinguish requested from unrequested delta inside the full-baseline diff | High | Deferred to `sdd-design`, not resolved here. Candidate mechanisms already scoped in `exploration.md`: (a) parsed-YAML/structural diff tolerant of node reordering, plus an allowlist of fields Genesys regenerates on every export, or (b) simpler raw-text diff — cheaper but more prone to false positives on cosmetic-only differences |
| Third-party concurrent edit between call 1 and call 2 is now caught only as a side effect of the full-baseline diff (any change from any source shows up), not by a dedicated concurrency check | Low-Med | Hard block, no override (confirmed decision); caller restarts from call 1 |
| `exports/` baseline files leak org content if committed | Low | Add to `.gitignore` |
| Two-call protocol still depends on the calling agent behaving correctly | Med | Same class of gap as today's `forceUnlock`, one level down; documented in skill |

## Rollback Plan

Fully additive to `update-helpers.ts`/`update-flow.ts`/spec — revert those diffs to restore today's un-gated `update_flow` behavior. No prior file is deleted or restructured.

## Dependencies

- Builds on the archived `update-flow` change (already shipped).
- Empirical export byte-stability check during `sdd-apply`.

## Success Criteria

- [ ] Baseline is persisted to `exports/<flowId>.baseline.yaml` at checkout and cleaned up per the success/failure policy above.
- [ ] Publish is hard-blocked (no override) whenever the confirm-time diff — always against the full original pre-edit baseline, never an intermediate snapshot — shows any change beyond what `sdd-design` defines as the requested edit.
- [ ] Two-call protocol works end-to-end: call 1 never publishes, call 2 only publishes when its diff against the full original baseline shows no delta beyond the requested edit (not merely "unchanged since call 1").
- [ ] Export byte-stability confirmed empirically; diff algorithm finalized accordingly.
- [ ] `write-flow` skill and `update-flow` spec document the new workflow.
