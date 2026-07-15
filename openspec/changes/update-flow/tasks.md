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
- [ ] 1.6 **BLOQUEADA — sin credenciales Genesys Cloud en este entorno.** No `GENESYS_REGION`/`GENESYS_CLIENT_ID`/`GENESYS_CLIENT_SECRET` available (no `.envrc`, nothing in shell env). Empirical verification (real org, run during `sdd-apply`): deploy a flow via `deploy_flow`, then run `updateFlow` end-to-end against it in both check-in and publish modes on a real Genesys Cloud dev org. Confirm `flowId` and version history are preserved and no `createFlow<Type>Async`/delete call fires (proposal Success Criteria #1). **To unblock**: supply real `GENESYS_REGION`/`GENESYS_CLIENT_ID`/`GENESYS_CLIENT_SECRET` for a dev org with `architect:flow:edit` (and ideally `architect:flow:unlock`) permissions, then re-run this task in a follow-up `sdd-apply` batch.

## Phase 2: MCP Tool + Docs (Slice B — depends on Phase 1)

- [ ] 2.1 Create `src/mcp-server/tools/update-flow.ts`: zod schema + `.refine()` (per `design.md` § Zod Schema), spawn `deploy-runner --mode update`, reuse `deploy-flow.ts`'s NDJSON parse loop unmodified, map `errorKind` to the 4 distinct messages in `design.md` § Differentiated Error Handling.
- [ ] 2.2 Register `update_flow` in `src/mcp-server/index.ts`: import, instantiate with the same config object as `deployFlow`, `server.registerTool("update_flow", ...)` immediately after `deploy_flow`'s registration.
- [ ] 2.3 Update `skills/write-flow/SKILL.md`: add a branch question (new flow vs. update existing) and a new "Updating an Existing Flow" section documenting the `update_flow` tool contract.
- [ ] 2.4 Update `skills/write-flow/references/sdk-patterns.md`: document `updateFlow(scripting, flow): Promise<void>` (edits-only, no `checkInAsync`/`publishAsync` call) alongside `buildFlow`.
- [ ] 2.5 Update `skills/write-flow/references/gotchas.md`: promote the existing `checkoutAndLoadFlowByFlowNameAsync` footnote to a full section describing the new non-destructive update flow.
- [ ] 2.6 **Empirical verification (real org, run during `sdd-apply`)**: trigger and capture exact SDK error text/status for (a) flow locked by another user, (b) nonexistent `flowId`/`flowName`, (c) mismatched `flowType`; confirm/adjust the `errorKind` mapping in `index.ts`/`update-flow.ts` accordingly. Separately confirm the `architect:flow:edit` permission scope is the one actually required (test with a role lacking it, expect a 403/permission error).
