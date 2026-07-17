# Proposal: `update_flow` — Edit Existing Architect Flows Without Delete-and-Recreate

## Intent

`createFlow<Type>Async` is the only way to persist flow changes today — it
**deletes and recreates** any flow sharing the same name, destroying
history and publish state. `write-flow`'s `gotchas.md` already footnotes
the real fix (`checkoutAndLoadFlowByFlowNameAsync`) but no workflow
implements it. This change ships a safe, non-destructive edit path.

## Scope

### In Scope
- `updateFlow(scripting, opts)` in `src/deploy-runner/index.ts` using
  `checkoutAndLoadFlowByFlowNameAsync`/`ByFlowIdAsync`; captures
  `flow.id`/`flow.name` off the returned object directly.
- Pure identifier-resolution logic (flowId vs. flowName+flowType).
- Catch path calls `unlockAsync()` on checkout-success/checkIn-failure
  (orphaned-lock prevention).
- `node:test` for the two items above only; add `"test": "node --test"`
  to `package.json`.
- New MCP tool `update_flow` (`src/mcp-server/tools/update-flow.ts` +
  registration), zod `.refine()` requiring exactly one of `flowId` or
  (`flowName` + `flowType`), `forceUnlock` (default `false`),
  `destructiveHint: true`.
- `write-flow` skill: branch question, new "Updating an Existing Flow"
  section, promoted gotcha.

### Out of Scope
- Full vitest migration or project-wide `strict_tdd: true`.
- Any change to `deploy_flow`/`createFlow*Async`.
- Merging create/update into one tool or param.
- Confirming `architect:flow:edit` permission or SDK behavior on wrong
  `flowType` — deferred to empirical verification in `sdd-apply`.

## Capabilities

### New Capabilities
- `update-flow`: checkout-edit-checkin/publish workflow, via
  `update_flow` MCP tool and `updateFlow` export.

### Modified Capabilities
None — `deploy_flow`/`createFlow*Async` untouched.

## Approach

Dedicated `update_flow` tool, not a `mode` param on `deploy_flow`: MCP
annotations are static per-tool, so "non-destructive" can't be expressed
inside a shared tool, and inferring mode from name alone is unsafe.
`deploy-runner/index.ts` gets a second export, `updateFlow`, mirroring
`buildFlow`'s contract but calling checkout+load instead of create.
Identifier resolution is a pure, `node:test`-tested function against a
fake SDK object — narrow extraction, not a runner migration. Delivered as
2 stacked-to-main slices: Slice A (deploy-runner core + tests), Slice B
(MCP tool + skill docs, depends on A).

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `src/deploy-runner/index.ts` (379 lines) | Modified | Add `updateFlow` + resolver; create path untouched |
| `src/mcp-server/tools/update-flow.ts` | New | zod schema, spawn+NDJSON (mirrors `deploy-flow.ts`, 181 lines) |
| `src/mcp-server/index.ts` | Modified | Register `update_flow` |
| `skills/write-flow/*` | Modified | Update workflow, contract, promoted gotcha |
| `package.json` | Modified | Add `"test": "node --test"` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| Orphaned lock on checkIn/publish failure post-checkout | Medium | Catch MUST call `unlockAsync()`; covered by `node:test` |
| `forceUnlock` discards another user's unsaved UI edits | Medium | Document as destructive on a different axis; default `false` |
| `architect:flow:edit` permission unconfirmed in docs | Low-Med | Verify empirically in `sdd-apply` |
| SDK behavior on mismatched `flowType` unconfirmed | Low-Med | Verify empirically; surface real error, don't collapse |
| Still mutates a live production org | Medium | Same posture as `deploy_flow`; description clarifies "no delete" |

## Rollback Plan

Both slices are additive — no existing export/tool/schema modified in
place.
- **Slice B**: revert `update-flow.ts` + its registration; `deploy_flow`
  unaffected.
- **Slice A**: revert `updateFlow`/resolver + `node:test` files/script;
  create path keeps working.
- Live-org fallback: checkout doesn't delete — version history allows
  manual restore, safer than create's rollback story.

## Dependencies

- Slice B depends on Slice A's `updateFlow` signature landing first.
- Empirical SDK/permission verification during `sdd-apply`.

## Success Criteria

- [ ] `updateFlow` checks out/edits/checks in without deleting, verified
      against a real dev org.
- [ ] Catch path calls `unlockAsync()` on checkin failure post-checkout,
      covered by `node:test`.
- [ ] `update_flow` registered, `.refine()`-validated, distinct errors for
      locked/not-found/type-mismatch.
- [ ] `write-flow` documents update as the primary edit path.
- [ ] `architect:flow:edit` permission confirmed empirically.
