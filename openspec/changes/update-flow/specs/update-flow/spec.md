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
zod `.refine()` before spawning the deploy-runner process.

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
- THEN the `.refine()` MUST fail and no process MUST be spawned

#### Scenario: Ambiguous identifier
- GIVEN both `flowId` and `flowName` are supplied
- WHEN input is validated
- THEN the `.refine()` MUST fail and no process MUST be spawned

### Requirement: Non-Destructive Update Workflow

`updateFlow` MUST checkout, edit, and check-in or publish an
existing flow without calling `createFlow<Type>Async` or any route
that deletes it, and MUST preserve `flowId` and version history on
every successful path.

#### Scenario: Update without publishing
- GIVEN a valid, unlocked identifier and `publish: false` (default)
- WHEN `updateFlow` runs
- THEN it MUST checkout, apply edits, and call `checkInAsync`
- AND `flowId` and history MUST be unchanged

#### Scenario: Update and publish
- GIVEN a valid, unlocked identifier and `publish: true`
- WHEN `updateFlow` runs
- THEN it MUST checkout, apply edits, and call `publishAsync` instead of `checkInAsync`
- AND `flowId` and history MUST be unchanged

#### Scenario: Never recreates the flow
- GIVEN any successful `updateFlow` execution
- WHEN the code path is inspected
- THEN it MUST NOT call `createFlow<Type>Async` or any delete-and-recreate route

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
