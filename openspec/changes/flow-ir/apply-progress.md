# Apply Progress: `flow-ir`

## PR1 — Real Fixture + Stale Config Fix

Status: **done** (tasks 1.1–1.5), but the native `sdd-attempt` runtime
harness is now `blocked(maintainer_decision)` — see "Runtime harness
blocker" below before running any further `sdd-apply` attempt.

### Task 1.1 — `find_flow` + `fetch-flow-configuration` capture — DONE

Credentials (`GENESYS_REGION`/`GENESYS_CLIENT_ID`/`GENESYS_CLIENT_SECRET`)
are now present in `.env` (confirmed via a boolean-only `dotenv` load, no
values printed). The `genesys-cloud-architect-mcp` MCP server connection
was not re-checked; instead, a one-off script mirroring
`src/mcp-server/index.ts`'s exact auth pattern
(`platformClient.ApiClient.instance.loginClientCredentialsGrant(...)`) plus
`fetch-flow-configuration.ts`'s SDK call
(`new platformClient.ArchitectApi().getFlowLatestconfiguration(flowId)`)
was written at the project root (for `dotenv`/`purecloud-platform-client-v2`
module resolution), run once successfully against the real Genesys Cloud
API, and deleted immediately after (scratch-only, never committed, per this
repo's established convention).

### Task 1.2 — Scrub — DONE, nothing to scrub

**Important finding**: the captured configuration contains no
customer-identifying data at all — no org name, phone number, or real
queue/user name. It is the *disposable marker-variable test flow* that
`update_flow`'s and `update-flow-safeguards`' own empirical tests use
(`description: "Disposable test flow created to empirically verify the
update_flow MCP tool (SDD tasks 1.6/2.6). Safe to delete."`). Saved
verbatim, no scrubbing applied, at
`src/mcp-server/tools/__fixtures__/real-calidda-flow.json` (867 lines).

### Task 1.3 — Confirm real field names — DONE, but unresolvable from this fixture

**Critical finding for whoever picks up PR2**: `flowSequenceItemList` in
the captured configuration is an **empty array** (`length: 0`). This flow
has **zero tasks and zero actions** — it exists solely to hold
`variables[]` entries added by prior `update_flow` test runs, not to
exercise any Architect action wiring. None of design.md's four Open
Questions (`paths` vs `outputs`, the task-reference field name,
`menuChoiceList` choice shape, the `reusable` task-flag key) can be
confirmed or corrected from this fixture — there is no action or task JSON
in it to inspect. This invalidates the proposal's assumption that the
designated real flow (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`,
`69cd3550-0848-4fd7-a5c7-4be615b20ced`) would carry real wiring; it does
not, by design (it was built for variable-mutation tests, not
content/wiring tests). Design's multi-key defensive-probing approach
(already the chosen mitigation *for* unconfirmed field names) stays
exactly as specified in `design.md` — implement PR2 against it unchanged.
`design.md`'s Open Questions section is **not** resolved by this task and
should stay open until a content-bearing real flow becomes available, or
be accepted as permanently probe-only.

**Consequence for task 2.20** (not yet attempted): the tasks.md wording
"trace at least one full path from an entry task-start to a terminal node
using the real fixture" is now known-infeasible verbatim — there is no
entry task, no action, no terminal node in this fixture. When PR2 is
implemented, 2.20's real-fixture assertion should be adjusted to what the
fixture actually offers: `parseFlow(real-calidda-flow.json)` returns
`{ok:true}`, `ir.tasks === []`, `ir.nodes === []`, `ir.flowName ===
"ZZZ-SDD-Test-DoNotUse-UpdateFlow"`, `ir.flowType === "inboundcall"`, no
`entryTaskId` (nothing to resolve `initialSequence`, if any, against) —
i.e. treat it as the "well-formed but empty" contract scenario rather than
a wiring trace. This is a deviation from tasks.md's literal wording, driven
by the real data; flag it again explicitly when PR2 actually starts.

### Task 1.5 — Round-trip verification — DONE

`flowSequenceItemList` is a valid (empty) array; `flowName`/`flowType`
(`ZZZ-SDD-Test-DoNotUse-UpdateFlow` / `inboundcall`) preserved. No
scrubbing was applied (1.2), so nothing could have broken structure.

### Task 1.4 — `openspec/config.yaml` stale `testing` section — DONE

Corrected `context`, `testing.strict_tdd` (→ `true`), `testing.test_command`
(→ `"pnpm test"`), `testing.reason` (documents the 3 existing `node:test`
files and that CI itself still doesn't run `pnpm test`), and the matching
`rules.apply.tdd`/`test_command` and `rules.verify.test_command` fields, to
reflect the real state: `node --experimental-strip-types --test` via
`pnpm test`, no external test-runner dependency. Preserved the file's
existing (pre-existing, not introduced by this change) mixed
list-item/mapping-key structure under `rules.apply`/`rules.verify` exactly,
per the task's instruction not to restructure the file — note this
structure already fails strict YAML parsing (`yaml` npm package) even on
the pre-change file (verified via `git stash`), so this is a pre-existing
quirk, not a regression.

### Commits — RESOLVED (orchestrator correction, post-agent)

Root cause was not "PR3 hasn't happened yet" — the private devDependency
was never actually needed at all, since the confirmed decision for this
whole SDD change is to reimplement `parseFlow`/`findRawActions`/
`searchRawActions` natively rather than depend on the private package.
Removed `@makingchatbots/genesys-cloud-architect-diagram-lib` from
`package.json` and deleted the now-pointless `.npmrc` (its only content was
the GitHub Packages registry mapping for that one dependency). `pnpm
install` now succeeds instantly with no auth needed.

`flow-ir.ts`, `flow-action.ts`, `search-in-flow.ts` (which still import the
old package name — PR2/PR3 will point them at the new native module
instead) were unstaged and left as **untracked** files on disk; they still
fail `tsc --noEmit` standalone (expected, unenforced by pre-commit — this
project's own `tsc strict, noEmit, NOT wired into CI/pre-commit` policy),
but no longer block `pnpm build` (esbuild only bundles what's reachable
from `index.ts`, and their import/registration was removed from `index.ts`
for now — `find_flow` alone is registered).

Committed on `feat/adopt-upstream-flow-ir`:
- `9a08698` — `feat(mcp-server): add find_flow tool` (find-flow.ts,
  fetch-flow-configuration.ts, skills/interpret-flow-ir/SKILL.md, trimmed
  index.ts registering only find_flow, types.ts widening)
- `5718fda` — `docs(openspec): correct stale testing section in
  config.yaml` (task 1.4)

`pnpm run build` / `lint` / `test` (55/55) all pass on this branch now.
`pnpm run typecheck` still reports errors, but only from the 3 untracked,
not-yet-committed files — consistent with the project's documented
unenforced-typecheck policy, not a regression.

## Runtime harness blocker (native `sdd-attempt` ledger) — needs maintainer decision

PR1's file work (tasks 1.1–1.5) is complete and committed-ready (staged:
`src/mcp-server/tools/__fixtures__/real-calidda-flow.json`). The attempt
was acquired with the parent-supplied continuation token and settled with
`outcome: passed`, but the ledger flagged
`changed_line_budget_exceeded: true` — the 867-line fixture alone exceeds
this objective's `max_changed_lines: 400` — and `gentle-ai sdd-attempt
settle` returned `state: blocked, reason: maintainer_decision`:

```
next_action: "reset"
decision_required: true
```

Per `gentle-ai sdd-attempt status`, unblocking requires a maintainer to run
`gentle-ai sdd-attempt reset --cwd <repo> --change flow-ir
--expected-revision <printed-revision> --request-id <id> --reason <why>
--actor <actor>` — this is explicitly a maintainer-authorized action this
executor should not take unilaterally (no `--actor` authority, and the
tool's own message says "needs a maintainer decision"). No further
runtime-bearing step (running `pnpm test`, starting PR2's TDD RED/GREEN
cycle) was attempted after this block, per this session's instruction to
call `sdd-attempt acquire` before any runtime-bearing step — a fresh
acquire against the same still-blocked objective would only repeat the
same block.

**PR1's non-runtime artifact state is otherwise final**: `tasks.md` 1.1–1.5
and 1.4 all checked off, this file updated, fixture staged. No PR2/PR3 code
was written this session (correctly gated behind the objective reset, since
those phases' RED/GREEN cycles are unavoidably runtime-bearing under
strict TDD).

## PR2 — `flow-ir-parser.ts`: `parseFlow` (tasks 2.1–2.21)

Status: **partially done** (tasks 2.1–2.4 committed and green), **blocked
again on the native `sdd-attempt` runtime harness** — see "PR2 runtime
harness blocker" below.

### Tasks 2.1–2.4 — DONE, committed as `4c87707`

`src/mcp-server/tools/flow-ir-parser.ts` and
`src/mcp-server/tools/flow-ir-parser.test.ts` created, plus synthetic
fixture `src/mcp-server/tools/__fixtures__/warnings/missing-duplicate-action-id.json`.

- `parseFlow`'s precondition guard: `{ok:false}` (never throws) for a
  missing or non-array `flowSequenceItemList`; `{ok:true}` with
  `flowName`/`flowType` read off the raw `name`/`type` fields (**confirmed**
  against the real fixture in PR1 — `name`/`type` are the real raw field
  names, unlike the four still-unconfirmed fields below) for a well-formed
  input.
- `enumerateRawActions(configuration)`: tolerant primitive, walks
  `flowSequenceItemList[].actionList[]` plus inline
  `menuChoiceList[].action`, tagging each menu-choice occurrence with
  `{digit, name}`. Never throws; malformed/absent
  `flowSequenceItemList` yields `[]`.
- Graph build step: one `task-start` node (`<taskId>::start`) per
  `flowSequenceItemList` item, one `action` node per first `actionId`
  occurrence, `MISSING_ACTION_ID`/`DUPLICATE_ACTION_ID` warnings for
  dropped occurrences. Every node's `predecessors`/`successors` are still
  empty arrays and `order`/`reachable`/`terminal` are placeholder defaults
  — wiring (task-jump, menu-choice, intent-fanout, generic-outputs probes)
  and the DFS order/reachable/backEdge pass are tasks 2.5–2.18, not yet
  implemented.

`pnpm test`: 65/65 green (was 55/55 before this session; +10 new tests).
`tsc --noEmit` clean on both new files (checked standalone with the
project's exact `tsconfig.json` compiler options — full-project
`tsc --noEmit` still separately fails on the 3 untracked tool files
`flow-ir.ts`/`flow-action.ts`/`search-in-flow.ts` per PR1's note, unrelated
to this work).

### Tasks 2.5–2.21 — NOT STARTED

Task-jump probe, menu-choice expansion, intent-fanout exclusion, generic
outputs probe (DISABLED_BRANCH/DROPPED_EDGE/UNKNOWN_ACTION_TYPE), the
`TERMINAL_ACTION_TYPES`/`TERMINAL_BRANCH_OUTCOMES`/
`INTENT_FANOUT_ACTION_TYPES` seeded allowlists, `initialSequence`
resolution, the DFS pass (order/reachable/backEdge), and the real-fixture
trace test all remain to implement, per the design decisions already
resolved in the earlier planning:

- **Field-name probes**: keep the exact defensive multi-key probing
  design.md specifies (`raw.paths ?? raw.outputs`, `raw.task?.id ??
  raw.taskId ?? raw.destinationTaskId`, etc.) — none of the four Open
  Questions were resolved by the real fixture (task 1.3's finding, PR1).
- **Task 2.20 deviation** (flagged again per this session's instructions):
  the real fixture's `flowSequenceItemList` is empty — there is no entry
  task, action, or terminal node to trace. When 2.20 is implemented, its
  assertion must be `parseFlow(real-calidda-flow.json)` returns
  `{ok:true}`, `ir.tasks === []`, `ir.nodes === []`,
  `ir.flowName === "ZZZ-SDD-Test-DoNotUse-UpdateFlow"`,
  `ir.flowType === "inboundcall"`, no `entryTaskId` — the "well-formed but
  empty" contract scenario, not an entry-to-terminal trace. Synthetic
  per-warning-code fixtures (tasks 2.3/2.5/2.7/2.9/2.11/2.13/2.15/2.17)
  carry all real wiring-trace coverage instead.

### PR2 runtime harness blocker (native `sdd-attempt` ledger) — needs maintainer decision

Tasks 2.1–2.4's chunk was implemented in two RED→GREEN cycles under two
separate `sdd-attempt acquire` calls (chunk1: tasks 2.1–2.2, ~283 changed
lines, settled `passed`; chunk2: tasks 2.3–2.4). Chunk2's own diff, once
committed as `4c87707`, was 422 lines (`flow-ir-parser.ts` +
`flow-ir-parser.test.ts` + the new fixture) — itself already slightly over
the 400-line-per-attempt budget on its own, but the harness's actual
`changed_lines` accounting came back as **1554**, not ~422, and the settle
returned `state: blocked, reason: maintainer_decision`.

**Root cause (this session's own mistake, documented so it is not
repeated)**: chunk2's (and chunk1's) `sdd-attempt settle --untracked-scope
select` calls included
`--intended-untracked=src/mcp-server/tools/__fixtures__/real-calidda-flow.json`
in their `--intended-untracked` list, believing this was required to avoid
an `undeclared_untracked` block. That file's 867 lines were **already
accounted for and reset against PR1's own objective** (see the earlier
"Runtime harness blocker" section above — `last_reset.reason` in
`sdd-attempt status` output confirms "867-line real flow fixture ...
exceeded the 400-line objective budget; user explicitly authorized
continuing to PR2"). Re-declaring it as `intended_untracked` for the PR2
objective caused the harness to count it again against PR2's budget
(867 fixture + 422 chunk2 diff + ~163 lines of `tasks.md`/
`apply-progress.md` edits ≈ 1554), even though this session did not
re-touch that file's content at all in the PR2 objective.

**Correction for whoever continues**: when declaring `--intended-untracked`
for a PR2/PR3 attempt, list only files this session's own current work unit
newly created or is about to modify (e.g. the tool files
`flow-action.ts`/`flow-ir.ts`/`search-in-flow.ts` once their import paths
are swapped in task 3.10–3.12) — do **not** re-list
`real-calidda-flow.json`, which is PR1's already-settled, already-reset
fixture and needs no further declaration.

Per `gentle-ai sdd-attempt status`, unblocking requires a maintainer to
run:

```
gentle-ai sdd-attempt reset --cwd /home/ubuntu/00-dev-apps/genesys-cloud-architect \
  --change flow-ir \
  --expected-revision sha256:6c23cc2abf7da6388a539e6a8ee53a64063b41d63a425bbf5727aaae90739464 \
  --request-id "<unique-request-id>" \
  --reason "PR2 chunk2's intended_untracked list mistakenly re-declared PR1's already-reset 867-line real fixture, inflating changed_lines to 1554; tasks 2.1-2.4 are genuinely done and committed as 4c87707, only ~422 lines" \
  --actor "<actor>"
```

This is explicitly a maintainer-authorized action this executor should not
take unilaterally (no `--actor` authority, and the tool's own message says
"needs a maintainer decision").

**Non-runtime artifact state is otherwise final for this session**:
`tasks.md` 2.1–2.4 checked off, this file updated, `flow-ir-parser.ts` +
`flow-ir-parser.test.ts` + the new fixture committed as `4c87707` on
`feat/adopt-upstream-flow-ir`. No further PR2 code (tasks 2.5 onward) was
attempted after this block, per this session's instruction to call
`sdd-attempt acquire` before any runtime-bearing step.

## PR2 continuation — tasks 2.5–2.10 (this session)

The `sdd-attempt` runtime harness block above was resolved by the
maintainer/orchestrator (reset run outside this session); this session
continued directly from tasks 2.5 without re-litigating the reset.

**Correction applied**: per this session's explicit instruction, no
`--intended-untracked` declaration in this session's `sdd-attempt` calls
re-lists `real-calidda-flow.json` (already settled under PR1). Only files
this session's own chunks actually touch are declared.

### Tasks 2.5–2.10 — DONE

Implemented in `flow-ir-parser.ts` (design.md Parsing Algorithm steps
3a/3b/3c):

- **`probeTaskReference(raw)`**: `raw.task?.id ?? raw.taskId ??
  raw.destinationTaskId` (unconfirmed real key, per design's defensive
  multi-key probing). A resolved task-jump wires one unlabeled edge from
  the action straight to `<taskId>::start` (no branch-output node); an
  unresolved one emits `UNRESOLVED_REFERENCE` and adds no edge. Fully
  handles the action (skips steps 3c–3e for it).
- **`probeStartActionId(item)`**: `item.startAction?.id ?? item.startAction
  ?? item.startActionId` (unconfirmed real key). Task items carrying a
  non-empty `menuChoiceList` are wired exclusively through a dedicated
  menu-choice-expansion pass (step 3b), run after the main per-action
  wiring loop, and their `startAction` id is excluded from that main loop
  entirely (`startActionIds` set) to avoid double-processing.
- **Menu-choice expansion**: one `branch-output` node per choice
  (`<startActionId>::<choiceId-or-index>`, id from `choice.id` else the
  choice's array index), labeled `choice.name ?? choice.digit`, wired
  `startAction -> branch-output -> choice's already-indexed inline action`.
- **`INTENT_FANOUT_ACTION_TYPES`** seeded with `AskForNLUIntentAction`
  (from `skills/write-flow/references/gotchas.md`'s "`AskForIntent`
  (`AskForNLUIntentAction`)" — no real fixture confirms this, flagged as
  best-effort per design's seeded-allowlist decision). A matching action
  emits `UNRESOLVED_INTENT_FANOUT`, sets flow-wide
  `reachabilityIsComplete = false`, and skips wiring for that action
  entirely.

New fixtures: `warnings/unresolved-reference.json`,
`warnings/unresolved-intent-fanout.json`, `menu-choice-task.json` (not a
warning fixture — a positive-path menu-choice wiring example).

New tests in `flow-ir-parser.test.ts`: task-jump resolved/unresolved,
menu-choice branch-output wiring, intent-fanout exclusion + flow-wide
`reachabilityIsComplete: false`. `pnpm test`: 69/69 green (was 65/65 before
this session's tasks.md count; the actual prior count differs slightly from
that file's stale note — verified freshly via `pnpm test` output).

Steps 3d (generic outputs probe: `DISABLED_BRANCH`/`DROPPED_EDGE`) and 3e
(terminal/`UNKNOWN_ACTION_TYPE` fallback) are deliberately **not yet
implemented** — any action that isn't a task-jump, menu-choice startAction,
or intent-fanout type is left with `predecessors`/`successors` still empty
and `terminal: false` (default), pending tasks 2.11–2.14. This is expected,
not a bug: it matches tasks.md's phasing exactly.

### PR2 chunk-A runtime harness blocker (native `sdd-attempt` ledger) — needs maintainer decision

Tasks 2.5–2.10 were implemented and committed (`c7b43cb` +
`0f235d8` — the second commit is a biome auto-format fixup the pre-commit
hook applied after staging but before the first commit landed; both are on
`feat/adopt-upstream-flow-ir`). `pnpm test`: 69/69 green.

`sdd-attempt settle` returned `state: blocked, reason: maintainer_decision`
because this attempt's `changed_lines` came back as **417**, 17 lines over
this objective's `max_changed_lines: 400`. This is a genuine (small)
overage, not a mis-declared-untracked-file mistake like the two prior
blocks: the diff legitimately includes the 2 code/test file changes plus
this session's `tasks.md`/`apply-progress.md` doc updates (the latter two
were still uncommitted from the *previous* session's tasks 1.1–1.5/2.1–2.4
work, so this commit's diff carries their accumulated doc edits too, not
just this chunk's).

Per `gentle-ai sdd-attempt status`, unblocking requires a maintainer to
run:

```
gentle-ai sdd-attempt reset --cwd /home/ubuntu/00-dev-apps/genesys-cloud-architect \
  --change flow-ir \
  --expected-revision sha256:82c369b5ab838202daf875904fe598960f1a02c40663f7d709ad130cba0f32a9 \
  --request-id "<unique-request-id>" \
  --reason "PR2 chunk (tasks 2.5-2.10) settled at 417 changed lines, 17 over the 400 objective budget; genuine small overage (doc-file backlog from prior uncommitted tasks.md/apply-progress.md edits), work itself (task-jump/menu-choice/intent-fanout wiring) is done, committed as c7b43cb+0f235d8, 69/69 pnpm test green" \
  --actor "<actor>"
```

This is explicitly a maintainer-authorized action this executor should not
take unilaterally (no `--actor` authority).

**Non-runtime artifact state is otherwise final for this session**:
`tasks.md` 2.5–2.10 checked off, this file updated, code + tests + 3 new
fixtures committed. No further PR2 code (tasks 2.11 onward) was attempted
after this block, per this session's instruction to stop on a blocked
settle rather than resetting unilaterally.

## PR2 continuation — tasks 2.11–2.12 (Chunk 1)

Tasks 2.11–2.12 implemented and green (71/71 tests passing):
- Generic outputs probe (`raw.paths ?? raw.outputs`, else `raw.nextAction ?? raw.nextActionId` fall-through).
- `wireTarget` helper resolving targets to actions or `<taskId>::start`, emitting `DROPPED_EDGE` on failure.
- `DISABLED_BRANCH` emission for disabled branch outputs while keeping edges in graph.
- Synthetic fixtures added: `disabled-branch.json`, `dropped-edge.json`.

## PR2 continuation — tasks 2.13–2.14 (Chunk 2)

Tasks 2.13–2.14 implemented and green (73/73 tests passing):
- `TERMINAL_ACTION_TYPES` allowlist and step 3e zero-output terminal/`UNKNOWN_ACTION_TYPE` fallback.
- `TERMINAL_BRANCH_OUTCOMES` allowlist and step 4 branch-output terminal assignment.
- Synthetic fixture added: `warnings/unknown-action-type.json`.

## PR2 continuation — tasks 2.15–2.16 (Chunk 3)

Tasks 2.15–2.16 implemented and green (76/76 tests passing):
- `initialSequence` resolution via `probeInitialSequenceId` helper.
- `UNRESOLVED_INITIAL_SEQUENCE` warning emission on unresolvable declared sequence.
- Omission of `entryTaskId` when undeclared or unresolvable; assignment when resolved.
- Synthetic fixture added: `warnings/unresolved-initial-sequence.json`.

## PR2 continuation — tasks 2.17–2.18 (Chunk 4)

Tasks 2.17–2.18 implemented and green (77/77 tests passing):
- Iterative DFS pass with explicit stack, white/gray/black coloring.
- Pre-order `order` assignment and `reachable: true` on first visit.
- `backEdge: true` on both edge directions for cycle-closing edges.
- Unreachable/orphaned actions keep `reachable: false` and `order: -1`.
- `ir.nodes` sorted ascending by `order` (reachable first, unreachable at end).
- Synthetic fixture added: `cyclic-flow.json`.

## PR2 continuation — tasks 2.19–2.21 (Chunk 5 — Phase 2 complete)

Tasks 2.19–2.21 implemented and green (80/80 tests passing):
- `UNRESOLVED_CALL_TASK` reserved code assertion across all 10 fixtures (never emitted).
- `parseFlow(real-calidda-flow.json)` verified: conforms to well-formed empty contract.
- End-to-end trace from entry `task-start` node through branch-output to terminal node verified.
- All 80 unit tests passing under `pnpm test`. Phase 2 is fully complete.

## Next

1. Phase 3 (PR3, tasks 3.1–3.15): `raw-action-lookup.ts` (`findRawActions`, `searchRawActions`) + tool import swaps.






