# SDK Gotchas

## Default objects

Each flow type auto-creates different startup objects:
- `createFlowInboundCallAsync` — "Main Menu" + a default reusable task
- `createFlowDigitalBotAsync` — "Initial Greeting" (`ArchStateBot`) as the starting state
- `createFlowInboundShortMessageAsync` — "Initial State" (`ArchState`) as the starting state

Adding your own with the same names causes "Another menu/task has the same name" validation errors. Use unique names.

## Communication expressions in digital bot flows

Digital bot flows are text-based. Use plain string literal expressions, NOT `ToAudioTTS()`:
- Correct: `'"Hello! How can I help?"'` (a quoted string inside the expression)
- Wrong: `'ToAudioTTS("Hello!")'` — fails with "text to speech is not supported"

`addActionPlayAudio` wraps its TTS parameter in `ToAudioTTS()` internally, but `addActionCommunicate` takes a raw expression string.

## Flow dependency chains

A bot flow cannot be deleted while another flow references it (e.g. via `CallDigitalBotFlow`). The error is `ARCHITECT_DEPENDENCY_OBJECT_IN_USE`. Delete the dependent flow first.

## Flow name lookups require a saved flow

`getFlowInfoByFlowNameAsync` searches the server. A flow created in memory is not findable by name until `saveAsync()` or `checkInAsync()` has been called. Build and save the bot flow before calling `buildMessageFlow()`.

## Type definition inaccuracy: setTargetFlowInfoAsync

The JSDoc says it accepts `ArchFlowInfo | ArchFlowInfoBasic`, but the TypeScript declaration only lists `ArchFlowInfoBasic`. Use `as any` to pass `ArchFlowInfo` from `getFlowInfoByFlowNameAsync`.

## checkInAsync vs publishAsync — do not call both

`checkInAsync` saves the flow **and releases the lock**. If you then call `publishAsync`, it tries to save again but fails with a 409 ("Flow is not locked by client"). Use one or the other:
- `flow.checkInAsync()` — save only (flow is not published)
- `flow.publishAsync()` — validates, saves, and publishes in one call

## Validation vs publish

`publishAsync` validates locally first. If validation finds only warnings (not errors), it proceeds. The "Initial Greeting has no audio set" warning is cosmetic and does not block publishing.

## Waiting for free-text input in digital bot flows

`WaitForInput` is terminal (no continuation). `AskForIntent` is not available. `AskForBoolean`'s `outputMaxNoMatches` path is hardcoded as disabled.

The working pattern uses `DigitalMenu`:

```typescript
const menu = actionFactory.addActionDigitalMenu(state, "Menu");
menu.question.setExpression('"Pick a topic or type a question."');
menu.addChoice("Topic A");
menu.customizeNoMatch.setLiteralTrue();     // empty reprompts → immediate MaxNoMatches
menu.outputMaxNoMatches.enabled = true;      // must explicitly enable
const freeTextPath = menu.outputMaxNoMatches;
actionFactory.addActionCommunicate(freeTextPath, "Answer", '"Here is the answer."');
```

## NLU in digital bot flows — use botFlowSettings, not AskForIntent

`AskForIntent` (`AskForNLUIntentAction`) throws in digital bot flows: "'AskForNLUIntentAction' cannot be used in flows of type 'digitalbot'". NLU intent recognition IS supported, but through a different mechanism:

1. Pass `nluCreationData` as the 6th parameter to `createFlowDigitalBotAsync`
2. Use `flow.botFlowSettings.getIntentSettingsByIntentName()` to get intent settings
3. Call `intentSettings.associateWithTask(task)` to wire intents to reusable tasks
4. Set `intentSettings.confirmation.setExpression()` for confirmation prompts

When the DigitalMenu receives free-text input, the Dialog Engine checks trained intents before falling through to NoMatch. See the NLU section in `examples/digital-bot-flow.md`.

## Output path enable/disable

`ArchActionOutput.enabled` controls whether an output path (MaxNoMatches, MaxNoInputs, etc.) is active. Paths default to disabled on most action types. Adding actions to a disabled path produces "Unreachable because path is disabled" warnings. Check `canEnableDisable` before setting.

## DigitalMenu for Yes/No choices

In digital bot flows, prefer `DigitalMenu` with Yes/No choices over `AskForBoolean`. AskForBoolean's MaxNoMatches is disabled in digital bot flows and cannot be enabled. Access dynamic outputs with `menu.getOutputByName("Yes", true)` (the `true` flag is required for dynamic outputs).

## AskForBoolean question property

`AskForBoolean.question` is typed as `ArchValueString` but `setLiteralString()` throws at runtime. Use `setExpression('"text"')` instead.

## ArchValueBoolean setExpression

`setExpression("true")` fails on `ArchValueBoolean` with "cannot assign the expression text 'true'". Use `setLiteralTrue()` / `setLiteralFalse()` instead.

## Action containers: pass the object, not outputSequence

For chat, message, and email flows, pass the state or task object directly to action factory methods — not `state.outputSequence`. The `outputSequence` property exists at runtime but is rejected as an invalid action container:
- Correct: `archFactoryActions.addActionSendResponse(initialState)`
- Wrong: `archFactoryActions.addActionSendResponse(initialState.outputSequence)`

## SendResponse API

The type definitions declare `setResponseBodyByLiteralString` but it does not exist at runtime. Use `messageBody.setExpression()` instead:
- Correct: `reply.messageBody.setExpression('"Hello!"')`
- Wrong: `reply.setResponseBodyByLiteralString("Hello!")`

## JumpToTask not available in inbound message flows

`addActionJumpToTask` (`TransferTaskAction`) cannot be used in `inboundshortmessage` flows. Add actions directly to the initial state instead of routing through reusable tasks.

## Flow naming on re-runs

`createFlow*Async` deletes an existing flow with the same name. This requires `architect:flow:delete` permission. If you don't have it, use a new name, or use the non-destructive update flow described below.

## Editing a flow in place instead of re-creating it

Re-running `deploy_flow`/`buildFlow` against a flow name that already exists deletes and recreates it — the flow gets a new ID and its version history is gone. To edit a flow without losing either, use `checkoutAndLoadFlowByFlowIdAsync` / `checkoutAndLoadFlowByFlowNameAsync` via the `update_flow` MCP tool and an `updateFlow(scripting, flow)` export instead of `buildFlow`.

Key mechanics, all handled by the deploy-runner's `updateFlow()` orchestrator (`src/deploy-runner/index.ts`) — you don't call these yourself from the flow file:

- **`flowType` is always required**, for both `checkoutAndLoadFlowByFlowIdAsync` and `checkoutAndLoadFlowByFlowNameAsync`. There is no id-only lookup in the installed SDK version — even when you already know the flow's ID, you must also supply its type (e.g. `"inboundcall"`).
- **Checkout acquires a lock.** `checkoutAndLoadFlowBy...Async` locks the flow for editing. If the checkout succeeds but the following save (`checkInAsync`/`publishAsync`) throws, the lock must be released via `flow.unlockAsync()` before the error is reported — otherwise the flow is stuck locked with no UI action able to release it. The deploy-runner does this automatically; it's why your `updateFlow` export must not call `checkInAsync`/`publishAsync` itself (that would move the save outside the guarantee).
- **Locked-by-another-user is a distinct failure mode**, not a generic error. If someone else has the flow open in Architect, checkout fails unless `forceUnlock: true` is passed — which discards their unsaved UI edits. Default behavior (`forceUnlock: false`) fails loudly instead of silently overriding another user's work.
- **`checkInAsync` vs `publishAsync`** still applies exactly as documented above — call 1 always checks in, call 2 (`confirmPublish: true`) always publishes instead, gated by a full-baseline diff. Neither call does both.
- **Publish is never a single-call decision.** `update_flow` has no `publish` input. It always requires two separate calls against the same `flowId`: call 1 edits and checks in, capturing a baseline export and a requested-diff summary; call 2 (`confirmPublish: true`) re-diffs the live flow against that same baseline and only publishes if nothing changed beyond the requested edit. A blocked or failed call 2 leaves the baseline file in place — restart from call 1.
- **A wrong `flowType` does not fail cleanly — empirically confirmed against a real org.** Checking out **by `flowId`** does not enforce `flowType` at all: a valid `flowId` with an unrelated `flowType` string still succeeds. Checking out **by `flowName`** with the wrong `flowType` returns the exact same `"no matches"` response as a name that doesn't exist at all — there's no SDK signal that distinguishes "wrong type" from "not found". `flowType` is still a required parameter, but don't rely on it to catch a copy-paste mistake; a mismatched `flowType` on the `flowId` path silently updates the flow anyway, and on the `flowName` path it just looks like a not-found error.

See `sdk-patterns.md`'s "The `updateFlow` Contract" section for the export signature, and `SKILL.md`'s "Updating an Existing Flow" section for the MCP tool's two-call input contract (`flowId`/`flowName`+`flowType`, `forceUnlock`, `confirmPublish`).

## Slot and entity type names must differ

When using `entityTypeBindings` in NLU creation data, the slot name (`entityName`) and entity type name (`entityType`) must be different. Using the same name for both causes a validation error in the Architect UI: "Slots and Slot Types contain duplicate names: X". The SDK's `validateAsync()` does not catch this.

- Wrong: `entityTypeBindings: [{ entityName: "NumberValue", entityType: "NumberValue" }]`
- Correct: `entityTypeBindings: [{ entityName: "NumberValue", entityType: "NumberPattern" }]`

## ArchValueInteger uses `setLiteralInt`, not `setLiteralInteger`

The method for setting an integer literal is `setLiteralInt(n)`, not `setLiteralInteger(n)`. Similarly, `setDefaultValueAsInteger(n)` exists on flow variables but not on `ArchValueInteger`.

## No-match apology "Sorry." prefix

Bot flows prepend a default "Sorry." before every no-match message via `flow.userInputSettings.noMatchApology`. To remove it:

```typescript
flow.userInputSettings.noMatchApology.setExpression('""');
```

## `userInputSettings` is on the flow, not `botFlowSettings`

UX settings like `noMatchApology`, `noMatchesMax`, and `noInputsMax` are accessed via `flow.userInputSettings`, not `flow.botFlowSettings.userInputSettings`. The `botFlowSettings` property is for intent/slot configuration.

## Division

The SDK auto-resolves the Home division during session startup and sets it on `flowFactory.defaultFlowCreationDivision`. You do NOT need to pass a division.

## Reusable tasks and jumpToTask

`archFactoryTasks.addTask(flow, name)` creates a reusable task on any flow extending `ArchBaseFlowWorkflow` (includes digital bot flows). For circular references (task A → task B → A), create all tasks as empty shells upfront, then populate them with actions afterward.

## `read_flow` truncates very large YAML exports

`read_flow` caps the exported YAML at `MAX_YAML_CHARS = 200_000` characters (~50k tokens at ~4 chars/token — a conservative starting estimate, see `openspec/changes/read-flow/design.md`'s Open Questions). If the real export exceeds that limit, the tool truncates the text and appends an explicit marker (`[TRUNCATED — original size N chars, showing first 200000. Request a specific flowVersion or narrow the review to reduce size.]`), and the underlying result carries `truncated: true`. Against the real "Calidda" org's disposable test flow, a full export was only 2297 characters — well under the limit — so this constant remains unvalidated against a large, real-world flow; treat it as provisional and expect it may need tuning.

## `read_flow`'s `flowVersion` values, and `"published"` on an unpublished flow

`flowVersion` is optional and not validated client-side — the SDK is the source of truth. Confirmed accepted values: `"latest"` (the SDK's own default when the argument is omitted), a specific commit-version number as a string, `"debug"`, and `"published"`.

**`flowVersion: "published"` against a flow that was never published fails loudly — empirically confirmed end-to-end through the real `read_flow` MCP tool**, not just the underlying deploy-runner: the SDK returns an explicit HTTP 404, `"Flow '<name>' version 'published' is missing. (not.found)"`, rather than silently falling back to the latest or debug version. Don't assume `flowVersion: "published"` always returns something — check for this error whenever the flow in question might not have a published version yet.

That error message is currently classified as `errorKind: "unknown"`, NOT `"not-found"`, even though the raw text ends in `(not.found)`. `read_flow` reuses `update_flow`'s `classifyUpdateError()` unchanged, and its regex (`not[\s-]?found`) does not match the literal `(not.found)` (a dot, not a space or hyphen) that this specific SDK error uses. This is a known, documented classification gap — not something to silently work around in your own code — so callers should not rely on `errorKind` alone to detect this case; check the raw error text for `"version '...' is missing"` if you need to distinguish it from a generic not-found.
