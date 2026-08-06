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

## Relative imports need explicit `.ts` extensions at runtime

`tsc` with `--allowImportingTsExtensions` happily typechecks a relative import written without an extension (`import { X } from "./constants"`), but `deploy_flow`/`update_flow` execute the file under Node's native ESM loader, which requires the extension explicitly. The typecheck step passes; the deploy fails.

**Symptom:** `Deploy failed: Cannot find module '/path/to/flows/constants' imported from '/path/to/flows/inbound-banmedica.ts'`

**Fix:** always import local flow modules with the `.ts` suffix — applies to every relative import between flow files (`helpers.ts`, `constants.ts`, etc.), not just the entry file the deploy tool loads directly:
- Correct: `import { QUEUE_IDS, TEXTS } from "./constants.ts";`
- Wrong: `import { QUEUE_IDS, TEXTS } from "./constants";`

## `addMenuTransferToAcd`'s action is not a valid container for follow-up actions

`archFactoryMenus.addMenuTransferToAcd(menu, name, digit)` bundles a `TransferToAcd` action directly into the menu choice. Its `.actionTransferToAcd.outputFailure` looks like any other `ArchActionOutput`, but the SDK rejects adding actions to it — the action is considered "part of a menu choice," not a free-standing action.

**Symptom:** `Deploy failed: - Parameter 'archBaseMultiActionContainer' in 'ArchFactoryActions.addActionDisconnect' is invalid. Reason: ERROR! unable to add an action to the action container because the action container is not valid. valid action containers are tasks or outputs on an action when the action is not part of a menu choice.`

**Fix:** don't use `addMenuTransferToAcd`. Use `addMenuTask` to get a plain task as the menu choice, then add the transfer action to that task directly with `addActionTransferToAcd(task)` — its `outputFailure` is a normal, valid container:

```typescript
// Wrong
const opcion1 = archFactoryMenus.addMenuTransferToAcd(mainMenu, "Emergencia", "1");
await opcion1.actionTransferToAcd.setLiteralByQueueIdAsync(queueId);
archFactoryActions.addActionDisconnect(opcion1.actionTransferToAcd.outputFailure, "Fin");

// Correct
const opcion1 = archFactoryMenus.addMenuTask(mainMenu, "Emergencia", "1");
const transfer = archFactoryActions.addActionTransferToAcd(opcion1.actionTask.task);
await transfer.setLiteralByQueueIdAsync(queueId);
archFactoryActions.addActionDisconnect(transfer.outputFailure, "Fin");
```

This is likely a broader pattern: any `addMenu<ActionType>` convenience helper that bundles an action into the menu choice itself probably has the same restriction on that action's secondary outputs. When in doubt, prefer `addMenuTask` + adding the action explicitly.

## Expression language has no `ToNumber` — use `ToDecimal`

**Symptom:** `ERROR! expression text of 'ToNumber(Replace(Call.Ani, "+56", ""))' is in error. Reason: 'ToNumber' at position 1 is not a valid function or variable reference.`

**Fix:** the function that converts a string expression to a numeric value is `ToDecimal(value)` (already listed in `expression-reference.md`'s function table), not `ToNumber(value)`. `tsc` doesn't catch expression-string typos — this is a runtime-only error.

## A menu's `menuDefault` still needs its own DTMF/speech term

Setting `mainMenu.menuDefault = someMenuTask` makes that task the fallback when no other choice matches, but Architect still validates that every `ArchMenuTask` child of a menu (default or not) has at least one recognition term (DTMF digit or speech grammar) of its own.

**Symptom (validation ERROR, not a warning — `checkInAsync()` still succeeds and saves the flow with the error present; only `validateAsync()`'s report flags it):**
`ERROR [[TrackingID:109, Name:'Opcion invalida', Type:'ArchMenuTask']]: Each menu choice must have DTMF or speech recognition terms for each supported language`

**Fix:** give the default/fallback task an explicit, otherwise-unused digit (e.g. `"0"` when the real options use 1–3):

```typescript
// Wrong
const opcionInvalida = archFactoryMenus.addMenuTask(mainMenu, "Opcion invalida");

// Correct
const opcionInvalida = archFactoryMenus.addMenuTask(mainMenu, "Opcion invalida", "0");
```

## In-Queue Call Flows (`inqueuecall`) do not support the Wait action

`archFactoryActions.addActionWait` is valid in `inbound-call` and other flow types but is rejected outright in `inqueuecall` flows — the queue engine owns call-hold/wait state while a call is queued, so the flow can't insert its own wait.

**Symptom:** `Deploy failed: - Parameter 'actionDefId' in 'ArchBaseFactory.validateActionDefId' is invalid. Reason: ERROR! invalid action definition because 'WaitAction' cannot be used in flows of type 'inqueuecall'.`

**Fix:** replace the Wait with a `CollectInput` action whose `noEntryTimeoutMS` parameter provides the same delay. If a caller-entered digit isn't actually needed, wire both `outputSuccess` and `outputFailure` to the same follow-up actions so the timeout path (the one that fires in practice) and the accidental-digit path behave identically:

```typescript
// Wrong (rejected in inqueuecall)
archFactoryActions.addActionWait(loopTask, "Espera 10s", "ToDuration(10000)");
archFactoryActions.addActionPlayAudio(loopTask, "Audio", texts.audio);
const transfer = archFactoryActions.addActionTransferToAcd(loopTask, "Transfer");

// Correct
const wait = archFactoryActions.addActionCollectInput(
    loopTask, "Espera 10s", '""', undefined, /* interDigitTimeoutMS */ 5000,
    /* noEntryTimeoutMS */ 10000,
);
wait.setInputDataVariable("Flow.someUnusedVar"); // see next gotcha — required
wait.setDigitsExact(1);

for (const branch of [wait.outputSuccess, wait.outputFailure]) {
    archFactoryActions.addActionPlayAudio(branch, "Audio", texts.audio);
    const transfer = archFactoryActions.addActionTransferToAcd(branch, "Transfer");
    await transfer.setLiteralByQueueIdAsync(queueId);
}
```

If the in-queue flow's intent is an actual caller-facing offer (e.g. "press 1 for a callback"), this is exactly the pattern already used for that purpose — no separate Wait is needed at all; the offer's own `noEntryTimeoutMS` acts as the wait period, and leaving the timeout (`outputFailure`) branch empty lets the surrounding `ArchTaskLoop` repeat automatically.

## `CollectInput` requires `setInputDataVariable` even when the digit is never used

**Symptom (validation ERROR, not caught by typecheck):** `ERROR [[TrackingID:11, Name:'Espera 10s', Type:'ArchActionCollectInput']]: No value set for Input Data Name - There is no variable specified`

**Fix:** always call `.setInputDataVariable("Flow.someVariable")` on a `CollectInput` action, even if the flow logic ignores the captured value (e.g. when `CollectInput` is repurposed purely as a timed wait, per the previous gotcha). Declare a throwaway flow variable for this if there's no other natural one to reuse:

```typescript
flow.addVariable("waitDigit", flow.dataTypes.string);
// ...
wait.setInputDataVariable("Flow.waitDigit");
```

## A retry after a validation ERROR is implicitly re-creating an existing flow

Reinforces "Re-creating Existing Flows" in `sdk-patterns.md`: `checkInAsync()` can succeed and persist a flow to Genesys Cloud even when `validateAsync()` reports an ERROR-level issue — validation errors don't block the save, they're advisory until publish. Practical consequence: if a `deploy_flow` run hits a validation ERROR, fixing the code and re-running `deploy_flow` is not deploying a "new" flow — it's implicitly re-creating one that already exists from the previous (broken) attempt, so `architect:flow:delete` is required even though nothing was ever really finished from the flow-author's perspective.

**Symptom on retry without delete permission:**
```
[error] could not delete the existing flow named '...'
[error] HTTP 409 POST /api/v2/flows — A flow of type inboundcall called '...' already exists.
```

## Required OAuth Client permissions for `deploy_flow`

The OAuth Client the plugin authenticates with needs, at minimum:

| Permission | Needed for |
|---|---|
| `oauth:client:view` | Session startup / authentication itself |
| `integrations:action:view` or `bridge:actions:view` | Looking up Data Actions by name (`setDataActionByNameAsync`) |
| `architect:flow:delete` | Re-running `deploy_flow` against a flow name that already exists (see previous gotcha — this includes flows from a prior failed-but-checked-in attempt) |

If a deploy fails with an HTTP 403 naming one of these permission sets, that's the fix — no code change needed, just grant the permission to the OAuth Client and retry the same deploy.
