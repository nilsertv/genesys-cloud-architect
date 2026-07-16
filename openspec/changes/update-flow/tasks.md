# Tasks: `update_flow` — Edit Existing Architect Flows

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice A ~300-380 (helpers ~70, tests ~180, index.ts +90, package.json +1) · Slice B ~260-310 (update-flow.ts ~181, index.ts +10, skill docs ~90) |
| 400-line budget risk | Slice A: Medium (close to budget) · Slice B: Low-Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 = Slice A (Phase 1) → PR 2 = Slice B (Phase 2), stacked on main |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Deploy-runner core: `update-helpers.ts` + 12 `node:test` cases + `updateFlow()` orchestrator + `--mode` CLI flag | PR 1 | Base: `main`. Additive only, no existing export touched. Includes empirical verification. |
| 2 | MCP surface: `update-flow.ts` tool + registration + `write-flow` skill docs | PR 2 | Base: PR 1's branch (depends on `updateFlow` signature). Includes empirical verification. |

Out of scope (explicit, not silently dropped): `flowVersion` (SDK param to select "latest"/"published"/"debug"/specific version) — deferred to a future change; SDK default (`"latest"`) applies implicitly.

## Phase 1: Deploy-Runner Core (Slice A)

- [x] 1.1 Create `src/deploy-runner/update-helpers.ts` — `FlowIdentifier` type, `resolveFlowIdentifier(opts)`, `applyUpdateAndSave(flow, mutate, publish)`. Zero top-level side effects (per design.md contract). Satisfies spec: Flow Identifier Resolution, Non-Destructive Update Workflow, Lock Handling, Orphaned Lock Prevention.
  - **Post-implementation review fix (MEDIUM)**: `applyUpdateAndSave` now normalizes non-object rejections (e.g. `throw "boom"`) into an `Error` before attaching the `unlocked` signal, so the signal is never silently lost when user/SDK code throws a bare primitive. Added a covering `node:test` case (13 total now: 6 resolveFlowIdentifier + 7 applyUpdateAndSave).
- [x] 1.2 Create `src/deploy-runner/update-helpers.test.ts` with the 12 `node:test` cases from `design.md` § `node:test` Design (resolve-by-id, resolve-by-name+type, both-given precedence, name-without-type throws, type-without-name throws, neither throws, unlock-on-mutate/checkIn/publish-failure, double-failure, happy-path checkIn/publish).
- [x] 1.3 Add `"test": "node --experimental-strip-types --test src/**/*.test.ts"` to `package.json` scripts; run `pnpm test` and confirm all 12 cases pass.
- [x] 1.4 Add `updateFlow(scripting, absoluteFlowPath, opts)` export to `src/deploy-runner/index.ts`: calls `resolveFlowIdentifier`, `checkoutAndLoadFlowBy{FlowId,FlowName}Async`, dynamic-imports the flow file, calls `mod.updateFlow(scripting, flow)`, then `applyUpdateAndSave`. Widen `emit("result", ...)` payload with `unlocked`/`errorKind`. **Deviation** (see apply-progress): `flowType` is required by the SDK for both id- and name-based checkout (design.md's `FlowIdentifier` "byId" branch omits it) — `updateFlow` now requires `opts.flowType` unconditionally and throws a clear error if absent.
  - **Post-implementation review fixes** (independent fresh-context review found 3 additional issues in this task's code; see apply-progress for full detail):
    - **HIGH — orphaned lock on broken flow file**: the dynamic `import()` of the user's flow file and the check that it exports `updateFlow` now run BEFORE `checkoutAndLoadFlowBy{FlowId,FlowName}Async` (not after). Previously a broken/missing flow file would leave the checkout lock acquired with no code path that releases it, because only `applyUpdateAndSave` guarantees `unlockAsync()`.
    - **HIGH — "no `.name` on `ArchBaseFlow`" was WRONG, corrected**: the installed SDK's `types.d.ts` (`ArchBaseFlow`, ~line 13129) does declare `name: string`. Re-verified directly in `node_modules`. `updateFlow()` now returns `{ flowId: flow.id, flowName: flow.name }` (both taken from the actually-checked-out flow object, non-optional) instead of trusting caller-supplied `opts.flowName` on the byId path.
    - **HIGH — invalid `--mode` fell back to the destructive `create` path silently**: `main()` now rejects (`exit(1)` with a clear error) any `--mode` value other than exactly `"create"` or `"update"`. Only the true default (flag omitted entirely) still resolves to `"create"`, preserving `deploy_flow` backward compatibility.
- [x] 1.5 Add `--mode create|update` CLI flag (default `create`) plus `--flow-id`/`--flow-name`/`--flow-type`/`--force-unlock`/`--publish` args to `main()`; dispatch to existing `buildFlow` path or new `updateFlow` path.
- [x] 1.6 **Empirical verification — DONE, against a real Genesys Cloud org (org "Calidda").** Credentials became available in this environment (`.env`, confirmed with the user before any write operation since the org name indicated a real client org, not an obvious sandbox). Ran the deploy-runner directly (bypassing the MCP layer) against a disposable test flow (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`, inboundcall, flowId `69cd3550-0848-4fd7-a5c7-4be615b20ced`, left for the user to delete manually — no delete tool exists in this plugin):
  - **Core claim confirmed**: after `updateFlow` (check-in mode), the returned `flowId` was byte-identical to the one from the original `deploy_flow` creation. No delete/recreate occurred (proposal Success Criteria #1).
  - **Orphaned-lock prevention confirmed empirically 3 times** across 3 different real failure types (a bug in the test flow file, a duplicate-variable SDK error, and a `publishAsync` validation error) — `unlocked:true` was reported every time, matching the `node:test` suite's simulated coverage.
  - **`publish:true` confirmed to invoke `publishAsync()`** (visible in SDK logs: `"publishAsync - will validate first..."`), distinct from the check-in path. Did not reach a clean publish *success* — the disposable test flow had a pre-existing "no startup object configured" validation ERROR from its own creation (a minimal flow with no actions), which blocks `publishAsync` by design (same as `checkInAsync vs publishAsync` gotcha already documents: publish validates strictly, check-in does not). This is a property of the deliberately-minimal test flow, not a defect in `updateFlow`.
  - See task 2.6 for the `not-found`/`type-mismatch` findings gathered in the same session (same empirical pass, feeds `classifyUpdateError()` fixes applied on top of this task).

## Phase 2: MCP Tool + Docs (Slice B — depends on Phase 1)

- [ ] 2.1 Create `src/mcp-server/tools/update-flow.ts`: zod schema + `.refine()` (per `design.md` § Zod Schema), spawn `deploy-runner --mode update`, reuse `deploy-flow.ts`'s NDJSON parse loop unmodified, map `errorKind` to the 4 distinct messages in `design.md` § Differentiated Error Handling.
- [ ] 2.2 Register `update_flow` in `src/mcp-server/index.ts`: import, instantiate with the same config object as `deployFlow`, `server.registerTool("update_flow", ...)` immediately after `deploy_flow`'s registration.
- [ ] 2.3 Update `skills/write-flow/SKILL.md`: add a branch question (new flow vs. update existing) and a new "Updating an Existing Flow" section documenting the `update_flow` tool contract.
- [ ] 2.4 Update `skills/write-flow/references/sdk-patterns.md`: document `updateFlow(scripting, flow): Promise<void>` (edits-only, no `checkInAsync`/`publishAsync` call) alongside `buildFlow`.
- [ ] 2.5 Update `skills/write-flow/references/gotchas.md`: promote the existing `checkoutAndLoadFlowByFlowNameAsync` footnote to a full section describing the new non-destructive update flow.
- [ ] 2.6 **Empirical verification — PARTIALLY DONE, against the real "Calidda" org.** Same session as 1.6:
  - **(b) nonexistent `flowId`** — confirmed. Exact SDK text: `"Could not find flow with specified ID. (architect.flow.not.found)"` (HTTP 404, from `checkoutAndLoadFlowByFlowIdAsync`). `classifyUpdateError()` fixed on this branch to recognize it as `not-found` (previously fell through to `unknown`).
  - **(b) nonexistent `flowName`** — confirmed. Exact SDK text: `"no matches"` (a generic internal SDK lookup-failure message, not an HTTP error). Also now classified as `not-found`.
  - **(c) mismatched `flowType` — found to be UNREACHABLE, not a bug.** Empirically confirmed two things: (1) checkout **by `flowId`** does not enforce `flowType` at all — a real `flowId` with an unrelated `flowType` string still succeeds; (2) checkout **by `flowName`** with the wrong `flowType` returns the exact same `"no matches"` response as a name that doesn't exist under any type — the SDK gives no distinguishing signal. `classifyUpdateError()`'s `"type-mismatch"` kind is kept in the `UpdateErrorKind` union for API completeness (harmless/documented as unreachable) but is no longer actively guessed at by regex, since doing so was never correct.
  - **(a) flow locked by another user — NOT verified.** Requires a second real user/OAuth identity holding a conflicting lock; out of scope for solo verification per user's explicit decision (2026-07-16).
  - **`architect:flow:edit` exact permission scope — NOT verified.** Would require deliberately stripping the OAuth client's role permissions in the org's admin settings to trigger a real 403, which the user explicitly declined to do (higher-risk, touches live org config). All empirical calls in this session succeeded, confirming whatever permission the client's current role grants is sufficient, but not isolating the exact permission name.
