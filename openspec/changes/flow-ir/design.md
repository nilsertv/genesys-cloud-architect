# Design: Native `flow-ir` Parser

## Technical Approach

Two new flat modules in `src/mcp-server/tools/` (no new `lib/` subdirectory —
this repo has no such precedent; `fetch-flow-configuration.ts` already shows
the convention of a shared, non-tool helper living directly beside the tools
that import it, and `update-helpers.ts` shows the "pure, node:test-able,
zero top-level side effects" shape to copy):

- **`flow-ir-parser.ts`** — `parseFlow` (graph build, generic wiring walk,
  DFS order/reachable/terminal, warnings) plus the shared low-level
  `enumerateRawActions()` primitive.
- **`raw-action-lookup.ts`** — `findRawActions` and `searchRawActions`,
  both built on `enumerateRawActions()` imported from `flow-ir-parser.ts`.

Approach 3 from the proposal (generic wiring walk + named exceptions) is
implemented as: one generic "normalize this action's outputs" probe, applied
to every action uniformly, with four documented deviations (task jumps, menu
choices, intent-listen exclusion, no back-edge synthesis) implemented as
extra steps around the generic probe rather than as per-`__type` branches.
Every place where a real Architect JSON field name is unconfirmed (no real
fixture exists yet) uses **defensive multi-key probing** instead of a single
hardcoded key, and every place where "is this type special" is a judgment
call uses a **small named exported allowlist that ships thin and grows
one line at a time** — the same pattern `update-helpers.ts` already
established with `KNOWN_VOLATILE_FLOW_PATHS`.

## Architecture Decisions

| Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|
| Module layout | 2 flat files in `src/mcp-server/tools/` (+ 2 test files), no new directory | `src/mcp-server/lib/flow-ir/` with per-concern sub-files | No `lib/` directory exists anywhere in this repo; `fetch-flow-configuration.ts` is the exact precedent for a shared non-tool helper living flat in `tools/`. Fewer files, same testability |
| Unconfirmed raw field names | Multi-key probing (`raw.paths ?? raw.outputs`, `raw.nextAction ?? raw.nextActionId`, `raw.task?.id ?? raw.taskId ?? raw.destinationTaskId`) | Hardcode one key per the SKILL.md's best-guess shape | No real fixture exists at design time (proposal risk); probing derisks a wrong single guess without adding real complexity — one `??` chain per field |
| Type-specific judgment calls | Small named exported `const` allowlists (`TERMINAL_ACTION_TYPES`, `TERMINAL_BRANCH_OUTCOMES`, `INTENT_FANOUT_ACTION_TYPES`), seeded conservatively, extended empirically in `sdd-apply` against the real Calidda fixture | Enumerate every Architect `__type` up front (proposal's rejected Approach 2) | Mirrors `KNOWN_VOLATILE_FLOW_PATHS`'s already-proven shape in this repo; extending a list is a one-line diff, not an algorithm change |
| Switch `cases[]`/`paths[]` handling | No special case in the graph builder — `cases[].referenceId ↔ paths[].outputId` is a **raw-JSON reading concern for callers** (per SKILL.md's `flow_action` guidance), not a wiring concern; `paths[]` already flows through the generic outputs probe | Special-case `SwitchAction` in `parseFlow` | `cases[]` carries case *values*, which `parseFlow` never needs — only `paths[].outputId` (wiring) matters to the graph, and that's already generic |
| Back-edges | Never synthesized; DFS classifies an edge to a "gray" (on-stack) node as `backEdge:true` live during traversal | Pre-detect cycles and inject edges | Matches the proposal's "no synthetic loop back-edges" exception exactly; a real cycle only appears if the raw wiring actually has one |
| `id` stripping (`<actionId>::<outputId>`) | Stays entirely in the existing tool-layer `planLookups()` (`flow-action.ts`); `findRawActions` receives already-plain GUIDs | Duplicate stripping inside the new library | Verified by reading `flow-action.ts`: stripping and re-mapping to the requested form already happen there, unchanged by this proposal (import-path-only diff) |
| Hard-error boundary | `parseFlow` returns `{ok:false}` ONLY when `configuration` isn't a non-null non-array object with an array `flowSequenceItemList` | Also hard-error on missing `flowName`/unresolved entry/etc. | Mirrors `search-in-flow.ts`'s existing `isSearchable()` guard exactly (task's explicit instruction); everything else is a real, legally-malformed-but-still-a-flow condition that a published Architect flow can contain, so it degrades to a warning, never a thrown error |

## Parsing Algorithm

**1. `enumerateRawActions(configuration)`** (shared primitive, tolerant —
never throws): walks `flowSequenceItemList[].actionList[]` and, for every
item carrying a `menuChoiceList`, each choice's inline `.action`. Yields one
`{ actionId, taskId, taskName, raw, menuChoice? }` per occurrence (an id can
recur, e.g. duplicated data). Malformed/absent `flowSequenceItemList` yields
zero occurrences rather than throwing — callers needing a hard error
(`parseFlow`) check the precondition themselves first.

**2. Graph build** (`parseFlow` only): one `task-start` node per
`flowSequenceItemList` item (`<taskId>::start`). One `action` node per
**first** occurrence of each `actionId` (a repeat emits `DUPLICATE_ACTION_ID`
and is otherwise ignored for wiring); an occurrence with no id at all emits
`MISSING_ACTION_ID` and is dropped from the id index entirely.

**3. Wiring, per action, in this order:**
   a. **Task-jump probe** (exception): if a task-reference field
      (`raw.task?.id ?? raw.taskId ?? raw.destinationTaskId`) is present,
      resolve it against the task-id set → one unlabeled edge straight to
      `<taskId>::start`, or `UNRESOLVED_REFERENCE` if it doesn't resolve.
      No branch-output node is created for this edge.
   b. **Menu-choice expansion** (exception): for a task item with a
      `menuChoiceList`, its `startAction` gets one synthetic `branch-output`
      child per choice (`<startActionId>::<choiceId-or-index>`, labeled by
      the choice's name/digit), successor = the choice's inline action id
      (already indexed in step 2).
   c. **Intent-fan-out exclusion** (exception): if `actionType` (`raw.type ??
      raw.__type`) is in `INTENT_FANOUT_ACTION_TYPES`, skip wiring entirely
      for this action, set `reachabilityIsComplete = false` flow-wide, emit
      `UNRESOLVED_INTENT_FANOUT`.
   d. **Generic outputs probe** (base rule, everything else): normalize via
      `raw.paths ?? raw.outputs` (array) else a single `raw.nextAction ??
      raw.nextActionId` (bare fall-through, no `outputId`). Each array entry
      with an `outputId` gets a `branch-output` node
      (`<actionId>::<outputId>`) — created even when `disabled` (its edges
      stay in the graph; `DISABLED_BRANCH` is the only signal, per SKILL.md).
      A bare fall-through wires the action directly to its target, no
      branch-output node. Either way the target resolves against the action
      index, then the task-id set (`<taskId>::start`); an unresolved
      *present* target emits `DROPPED_EDGE`; an absent target is a legitimate
      dangling outcome (no warning).
   e. Anything left with **zero discovered outputs**: `terminal:true`, no
      warning, if `actionType ∈ TERMINAL_ACTION_TYPES`; otherwise
      `UNKNOWN_ACTION_TYPE` (still `terminal:true` as the safe default — the
      warning is the uncertainty signal).

**4. `terminal` for branch-output nodes**: `true` only when it has zero
successors AND its `(parentActionType, outcomeLabel)` pair is in
`TERMINAL_BRANCH_OUTCOMES` (e.g. a Transfer's "Success"); otherwise a
zero-successor branch-output is `terminal:false` — the "silently drops out"
gap the SKILL.md's "Missing error handling" recipe finds. Any node with ≥1
successor is always `terminal:false`. `task-start` nodes are never terminal.

**5. DFS pass**: iterative (explicit stack, not recursion, for large-flow
safety), one root per `task-start` node, roots visited in
`flowSequenceItemList` declaration order, successors visited in the order
their edges were added. `order` is assigned on first visit (pre-order).
White/gray/black coloring: an edge to a gray (on-stack) node is
`backEdge:true` on that edge only, both directions; an edge to an
already-black node is a normal (non-back) edge, not re-ordered.
`reachable = visited-from-any-root`.

## Warning-Code Trigger Conditions

| Code | Fires when |
|---|---|
| `UNKNOWN_ACTION_TYPE` | An action has zero discovered outputs (step 3e) and its type is not in `TERMINAL_ACTION_TYPES` |
| `UNRESOLVED_INTENT_FANOUT` | Action type is in `INTENT_FANOUT_ACTION_TYPES` (step 3c) — one per occurrence |
| `UNRESOLVED_REFERENCE` | A task-reference field (step 3a) names a taskId absent from `flowSequenceItemList` |
| `UNRESOLVED_INITIAL_SEQUENCE` | Top-level `initialSequence` doesn't match any task id — `entryTaskId` is omitted |
| `DISABLED_BRANCH` | A normalized output (step 3d) has `disabled: true` — regardless of whether its target also resolves |
| `DROPPED_EDGE` | A present wiring target (task-jump, output, fall-through, or a task's own `startAction`) resolves to neither a known action id nor a known task id |
| `UNRESOLVED_CALL_TASK` | Reserved — never emitted (no fixture; type kept for forward compatibility only) |
| `MISSING_ACTION_ID` | An enumerated occurrence has no usable `id` |
| `DUPLICATE_ACTION_ID` | A second occurrence reuses an `actionId` already indexed |

Every warning carries `{ code, message, nodeId? }`; `nodeId` is the affected
node's id where one exists (absent for `MISSING_ACTION_ID`, which has none).

## Fixture Plan

`src/mcp-server/tools/__fixtures__/`:
- `real-calidda-flow.json` — one real capture. **Empirical `sdd-apply` task**:
  call `find_flow` for `ZZZ-SDD-Test-DoNotUse-UpdateFlow`
  (`69cd3550-0848-4fd7-a5c7-4be615b20ced`) → `fetch-flow-configuration`'s
  underlying `architectApi.getFlowLatestconfiguration`, save the raw JSON
  verbatim, then scrub any customer-identifying string values (org name,
  phone numbers, real queue/user names) before committing — structure and
  field names must survive scrubbing untouched.
- `warnings/unknown-action-type.json`, `unresolved-intent-fanout.json`,
  `unresolved-reference.json`, `unresolved-initial-sequence.json`,
  `disabled-branch.json`, `dropped-edge.json`,
  `missing-duplicate-action-id.json` — one hand-written minimal flow JSON
  per warning code (skip `UNRESOLVED_CALL_TASK`: reserved, unemittable, no
  fixture possible).

The real fixture is also where every provisional field-name guess above
(`paths` vs `outputs`, the task-reference field name, `menuChoiceList` choice
shape, `reusable`'s real key) gets confirmed or corrected — tracked as Open
Questions below, per this project's established pattern of deferring
field-name confirmation to `sdd-apply` (see `update-flow`'s and
`update-flow-safeguards`' design docs).

## `findRawActions` / `searchRawActions`

Both import `enumerateRawActions()` from `flow-ir-parser.ts` — no second walk
of the raw JSON.

- **`findRawActions(configuration, actionIds)`**: builds `Map<actionId,
  occurrence[]>` from the enumeration, looks up each requested id (already
  plain GUIDs — stripping stays in `flow-action.ts`'s `planLookups`,
  unchanged), returns one `RawActionLookup` per occurrence found
  (`{ actionId, action, taskId, taskName, menuChoice? }`) or the id in
  `notFound`. Never throws; a malformed configuration just yields zero
  occurrences → everything requested lands in `notFound`.
- **`searchRawActions(configuration, query, opts)`**: for each occurrence,
  recursively walks `raw`'s **string leaf values only** (never key names),
  building a naive unescaped `parent.key`/`parent.index` path (matching the
  documented "keys containing dots are not escaped" behavior), testing each
  leaf against `query` (literal substring, folded when `!caseSensitive`, or
  regex), capping matches per occurrence at `opts.maxMatchesPerAction` and
  setting `truncated: true` past the cap. `actionType`/`name` are read off
  `raw.type ?? raw.__type` / `raw.name`.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/mcp-server/tools/flow-ir-parser.ts` | Create | `parseFlow`, `IRTask`/`IRNode`/`IRWarning` types, `enumerateRawActions`, seeded allowlists |
| `src/mcp-server/tools/flow-ir-parser.test.ts` | Create | Unit tests against real + synthetic fixtures |
| `src/mcp-server/tools/raw-action-lookup.ts` | Create | `findRawActions`, `searchRawActions`, `RawActionLookup`/`RawActionSearchMatch` types |
| `src/mcp-server/tools/raw-action-lookup.test.ts` | Create | Unit tests against real + synthetic fixtures |
| `src/mcp-server/tools/__fixtures__/*.json` | Create | Real captured (scrubbed) + 7 synthetic per-warning-code fixtures |
| `src/mcp-server/tools/flow-ir.ts` | Modify | Import path only: `./flow-ir-parser.ts` instead of the private package |
| `src/mcp-server/tools/flow-action.ts` | Modify | Import path only: `./raw-action-lookup.ts` |
| `src/mcp-server/tools/search-in-flow.ts` | Modify | Import path only: `./raw-action-lookup.ts` |
| `package.json` | Modify | Remove `@makingchatbots/genesys-cloud-architect-diagram-lib` devDependency |
| `openspec/config.yaml` | Modify | Correct stale `testing` section to reflect the real `node:test` setup |

## Interfaces / Contracts

```typescript
// flow-ir-parser.ts
export interface IRTask { id: string; name: string; reusable: boolean }
export interface IREdge { id: string; label?: string; backEdge: boolean }
export interface IRNode {
    id: string;
    kind: "task-start" | "action" | "branch-output";
    actionType?: string;
    label: string;
    description?: string;
    predecessors: IREdge[];
    successors: IREdge[];
    order: number;
    taskId: string;
    taskName: string;
    reachable: boolean;
    terminal: boolean;
}
export interface IRWarning { code: string; message: string; nodeId?: string }
export interface IRGraph {
    flowName: string;
    flowType: string;
    entryTaskId?: string;
    reachabilityIsComplete: boolean;
    tasks: IRTask[];
    nodes: IRNode[];
}
export type ParseFlowResult =
    | { ok: true; ir: IRGraph; warnings: IRWarning[] }
    | { ok: false; error: { code: string; message: string } };
export function parseFlow(configuration: unknown): ParseFlowResult;

// raw-action-lookup.ts
export interface RawActionLookup {
    actionId: string; action: unknown; taskId: string; taskName: string;
    menuChoice?: { digit?: string; name?: string };
}
export function findRawActions(
    configuration: unknown, actionIds: readonly string[],
): { found: RawActionLookup[]; notFound: string[] };

export interface RawActionSearchMatch {
    actionId: string; actionType?: string; name?: string;
    taskId: string; taskName: string;
    menuChoice?: { digit?: string; name?: string };
    matchedPaths: { path: string; value: string; matchIndex: number; matchLength: number }[];
    truncated?: boolean;
}
export function searchRawActions(
    configuration: unknown, query: string | RegExp,
    opts: { caseSensitive: boolean; maxMatchesPerAction: number },
): { hasMatches: boolean; matches: RawActionSearchMatch[] };
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `parseFlow` against `real-calidda-flow.json`: shape, entryTaskId, at least one full trace | `node:test`, fixture JSON import |
| Unit | `parseFlow` against each `warnings/*.json`: exactly the expected code(s) fire | `node:test`, one case per fixture |
| Unit | DFS: `order` pre-order numbering, `backEdge` on a hand-built cyclic fixture, `reachable` false for an orphaned action | `node:test`, synthetic minimal JSON |
| Unit | `findRawActions`: found/notFound, duplicate-id occurrence yields multiple entries, malformed input never throws | `node:test` |
| Unit | `searchRawActions`: literal + regex, case sensitivity, path building on nested arrays/objects, `truncated` at the cap, malformed input → `hasMatches:false` | `node:test` |
| Integration | `flow_ir`/`flow_action`/`search_in_flow` tools end-to-end against the real Calidda flow | Manual, `sdd-apply` |

## Threat Matrix

N/A — no routing, shell-command construction, subprocess spawning, VCS/PR
automation, or executable-file classification. This module only parses JSON
already fetched by the existing, unmodified `fetch-flow-configuration.ts`.

## Migration / Rollout

No migration required — additive/import-path-only, per the proposal's
rollback plan (revert new files, restore original import paths, re-add the
devDependency).

## Open Questions

- [ ] Real key names for branch wiring (`paths` vs `outputs`), the
      task-reference field on jump actions, `menuChoiceList` choice shape,
      and the `reusable` task flag — confirm against `real-calidda-flow.json`
      in `sdd-apply`; adjust the probe order if the real fixture disagrees.
- [ ] Seed values for `TERMINAL_ACTION_TYPES` / `TERMINAL_BRANCH_OUTCOMES` /
      `INTENT_FANOUT_ACTION_TYPES` are best-effort from `skills/write-flow/`
      references, not yet fixture-confirmed — extend empirically.
- [ ] Whether `UNRESOLVED_INITIAL_SEQUENCE`'s absent-`entryTaskId` case is
      reachable in a real published flow (Architect UI may forbid saving
      one) — confirm during `sdd-apply`, otherwise document as
      structurally-defensive-only.
