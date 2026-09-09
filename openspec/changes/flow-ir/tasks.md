# Tasks: Native `flow-ir` Parser

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~80-150 (fixture fetch/scrub + config.yaml fix, mostly generated JSON) · PR2 ~350-420 (`flow-ir-parser.ts` + tests + synthetic fixtures) · PR3 ~150-220 (`raw-action-lookup.ts` + tests + wiring + cleanup) |
| 400-line budget risk | PR1 Low · PR2 High · PR3 Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (fixture+config) → PR2 (parser) → PR3 (lookup+wiring+cleanup), stacked on main |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Real fixture capture+scrub + `openspec/config.yaml` testing-section fix | PR 1 (base: `feat/adopt-upstream-flow-ir`) | N/A (no code yet) | `find_flow`/`fetch-flow-configuration` against org "Calidda", flow `ZZZ-SDD-Test-DoNotUse-UpdateFlow` (`69cd3550-0848-4fd7-a5c7-4be615b20ced`) | Delete fixture file + revert config.yaml edit; nothing depends on it yet |
| 2 | `flow-ir-parser.ts` (`parseFlow`, `enumerateRawActions`) + tests | PR 2 (base: PR1 branch) | `node --experimental-strip-types --test src/mcp-server/tools/flow-ir-parser.test.ts` | Manual `parseFlow(realFixture)` against real Calidda flow (in test) | Revert new parser file + its test + synthetic fixtures; PR1's fixture stays valid, unused |
| 3 | `raw-action-lookup.ts` + import-path swap in 3 tools + devDependency/`.npmrc` removal + full verification | PR 3 (base: PR2 branch) | `pnpm test` (all `*.test.ts`) | `flow_ir`/`flow_action`/`search_in_flow` end-to-end against real Calidda flow | Revert lookup file/test + tool import paths + package.json/.npmrc; PR1+PR2 stay valid, unused |

## Phase 1: Real Fixture + Stale Config Fix (PR 1)

- [x] 1.1 Call `find_flow` for `ZZZ-SDD-Test-DoNotUse-UpdateFlow` in org "Calidda" (flowId `69cd3550-0848-4fd7-a5c7-4be615b20ced`), then `fetch-flow-configuration` to get the raw flow-configuration JSON. Done via a one-off script (credentials now present in `.env`); MCP server itself was not re-checked (script mirrors its exact auth pattern, equivalent result).
- [x] 1.2 Scrub customer-identifying string values (org name, phone numbers, real queue/user names) from the captured JSON without altering structure or field names; save as `src/mcp-server/tools/__fixtures__/real-calidda-flow.json`. **Finding: nothing to scrub.** The captured flow contains no org name, phone number, or real queue/user name anywhere — it is the disposable marker-variable test flow used by `update_flow`'s own empirical tests (description: "Disposable test flow created to empirically verify the update_flow MCP tool"). Saved verbatim.
- [x] 1.3 From the real fixture, resolve design's Open Questions: confirm/correct `paths` vs `outputs`, the task-reference field name, `menuChoiceList` choice shape, and the `reusable` task-flag key. **Not resolvable from this fixture**: `flowSequenceItemList` is an empty array (`[]`) — this flow has zero tasks and zero actions (it exists only to hold `variables[]` entries added by `update_flow`/`update-flow-safeguards` tests, not to exercise Architect action wiring). None of the four open questions can be confirmed or corrected empirically. Design's multi-key defensive-probing approach (already chosen specifically to derisk unconfirmed field names) is kept as specified, unconfirmed. This is a genuine gap versus the proposal's expectation that the designated real fixture would carry real wiring to inspect; noted in `apply-progress.md` and the Open Questions section of `design.md` remains open, not resolved by this task.
- [x] 1.4 Correct `openspec/config.yaml`'s `testing` section: set `strict_tdd: true`, `test_command: "pnpm test"` (or the exact `node --experimental-strip-types --test $(find src -name '*.test.ts' | sort)` script), update `reason` to reflect the 3 existing passing `node:test` files, and update `rules.apply.tdd`/`test_command` and `rules.verify.test_command` to match.
- [x] 1.5 **Empirical verification** — confirm the saved fixture round-trips as valid JSON (`node -e "require('./src/mcp-server/tools/__fixtures__/real-calidda-flow.json')"` or equivalent) and that no scrubbed value broke `flowSequenceItemList` structure. Verified: valid JSON, `flowSequenceItemList` is an array (empty, `length: 0`), `flowName`/`flowType` preserved (`ZZZ-SDD-Test-DoNotUse-UpdateFlow` / `inboundcall`). No scrubbing was applied (1.2), so nothing could have broken structure.

## Phase 2: `flow-ir-parser.ts` — `parseFlow` (PR 2, base = PR1 branch)

- [x] 2.1 RED — `flow-ir-parser.test.ts`: `parseFlow` returns `{ok:false}` (not throw) for missing/non-array `flowSequenceItemList` (spec: parseFlow Contract). Committed 4c87707.
- [x] 2.2 GREEN — `flow-ir-parser.ts`: precondition guard + `{ok:false, error}` return path; `enumerateRawActions()` primitive (tolerant, never throws, walks `flowSequenceItemList[].actionList[]` + inline `menuChoiceList[].action`). Committed 4c87707.
- [x] 2.3 RED — synthetic fixtures `warnings/missing-duplicate-action-id.json`; tests asserting `MISSING_ACTION_ID` and `DUPLICATE_ACTION_ID` (spec: Warning Code Emission). Committed 4c87707.
- [x] 2.4 GREEN — graph build step: one `task-start` node per task (`<taskId>::start`), one `action` node per first `actionId` occurrence, drop/warn on missing or duplicate ids. Committed 4c87707.
- [x] 2.5 RED — synthetic fixture `warnings/unresolved-reference.json`; test asserting `UNRESOLVED_REFERENCE` on an unresolvable task-jump (spec: Warning Code Emission, Node ID Scheme task-start id).
- [x] 2.6 GREEN — task-jump probe (`raw.task?.id ?? raw.taskId ?? raw.destinationTaskId`), direct edge to `<taskId>::start`, `UNRESOLVED_REFERENCE` on miss.
- [x] 2.7 RED — synthetic fixture with a `menuChoiceList` task; test asserting each choice becomes a `branch-output` node with the choice's inline action wired as successor (spec: Inline menu-choice action).
- [x] 2.8 GREEN — menu-choice expansion step per design step 3b.
- [x] 2.9 RED — synthetic fixture `warnings/unresolved-intent-fanout.json`; test asserting `UNRESOLVED_INTENT_FANOUT` and `ir.reachabilityIsComplete === false`.
- [x] 2.10 GREEN — `INTENT_FANOUT_ACTION_TYPES` seeded allowlist + intent-fan-out exclusion step (design step 3c).
- [x] 2.11 RED — synthetic fixtures `warnings/disabled-branch.json`, `warnings/dropped-edge.json`; tests asserting `DISABLED_BRANCH` (edges stay in graph) and `DROPPED_EDGE` (edge discarded) (spec: DISABLED_BRANCH, DROPPED_EDGE scenarios).
- [x] 2.12 GREEN — generic outputs probe (`raw.paths ?? raw.outputs`, else `raw.nextAction ?? raw.nextActionId` fall-through), `branch-output` node creation (`<actionId>::<outputId>`), `DISABLED_BRANCH`/`DROPPED_EDGE` emission (design step 3d).
- [x] 2.13 RED — synthetic fixture `warnings/unknown-action-type.json`; test asserting a generic node is still produced plus `UNKNOWN_ACTION_TYPE` (spec: UNKNOWN_ACTION_TYPE scenario).
- [x] 2.14 GREEN — `TERMINAL_ACTION_TYPES` seeded allowlist + zero-outputs terminal/`UNKNOWN_ACTION_TYPE` step (design step 3e) + `TERMINAL_BRANCH_OUTCOMES` terminal-branch-output rule (design step 4).
- [x] 2.15 RED — synthetic fixture `warnings/unresolved-initial-sequence.json`; test asserting `UNRESOLVED_INITIAL_SEQUENCE` and absent `ir.entryTaskId`.
- [x] 2.16 GREEN — `initialSequence` resolution against task ids, entryTaskId assignment/omission.
- [ ] 2.17 RED — synthetic minimal cyclic fixture; tests asserting DFS `order` pre-order numbering, `backEdge:true` on the cycle-closing edge (both directions), `reachable:false` for an orphaned action.
- [ ] 2.18 GREEN — iterative DFS pass (design step 5): white/gray/black coloring, per-root traversal in `flowSequenceItemList` order, `order`/`reachable`/`backEdge` assignment.
- [ ] 2.19 RED — test asserting `UNRESOLVED_CALL_TASK` is never emitted by any current fixture (spec: UNRESOLVED_CALL_TASK reserved scenario).
- [ ] 2.20 Test `parseFlow(real-calidda-flow.json)`: assert `{ok:true}`, sane `ir.tasks`/`ir.nodes` shape, and trace at least one full path from an entry task-start to a terminal node using the real fixture's actual field names confirmed in task 1.3.
- [ ] 2.21 **Empirical verification** — run `pnpm test src/mcp-server/tools/flow-ir-parser.test.ts` (or equivalent focused command); all cases green, including the real-fixture trace from 2.20.

## Phase 3: `raw-action-lookup.ts` + Wiring + Cleanup (PR 3, base = PR2 branch)

- [ ] 3.1 RED — `raw-action-lookup.test.ts`: `findRawActions` returns found/notFound covering every requested id exactly once; malformed configuration never throws (spec: findRawActions Lookup, Not-found ids).
- [ ] 3.2 GREEN — `raw-action-lookup.ts`: `findRawActions(configuration, actionIds)` built on `enumerateRawActions()` imported from `flow-ir-parser.ts`.
- [ ] 3.3 RED — test: a `<actionId>::<outputId>` suffixed id resolves to the underlying action (spec: Synthetic suffixed id resolved); a batch mixing found/not-found/suffixed ids accounts for every distinct GUID exactly once (spec: Mixed batch).
- [ ] 3.4 GREEN — suffix-stripping in `findRawActions` per design (`flow-action.ts`'s `planLookups` already strips before calling; confirm `findRawActions` itself also tolerates a suffixed id defensively per spec).
- [ ] 3.5 RED — `searchRawActions` tests: literal substring match, regex match, case sensitivity (both `true`/`false`), object keys never match (spec: searchRawActions Content Search scenarios).
- [ ] 3.6 GREEN — `searchRawActions(configuration, query, opts)`: string-leaf-only recursive walk, naive unescaped `parent.key`/`parent.index` path building, literal/regex/case-fold matching.
- [ ] 3.7 RED — tests: `maxMatchesPerAction` truncation sets `truncated:true`; zero-matches on a well-formed configuration returns `hasMatches:false` distinct from an error on an unsearchable configuration (spec: maxMatchesPerAction truncation, Zero matches vs. unsearchable configuration).
- [ ] 3.8 GREEN — per-occurrence match cap + truncation flag; `hasMatches:false` vs. error-path distinction reusing `enumerateRawActions()`'s tolerant-empty behavior.
- [ ] 3.9 **Empirical verification** — run `pnpm test src/mcp-server/tools/raw-action-lookup.test.ts` (or equivalent); all cases green, including a real-fixture `findRawActions`/`searchRawActions` call.
- [ ] 3.10 Swap import in `src/mcp-server/tools/flow-ir.ts` line 4: `"@makingchatbots/genesys-cloud-architect-diagram-lib"` → `"./flow-ir-parser.ts"`. No other line changes.
- [ ] 3.11 Swap import in `src/mcp-server/tools/flow-action.ts` line 4: same package → `"./raw-action-lookup.ts"`. No other line changes.
- [ ] 3.12 Swap import in `src/mcp-server/tools/search-in-flow.ts` line 4: same package → `"./raw-action-lookup.ts"`. No other line changes.
- [ ] 3.13 Remove `@makingchatbots/genesys-cloud-architect-diagram-lib` from `package.json` `devDependencies`; remove the `@makingchatbots:registry=https://npm.pkg.github.com` line from `.npmrc` (confirmed only reference besides the 3 swapped imports and this line — `.claude-plugin/plugin.json`'s `makingchatbots.com` URL is unrelated and stays); run `pnpm install` to refresh the lockfile.
- [ ] 3.14 Full verification: `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test` (all `*.test.ts` — the 3 pre-existing files plus the 2 new ones — must pass).
- [ ] 3.15 **Empirical verification (real org)** — invoke `flow_ir`, `flow_action`, and `search_in_flow` end-to-end against the real Calidda test flow (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`, `69cd3550-0848-4fd7-a5c7-4be615b20ced`) via the MCP server; confirm each produces the same envelope shape as before the import swap (spec: End-to-end tool behavior unchanged).
