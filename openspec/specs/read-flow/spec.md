# Read Flow Specification

## Purpose

Defines behavior for exporting an existing Architect flow's full
definition as YAML, without checkout/lock, via a new read-only
deploy-runner mode and MCP tool (working name `read_flow`, unconfirmed
— `state.yaml` decision `tool-name`). Gives callers (and the LLM
authoring `updateFlow` bodies) visibility into states/tasks/
variables/actions before editing.

## Requirements

### Requirement: Flow Identifier Resolution

`read_flow` MUST accept either `flowId` alone or `flowName` +
`flowType`, and MUST reject any other combination. The `inputSchema`
MUST be a flat `ZodRawShape` (never wrapped in `.refine()`/`ZodEffects`)
with the exactly-one-of check done as a manual post-parse `if` in the
handler, exactly like `update_flow` post-fix — the installed MCP SDK's
`tools/list` introspection cannot read `.shape` off a `ZodEffects`
instance and silently advertises zero parameters when it's used (see
`design.md`/`tasks.md` for the confirmed production bug this caused in
`update_flow`). Reuses `resolveFlowIdentifier`.

#### Scenario: Resolve by flowId
- GIVEN a caller supplies `flowId`
- WHEN input is validated
- THEN it MUST pass and the deploy-runner MUST call `loadFlowByFlowIdAsync`

#### Scenario: Resolve by flowName and flowType
- GIVEN `flowName`+`flowType`, no `flowId`
- WHEN input is validated
- THEN it MUST pass and the deploy-runner MUST call `loadFlowByFlowNameAsync`

#### Scenario: Missing or ambiguous identifier
- GIVEN neither identifier, or both `flowId` and `flowName` are supplied
- WHEN the handler runs its post-parse validation
- THEN it MUST fail with one of two distinct messages (both-given vs.
  neither-given) and no process MUST be spawned

### Requirement: Read-Only Export Workflow

`read_flow` MUST load the flow via `loadFlowBy...Async` (no checkout,
no lock) and export with `exportToObjectAsync(cb,
archEnums.FLOW_FORMAT_TYPES.yaml)` — YAML explicitly, never the SDK
default `architect` format. MUST NOT call `checkoutAndLoadFlowBy...Async`,
`unlockAsync`, `checkInAsync`, `publishAsync`, or any mutating route.

#### Scenario: Successful export, no side effects
- GIVEN a valid, existing flow identifier
- WHEN the deploy-runner runs in read mode
- THEN it MUST return `{content, fileName}` with the full YAML definition
- AND no lock MUST be acquired, released, or left behind on failure

### Requirement: Flow Not Found Handling

`read_flow` MUST return a distinct "not found" error when the target
cannot be resolved, and MUST NOT collapse it into a generic message
(per `openspec/config.yaml`'s warning against `flow-dependencies.ts`'s
error-collapsing anti-pattern).

#### Scenario: Flow does not exist
- GIVEN a `flowId`/`flowName` matching no existing flow
- WHEN `read_flow` attempts to load it
- THEN it MUST fail with "flow not found", distinct from validation/unknown errors

#### Scenario: flowType mismatch (confirmed — folds into not-found)
- GIVEN `flowName`+`flowType` where the name exists under a different type
- WHEN `read_flow` attempts to load it via `loadFlowBy...Async`
- THEN it MUST behave the same as "flow not found" — CONFIRMED empirically
  (a live test org, `flowName: "ZZZ-SDD-Test-DoNotUse-UpdateFlow"` +
  `flowType: "outboundcall"` instead of the real `"inboundcall"` returned
  `errorKind: "not-found"`, the same mapped message as a nonexistent flow),
  matching `update_flow`'s confirmed finding for
  `checkoutAndLoadFlowBy...Async` (mismatch indistinguishable from "no
  matches")

### Requirement: Flow Version Parameter

`read_flow` MUST accept optional `flowVersion` (`"latest"` default, a
version number, `"debug"`, or `"published"`) as a non-empty string
(`z.string().min(1).optional()`). The schema MUST NOT pre-validate
against a fixed enum client-side — valid version numbers are open-ended
and not enumerable — the SDK is the source of truth for rejecting
invalid values; its error MUST be surfaced, not swallowed.

#### Scenario: Default and valid explicit versions
- GIVEN `flowVersion` omitted, `"debug"`, `"published"`, or a valid number
- WHEN input is validated
- THEN it MUST pass (omitted defaults to `"latest"`) and that version MUST be requested from the SDK
- CONFIRMED (a live test org, `ZZZ-SDD-Test-DoNotUse-UpdateFlow`): omitted
  (defaults to `"latest"`, success) and an explicit numeric version (`"3.0"`,
  taken from the flow's own observed `fileName`, success) both pass and
  return identical YAML. `"debug"` and `"published"` also pass client-side
  validation and are genuinely requested from the SDK, but on this
  particular test flow (never published, no active debug session) both
  come back as an explicit SDK 404 ("version '<x>' is missing.
  (not.found)") rather than a silent fallback — their SUCCESS branch (a
  real published/debug version) remains unexercised, which is expected
  given no such version exists on the disposable test flow

#### Scenario: Invalid version value rejected by the SDK
- GIVEN `flowVersion` set to a value the SDK does not recognize
- WHEN `read_flow` requests that version from the SDK
- THEN the deploy-runner MUST surface the SDK's real error message rather
  than pre-emptively rejecting client-side
- AND the exact `errorKind` classification is unverified — confirm
  empirically during `sdd-apply` (see the known `flowVersion: "published"`
  finding from Slice A, filed under `"unknown"` pending Slice C review)

#### Scenario: Published requested but none exists (unverified)
- GIVEN `flowVersion: "published"` and the flow was never published
- WHEN `read_flow` runs
- THEN SDK behavior (error vs. silent fallback) is UNVERIFIED — MUST be confirmed during `sdd-apply`, not assumed to fall back silently

### Requirement: MCP Tool Annotations

`read_flow` MUST be registered with `readOnlyHint: true` and
`destructiveHint: false`, distinguishing it from `update_flow`/`deploy_flow`.

#### Scenario: Tool metadata reflects non-destructive intent
- GIVEN the MCP server lists available tools
- WHEN a caller inspects `read_flow`'s annotations
- THEN `readOnlyHint` MUST be `true` and `destructiveHint` MUST be `false`

### Requirement: MCP Server <-> Deploy-Runner NDJSON Protocol

`read_flow` MUST reuse the NDJSON contract already used by
`deploy_flow`/`update_flow`: newline-delimited `{type:"log"}`/
`{type:"result"}` lines on stdout, parsed with the same logic.

#### Scenario: Deploy-runner emits standard NDJSON lines
- GIVEN the deploy-runner runs in read mode
- WHEN it emits progress or completion output
- THEN each line MUST be a single JSON object with `type: "log"` or `type: "result"`, matching `deploy_flow`/`update_flow`'s shape

### Requirement: Output Size Guard (deferred)

Whether `read_flow` MUST enforce a maximum size on the exported YAML
is an OPEN decision (`state.yaml` id `size-guard-strategy`), deferred
to `sdd-design`.

#### Scenario: Large flow export (open/deferred to design)
- GIVEN a flow with a large or deeply nested definition
- WHEN it is exported to YAML
- THEN whether a size limit, truncation, or warning applies is UNSPECIFIED here — `sdd-design` MUST resolve this; no arbitrary limit is assumed
