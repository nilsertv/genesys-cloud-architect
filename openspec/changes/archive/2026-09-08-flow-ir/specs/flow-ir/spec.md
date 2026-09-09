# Flow IR Specification

## Purpose

Defines the native `parseFlow`, `findRawActions`, and `searchRawActions`
functions: build the flow intermediate representation (IR), look up raw
actions by id, and full-text search raw actions. Replaces the private
`@makingchatbots/genesys-cloud-architect-diagram-lib` dependency and backs
the `flow_ir`, `flow_action`, and `search_in_flow` MCP tools with no change
to their observable contract. Full field/ID/warning semantics live in
`skills/interpret-flow-ir/SKILL.md`; this spec states testable pass/fail
behavior only.

## Requirements

### Requirement: parseFlow Contract

`parseFlow` MUST return `{ok:true, ir, warnings}` for a well-formed raw
flow-configuration JSON — `ir` includes `flowName`, `flowType`, `tasks[]`,
`nodes[]` sorted ascending by `order` — and MUST return
`{ok:false, error:{code,message}}`, never throw, when the input cannot be
traversed as a flow configuration.

#### Scenario: Well-formed flow parses
- GIVEN a raw flow-configuration JSON with a valid `flowSequenceItemList`
- WHEN `parseFlow` runs
- THEN it MUST return `{ok:true}` with `ir.tasks`, `ir.nodes`, `warnings`

#### Scenario: Missing flowSequenceItemList
- GIVEN input with no `flowSequenceItemList` field
- WHEN `parseFlow` runs
- THEN it MUST return `{ok:false, error}`, not throw

#### Scenario: Non-array flowSequenceItemList
- GIVEN `flowSequenceItemList` present but not an array
- WHEN `parseFlow` runs
- THEN it MUST return `{ok:false, error}`

### Requirement: Warning Code Emission

`parseFlow` MUST emit each documented warning code under its documented
condition, attached to `warnings[]` with `code` and the affected node id
where applicable. `UNRESOLVED_CALL_TASK` is reserved and MUST NOT be
emitted by any current code path.

#### Scenario: UNKNOWN_ACTION_TYPE
- GIVEN an action whose `__type` is unrecognized
- WHEN the flow is parsed
- THEN a generic node MUST still be produced and `warnings` MUST include `UNKNOWN_ACTION_TYPE`

#### Scenario: UNRESOLVED_INTENT_FANOUT
- GIVEN a flow with an intent-listen action
- WHEN the flow is parsed
- THEN `warnings` MUST include `UNRESOLVED_INTENT_FANOUT` and `ir.reachabilityIsComplete` MUST be `false`

#### Scenario: UNRESOLVED_REFERENCE
- GIVEN a task-jump targeting a nonexistent task id
- WHEN the flow is parsed
- THEN `warnings` MUST include `UNRESOLVED_REFERENCE`

#### Scenario: UNRESOLVED_INITIAL_SEQUENCE
- GIVEN a declared entry/initial sequence matching no task
- WHEN the flow is parsed
- THEN `warnings` MUST include `UNRESOLVED_INITIAL_SEQUENCE` and `ir.entryTaskId` MUST be absent

#### Scenario: DISABLED_BRANCH
- GIVEN a branch output disabled in the raw configuration
- WHEN the flow is parsed
- THEN `warnings` MUST include `DISABLED_BRANCH` naming that node, and its edges MUST remain in the graph

#### Scenario: DROPPED_EDGE
- GIVEN a wiring reference pointing at an unknown endpoint
- WHEN the flow is parsed
- THEN the edge MUST be discarded and `warnings` MUST include `DROPPED_EDGE`

#### Scenario: UNRESOLVED_CALL_TASK reserved
- GIVEN any current flow input
- WHEN the flow is parsed
- THEN `warnings` MUST NOT include `UNRESOLVED_CALL_TASK` — not yet triggerable by any code path

#### Scenario: MISSING_ACTION_ID
- GIVEN an action entry with no `id`
- WHEN the flow is parsed
- THEN `warnings` MUST include `MISSING_ACTION_ID`

#### Scenario: DUPLICATE_ACTION_ID
- GIVEN two action entries sharing one `id`
- WHEN the flow is parsed
- THEN `warnings` MUST include `DUPLICATE_ACTION_ID`

### Requirement: Node ID Scheme

`parseFlow` MUST assign ids per the documented scheme: task-start as
`<taskId>::start`, branch-output as `<actionId>::<outputId>`, action nodes
as the raw Architect GUID; Switch cases resolve via `referenceId`↔`outputId`
and menu-choice actions are inlined.

#### Scenario: Task-start id
- GIVEN a task with id `T1`
- WHEN the flow is parsed
- THEN a node with id `T1::start`, `kind:"task-start"` MUST exist

#### Scenario: Branch-output id
- GIVEN action `A1` with output `__FAILURE__`
- WHEN the flow is parsed
- THEN a node with id `A1::__FAILURE__`, `kind:"branch-output"` MUST exist

#### Scenario: Switch case-to-output resolution
- GIVEN a `SwitchAction` whose `cases[].referenceId` values match `paths[].outputId` values
- WHEN the flow is parsed
- THEN each case MUST resolve to the branch-output node sharing that `outputId`

#### Scenario: Inline menu-choice action
- GIVEN a `menuChoiceList` entry with an action inlined under `.action`
- WHEN the flow is parsed
- THEN that inline action MUST produce its own action node, wired as a successor of the menu action

### Requirement: findRawActions Lookup

`findRawActions` MUST accept a raw flow configuration and a list of action
ids and return `{found, notFound}` covering every requested id exactly
once, stripping any `::`-suffixed synthetic id to its GUID before lookup.

#### Scenario: Found ids
- GIVEN ids that exist as actions in the configuration
- WHEN `findRawActions` runs
- THEN each MUST appear in `found` with its raw action subtree

#### Scenario: Not-found ids
- GIVEN ids absent from the configuration
- WHEN `findRawActions` runs
- THEN each MUST appear in `notFound`

#### Scenario: Synthetic suffixed id resolved
- GIVEN a requested id of the form `<actionId>::<outputId>`
- WHEN `findRawActions` runs
- THEN the suffix MUST be stripped and the underlying action, if present, returned in `found`

#### Scenario: Mixed batch
- GIVEN a batch mixing found, not-found, and suffixed ids
- WHEN `findRawActions` runs
- THEN `found` plus `notFound` MUST account for every distinct requested GUID exactly once

### Requirement: searchRawActions Content Search

`searchRawActions` MUST search only string leaf values (never object keys)
for a literal substring or regular expression, honoring case sensitivity
and a `maxMatchesPerAction` cap, and MUST distinguish "zero matches" from
"configuration not searchable".

#### Scenario: Literal substring match
- GIVEN a literal pattern present in a string leaf value
- WHEN `searchRawActions` runs with `regex:false`
- THEN the containing action MUST be returned with a match

#### Scenario: Regex match
- GIVEN a valid regular expression pattern
- WHEN `searchRawActions` runs with `regex:true`
- THEN actions whose string leaves match the expression MUST be returned

#### Scenario: Case sensitivity
- GIVEN a pattern differing only in case from a leaf value
- WHEN `searchRawActions` runs with `caseSensitive:true` then `caseSensitive:false`
- THEN the sensitive call MUST NOT match and the insensitive call MUST match

#### Scenario: Object keys never match
- GIVEN a pattern equal to an object key name but absent from any string value
- WHEN `searchRawActions` runs
- THEN no match MUST be reported for that key

#### Scenario: maxMatchesPerAction truncation
- GIVEN an action with more matching leaves than `maxMatchesPerAction`
- WHEN `searchRawActions` runs
- THEN only up to that cap MUST be returned for the action, marked truncated

#### Scenario: Zero matches vs. unsearchable configuration
- GIVEN a well-formed non-matching configuration, and separately one lacking a traversable `flowSequenceItemList`
- WHEN `searchRawActions` runs on each
- THEN the first MUST return `hasMatches:false` (a success), and the second MUST be an error distinct from a zero-match result

### Requirement: MCP Tool Integration

`flow-ir.ts`, `flow-action.ts`, and `search-in-flow.ts` MUST import
`parseFlow`, `findRawActions`, and `searchRawActions` from the native
module with no other code change; their input schemas, output envelopes,
and error handling MUST behave identically to their current staged
contract.

#### Scenario: End-to-end tool behavior unchanged
- GIVEN the three tool files import from the native module instead of the removed dependency
- WHEN each tool is invoked against a fetched flow configuration
- THEN each MUST produce the same envelope shape and error behavior as its current staged contract
