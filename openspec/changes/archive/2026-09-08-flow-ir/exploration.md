# Exploration: flow-ir — native replacement for `@makingchatbots/genesys-cloud-architect-diagram-lib`

## Current State

Three ported MCP tools on branch `feat/adopt-upstream-flow-ir` (uncommitted, staged) are blocked on a private npm package: `src/mcp-server/tools/flow-ir.ts` (imports `parseFlow`, `type IRTask`), `flow-action.ts` (`findRawActions`, `type RawActionLookup`), `search-in-flow.ts` (`searchRawActions`, `type RawActionSearchMatch`). Two sibling tools already work with no dependency: `fetch-flow-configuration.ts` (wraps `architectApi.getFlowLatestconfiguration(flowId): Promise<object>` — confirmed untyped in `node_modules/purecloud-platform-client-v2/index.d.ts`, no official schema exists) and `find-flow.ts`.

The package `@makingchatbots/genesys-cloud-architect-diagram-lib` lives on GitHub Packages under the `MakingChatbots` org and is confirmed **private**: a PAT with `read:packages` scope still gets `403 Forbidden`, and no public source repo exists under the org for it.

`skills/interpret-flow-ir/SKILL.md` is the real, richer spec for the contract (more precise than any summary): `parseFlow` returns `{ok:true, ir:{flowName, flowType, entryTaskId?, reachabilityIsComplete, tasks:{id,name,reusable}[], nodes}, warnings}` or `{ok:false, error:{code,message}}`. Each node carries `id, kind, actionType?, label, description?, predecessors[{id,label?,backEdge}], successors[...], order (DFS), taskId, taskName, reachable, terminal`. ID scheme confirmed against the tool source itself: action ids = raw Architect GUID; task-start = `<taskId>::start`; branch-output = `<actionId>::<outputId>` (both `flow-action.ts` and `search-in-flow.ts` strip the `::` suffix). Warning codes to reproduce: `UNKNOWN_ACTION_TYPE`, `UNRESOLVED_INTENT_FANOUT`, `UNRESOLVED_REFERENCE`, `UNRESOLVED_INITIAL_SEQUENCE`, `DISABLED_BRANCH`, `DROPPED_EDGE`, `UNRESOLVED_CALL_TASK` (reserved), `MISSING_ACTION_ID`/`DUPLICATE_ACTION_ID`.

`read-flow.ts` and `src/deploy-runner/*` do **not** parse raw flow JSON at all — they drive the Architect Scripting SDK's `loadFlowBy...Async` + `exportToObjectAsync(..., FLOW_FORMAT_TYPES.yaml)`, a different code path entirely. **No reusable JSON-walking logic exists anywhere in this repo.** No real Architect flow-configuration JSON fixture exists either. The only in-repo ground truth for raw shape: `search-in-flow.ts`'s own `isSearchable()` guard (`flowSequenceItemList` must be an array), the SKILL.md's "Common raw shapes" section (`action.expression.text`, `cases[].value.text`/`referenceId` ↔ `paths[].outputId`), and — valuably — the committed, bundled `servers/genesys-cloud-architect-mcp.js`/`bin/deploy-runner.js` esbuild outputs, which embed the **Architect Scripting SDK's own** minified internals and reveal real field names: `flowSequenceItemList` (task/state containers), `actionList` (`{id, trackingId, name, type/__type}`), `menuChoiceList` (choices bundle their action inline under `.action`), `startAction`, `initialSequence`.

Confirmed stale: `openspec/config.yaml`'s `testing` section claims "no test runner installed, zero automated tests" — false. `package.json` has `"test": "node --experimental-strip-types --test $(find src -name '*.test.ts' | sort)"` and 3 real files exist: `src/mcp-server/tools/read-flow.test.ts`, `update-flow.test.ts`, `src/deploy-runner/update-helpers.test.ts`, all on Node's built-in `node:test` runner. This should be corrected. `@makingchatbots/genesys-cloud-architect-diagram-lib` remains in `package.json` devDependencies and should be removed once unused.

## Affected Areas

- `src/mcp-server/tools/flow-ir.ts`, `flow-action.ts`, `search-in-flow.ts` — import-path swap only once the native module satisfies the contract.
- New module (location TBD in design) — owns `parseFlow`/`findRawActions`/`searchRawActions`; this is the real engineering surface (graph build + DFS + reachability + warnings).
- `package.json` — remove the private devDependency once unused.
- No changes needed to `fetch-flow-configuration.ts`, `find-flow.ts`, `read-flow.ts`, `src/deploy-runner/*`.

## Approaches

1. **Generic recursive wiring walk** (treat every action uniformly via common `outputs`/`paths[]`/`disabled` shape) — Pros: least code, naturally forward-compatible for unknown types. Cons: menu choices, intent fan-out, and task-jump ids are not structurally generic and risk silent misclassification. Effort: Low-Medium, medium correctness risk.
2. **Type-specific per-action-type handlers** (explicit handler per Architect `__type`) — Pros: most faithful, easiest to test per-type. Cons: dozens of types to enumerate; highest effort/code. Effort: High.
3. **Hybrid — generic base walk + explicit handling only for documented exceptions** (task jumps → `<taskId>::start`, Switch `cases[].referenceId ↔ paths[].outputId`, inline menu-choice actions, intent-listen exclusion, no loop back-edge synthesis) — Pros: mirrors how SKILL.md itself is organized (one rule + named exceptions), proportional diff, forward-compatible fallback. Cons: still depends on an unverified "common shape" assumption until a real fixture is captured. Effort: Medium.

## Recommendation

Approach 3 (hybrid). Smallest design that satisfies the documented contract without enumerating every Architect action type, and it mirrors the spec's own structure. Before implementation, `sdd-apply`/`sdd-tasks` must fetch and check in at least one real flow configuration via the already-working `fetch-flow-configuration`/`find-flow` tools — there is zero raw JSON to validate any assumption against today, and the private library's real algorithm is uninspectable (403 confirmed, no public mirror).

## Risks

- No real raw flow-config JSON fixture exists; shape is reconstructed from docs + a bundled third-party SDK, not an actual sample.
- The private library's exact DFS/reachability/back-edge/order semantics are unknown and unverifiable — reimplementation is clean-room from *observable* documented behavior, so subtle divergences are possible and should be flagged provisional in `design.md`.
- `openspec/config.yaml` testing metadata is stale and should be corrected as part of, or immediately after, this change.
- Warning-code fidelity (`UNRESOLVED_INTENT_FANOUT` × `reachabilityIsComplete`, `DISABLED_BRANCH`'s "edges remain, warning is the only signal") is easy to get subtly wrong without per-code synthetic fixtures in addition to one real captured flow.

## Ready for Proposal

Yes. Contract is fully documented, blocked files confirmed as near-zero-change consumers, and the missing-fixture risk is an actionable pre-step, not an open design question. Recommended `sdd-propose` scope: native flow-configuration parser module (`parseFlow`/`findRawActions`/`searchRawActions`), hybrid generic+exception design, validated against one captured real flow fixture, plus flag the `openspec/config.yaml` testing staleness as included or fast-follow.
