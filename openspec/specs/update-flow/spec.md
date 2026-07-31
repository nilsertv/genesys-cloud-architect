# Update Flow Specification

## Purpose

Defines behavior for editing an existing Architect flow in place
(checkout → edit → check-in or publish) without deleting and
recreating it, via a new `updateFlow` deploy-runner export and a new
`update_flow` MCP tool. Covers identifier resolution, lock handling,
orphaned-lock prevention, and the NDJSON handoff between the MCP
server and the deploy-runner process.

## Requirements

### Requirement: Flow Identifier Resolution

`update_flow` MUST accept either `flowId` alone or the pair
`flowName` + `flowType`, and MUST reject any other combination via
input validation before spawning the deploy-runner process.

#### Scenario: Resolve by flowId
- GIVEN a caller supplies `flowId`
- WHEN input is validated
- THEN validation MUST pass and the deploy-runner MUST call `checkoutAndLoadFlowByFlowIdAsync`

#### Scenario: Resolve by flowName and flowType
- GIVEN a caller supplies `flowName` and `flowType`, no `flowId`
- WHEN input is validated
- THEN validation MUST pass and the deploy-runner MUST call `checkoutAndLoadFlowByFlowNameAsync`

#### Scenario: Missing identifier
- GIVEN neither `flowId` nor both `flowName`+`flowType` are supplied
- WHEN input is validated
- THEN the validation MUST fail and no process MUST be spawned

#### Scenario: Ambiguous identifier
- GIVEN both `flowId` and `flowName` are supplied
- WHEN input is validated
- THEN the validation MUST fail and no process MUST be spawned

### Requirement: Non-Destructive Update Workflow

`updateFlow` MUST checkout, edit, and check-in or publish an existing flow
without calling `createFlow<Type>Async` or any route that deletes it, and
MUST preserve `flowId` and version history on every successful path.
Publishing MUST additionally be gated by the two-call `confirmPublish`
protocol and the full-baseline diff gate defined below: no single call MAY
both apply an edit and publish it in the same round trip.
(Previously: a single call with `publish: true` checked out, edited, and
published immediately, with no baseline capture, diff check, or
confirmation step.)

#### Scenario: First call checks in only, never publishes
- GIVEN a valid, unlocked identifier and `confirmPublish` not set (or `false`)
- WHEN `updateFlow` runs
- THEN it MUST checkout, apply edits, and call `checkInAsync`
- AND `flowId` and history MUST be unchanged
- AND it MUST NOT call `publishAsync`

#### Scenario: Second call publishes only when confirmed and the diff is clean
- GIVEN a valid, unlocked identifier, `confirmPublish: true`, and a full-baseline diff showing no change beyond the requested edit
- WHEN `updateFlow` runs
- THEN it MUST checkout, re-diff against the original baseline, and call `publishAsync` instead of `checkInAsync`
- AND `flowId` and history MUST be unchanged

#### Scenario: Never recreates the flow
- GIVEN any successful `updateFlow` execution
- WHEN the code path is inspected
- THEN it MUST NOT call `createFlow<Type>Async` or any delete-and-recreate route

### Requirement: Baseline Capture and Persistence

`updateFlow` MUST export the flow's current content and persist it to
`<project-root>/exports/<flowId>.baseline.yaml` before any edit mutation is
applied, inside the same locked checkout that guards check-in/publish.

#### Scenario: Baseline written before edits are applied
- GIVEN checkout succeeds for a valid, unlocked identifier
- WHEN `updateFlow` proceeds to apply the requested edits
- THEN `exports/<flowId>.baseline.yaml` MUST already exist and contain the pre-edit exported content

#### Scenario: Baseline path returned to the caller
- GIVEN any completed `updateFlow` call, regardless of outcome
- WHEN the response is returned
- THEN it MUST include the baseline file path so the caller can inspect it

### Requirement: Baseline Overwrite on New Checkout

A successful checkout's exclusive lock is the sole staleness signal for a
prior baseline file: only one active `updateFlow` run can hold that lock per
`flowId` at a time, so any baseline file already present at checkout time
MUST be treated as abandoned and overwritten — never preserved, and never
treated as a collision requiring manual cleanup or caller intervention.

#### Scenario: Prior baseline overwritten at successful checkout
- GIVEN a baseline file already exists at `exports/<flowId>.baseline.yaml` from an earlier run
- WHEN checkout succeeds for a new `updateFlow` call against the same `flowId`
- THEN the baseline file MUST be overwritten with the new pre-edit export
- AND the call MUST NOT fail or require manual cleanup because of the prior file

#### Scenario: Checkout blocked by an active lock leaves the baseline untouched
- GIVEN the flow is currently locked by another in-progress `updateFlow` run
- WHEN a new call attempts checkout
- THEN checkout MUST fail per the existing Lock Handling requirement
- AND the existing baseline file MUST be left unmodified

### Requirement: Full-Baseline Diff Gate at Confirm Time

The diff that gates publish MUST always compare the live flow content at
confirm time against the complete original baseline captured before any
edit ran (call 1's pre-edit export) — never against an intermediate
snapshot taken between calls. This is a full-baseline comparison, not an
optimistic-concurrency check: it surfaces every delta the edit itself
introduced, not only third-party drift between calls. The exact mechanism
for distinguishing "requested" from "unrequested" delta inside that diff is
NOT specified here — it is deferred to `sdd-design`.

#### Scenario: Diff always references call 1's original baseline
- GIVEN call 2 runs with `confirmPublish: true`
- WHEN the diff is computed
- THEN it MUST compare the live flow against the exact baseline file written before any edit in call 1, not any snapshot taken after edits were applied

#### Scenario: Clean diff allows publish
- GIVEN the confirm-time diff finds no change beyond the requested edit
- WHEN call 2 runs with `confirmPublish: true`
- THEN `updateFlow` MUST proceed to call `publishAsync`

#### Scenario: Unsolicited diff blocks publish unconditionally
- GIVEN the confirm-time diff finds any change beyond the requested edit
- WHEN call 2 runs, regardless of `confirmPublish`
- THEN `updateFlow` MUST block the publish
- AND no override flag or bypass path MUST exist to force it through

### Requirement: Two-Call Explicit-Flag Publish Confirmation

`update_flow` MUST require a two-call protocol before any publish: call 1
(without `confirmPublish: true`) MUST checkout, apply edits, check in, and
return a diff summary plus the baseline path, and MUST NOT publish under
any circumstance. Call 2 (`confirmPublish: true`) MUST re-checkout, re-run
the full-baseline diff gate above, and only then call `publishAsync`.

#### Scenario: Call 1 never publishes
- GIVEN a valid, unlocked identifier and `confirmPublish` not set (or `false`)
- WHEN `updateFlow` runs
- THEN it MUST checkout, apply edits, call `checkInAsync`, and return a diff summary and the baseline path
- AND it MUST NOT call `publishAsync` under any circumstance

#### Scenario: Call 2 publishes only after confirmation and a clean diff
- GIVEN a valid, unlocked identifier, `confirmPublish: true`, and the same persisted baseline from call 1 still present
- WHEN `updateFlow` runs and the full-baseline diff is clean
- THEN it MUST checkout, re-diff, and call `publishAsync` instead of `checkInAsync`

### Requirement: Baseline Cleanup Tied to Publish Success Only

The baseline file MUST be deleted only when `publishAsync` completes
successfully. It MUST be preserved indefinitely, with no TTL, after a
check-in-only call (call 1), a failed call, or a publish blocked by the
diff gate — so the file remains available for inspection until an explicit
successful publish or manual cleanup.

#### Scenario: Baseline deleted after successful publish
- GIVEN call 2 runs with `confirmPublish: true` and a clean diff
- WHEN `publishAsync` completes successfully
- THEN the baseline file MUST be deleted

#### Scenario: Baseline preserved after check-in-only call
- GIVEN call 1 completes successfully (check-in only, no publish)
- WHEN the call returns
- THEN the baseline file MUST still exist on disk

#### Scenario: Baseline preserved after a blocked or failed publish
- GIVEN a publish attempt is blocked by the diff gate, or `publishAsync` throws
- WHEN the call returns its error
- THEN the baseline file MUST still exist on disk, indefinitely, with no automatic expiry

### Requirement: No Fork-to-New-Flow Support (Explicit Scope Reaffirmation)

`update_flow` MUST only ever edit the existing flow in place under its
existing `flowId`. It MUST NOT create a new flow via `createFlow<Type>Async`
(or any equivalent) as an alternative path, including as a response to a
blocked publish. This is a deliberate, confirmed scope decision for this
capability, not an omission — no fork/new-flow path exists or MAY be added
under `update_flow`.

#### Scenario: A blocked publish still does not offer a fork path
- GIVEN the diff gate blocks a publish attempt
- WHEN the caller wants the intended changes delivered anyway
- THEN `update_flow` MUST NOT create a new flow or expose any fork-to-new-flow option
- AND the caller MUST restart from call 1 against the same `flowId`

### Requirement: Lock Handling

`updateFlow` MUST distinguish a flow locked by another user from
other failures and MUST only force an unlock when `forceUnlock: true`
is explicitly requested.

#### Scenario: Locked, forceUnlock false (default)
- GIVEN the flow `isLockedByAnotherUser`
- WHEN `updateFlow` runs with `forceUnlock: false`
- THEN it MUST fail with a "flow locked" error distinct from "not found" or generic errors
- AND it MUST NOT attempt to unlock the flow

#### Scenario: Locked, forceUnlock true
- GIVEN the flow `isLockedByAnotherUser`
- WHEN `updateFlow` runs with `forceUnlock: true`
- THEN it MUST force the unlock and proceed with checkout
- AND the caller-facing description/response SHOULD warn that forcing unlock may discard another user's unsaved Architect UI edits

### Requirement: Flow Not Found Handling

`updateFlow` MUST return a distinct "not found" error when the
target flow cannot be resolved, and MUST NOT collapse it into the
"locked" error or a generic message.

#### Scenario: Flow does not exist
- GIVEN a `flowId` or `flowName` matching no existing flow
- WHEN `updateFlow` attempts checkout
- THEN it MUST fail with a "flow not found" error distinguishable from "locked"

### Requirement: Orphaned Lock Prevention

IF checkout succeeds and the subsequent `checkInAsync` or
`publishAsync` call fails, `updateFlow` MUST call `unlockAsync()` on
the checked-out flow before reporting the error, so no orphaned lock
remains.

#### Scenario: Check-in fails after successful checkout
- GIVEN checkout succeeded and the flow is checked out by the current session
- WHEN `checkInAsync` (or `publishAsync`) throws
- THEN `updateFlow` MUST call `unlockAsync()` before propagating the original error
- AND the original check-in/publish error MUST still be surfaced to the caller

### Requirement: MCP Server <-> Deploy-Runner NDJSON Protocol

`update_flow` MUST reuse the existing NDJSON contract already used
by `deploy_flow`: the deploy-runner MUST emit newline-delimited
`{type:"log"}` / `{type:"result"}` JSON lines on stdout, and the
`update_flow` MCP tool MUST parse those lines with the same logic
`deploy_flow` uses, without introducing a new or divergent schema.

#### Scenario: Deploy-runner emits standard NDJSON lines
- GIVEN the deploy-runner runs `updateFlow` in update mode
- WHEN it emits progress or completion output
- THEN each line MUST be a single JSON object with `type: "log"` or `type: "result"`, matching the shape already produced for `deploy_flow`

#### Scenario: update_flow parses NDJSON identically to deploy_flow
- GIVEN the `update_flow` tool receives stdout from the spawned process
- WHEN it parses each line
- THEN it MUST use the same parsing logic as `deploy-flow.ts`, treating unrecognized lines the same way `deploy_flow` does
