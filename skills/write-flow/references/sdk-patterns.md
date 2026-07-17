# Architect Scripting SDK Patterns

## SDK Namespaces

The SDK object (`scripting`) has these namespaces:

```typescript
scripting.environment   // archSession, org info
scripting.factories     // archFactoryFlows, archFactoryActions, archFactoryMenus, archFactoryStates, archFactoryTasks
scripting.enums         // archEnums (constants, flow types, locations)
scripting.services      // archLogging
scripting.dataTypes     // data type definitions
scripting.languages     // language support
```

## The `buildFlow` Contract

Every flow file must export this function:

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

export async function buildFlow(scripting: ArchitectScripting) {
    const { archFactoryFlows, archFactoryActions } = scripting.factories;

    const flow = await archFactoryFlows.createFlowInboundCallAsync(
        "My Flow Name",
        "Description of the flow",
    );

    // Build the flow logic...

    return await flow.checkInAsync();
}
```

- The SDK instance is passed as a parameter — never `require()` it
- Only use `import type` from the SDK package
- The deploy runner handles authentication and session management
- Return `await flow.checkInAsync()` — this saves the flow and returns the flow object, which the deploy runner uses to run `validateAsync()` and report validation warnings/errors

## The `read_flow` Contract (reading an existing flow, read-only)

Unlike `buildFlow`, there's no exported function to author for `read_flow` —
it's a read-only MCP tool, not something a flow file wires up. Call it
directly, before writing an `updateFlow` export, to see the flow's real
current structure:

```
Tool: read_flow
Input: {
  "flowId": "<existing-flow-id>",   // or "flowName"
  "flowType": "inboundcall",
  "flowVersion": "latest"            // optional
}
```

- Supply exactly one of `flowId` or `flowName` — `flowType` is always
  required for both lookup paths (same requirement as an `update_flow`
  checkout).
- `flowVersion` is optional: `"latest"` (the SDK's own default when
  omitted), a specific numeric commit-version as a string, `"debug"`, or
  `"published"`. Not validated client-side — the SDK is the source of truth
  for what's a valid value (see `gotchas.md` for what happens when
  `"published"` doesn't exist yet).
- Returns the flow's full definition as YAML text (states, tasks, variables,
  actions) — the same shape you'd get exporting from the Architect UI.
  `flowFormat` is intentionally NOT an exposed parameter: the tool always
  requests `archEnums.FLOW_FORMAT_TYPES.yaml` internally. The SDK's other
  export format (`architect`) is a semi-opaque backup/restore format with no
  use case as LLM-readable context, so it was never exposed as a choice.
- Never checks out or acquires a lock — safe to call at any time, including
  while `update_flow` or another user already has the flow open in
  Architect. There is no `unlockAsync()` path to worry about, because
  `read_flow` never takes a lock to release.
- Very large flows may come back truncated — see `gotchas.md`.

## Flow Creation Methods

| Flow Type | Factory Method |
|-----------|----------------|
| Inbound Call | `archFactoryFlows.createFlowInboundCallAsync(name, description)` |
| Inbound Chat | `archFactoryFlows.createFlowInboundChatAsync(name, description)` |
| Inbound Email | `archFactoryFlows.createFlowInboundEmailAsync(name, description)` |
| Inbound Message (SMS) | `archFactoryFlows.createFlowInboundShortMessageAsync(name, description)` |
| Workflow | `archFactoryFlows.createFlowWorkflowAsync(name, description)` |
| Bot | `archFactoryFlows.createFlowBotAsync(name, description)` |
| Digital Bot | `archFactoryFlows.createFlowDigitalBotAsync(name, description)` |

All return a Promise that resolves to the flow object. Bot flows and digital bot flows accept an optional `nluCreationData` parameter for NLU intent training — see the bot-flow and digital-bot-flow examples.

## Initial State / Startup Object

Every flow has a `startUpObject` where execution begins:

```typescript
const initialState = flow.startUpObject;
```

Actions are added by passing the state or task object directly to action factory methods. For voice flows (inbound call), you can also use `outputSequence` on menu choices. See gotchas for details on which container types are accepted.

## Variables

```typescript
const nameVar = flow.addVariableString("customerName");
nameVar.setDefaultValueAsString("Guest");

const countVar = flow.addVariableInteger("attemptCount");
countVar.setDefaultValueAsInteger(0);

const isVIPVar = flow.addVariableBoolean("isVIP");
isVIPVar.setDefaultValueAsBoolean(false);
```

Common built-in variables: `Call.Ani` (caller's phone), `Call.Dnis` (dialed number).

## Menus (IVR / DTMF)

```typescript
const { archFactoryMenus } = scripting.factories;

const menu = archFactoryMenus.addMenu(flow, "Main Menu");
menu.setMenuPromptByText("Press 1 for Sales, 2 for Support");

const choice1 = menu.addMenuChoice("1", "Sales");
const choice2 = menu.addMenuChoice("2", "Support");

// Add actions to each choice's sequence
const transfer = archFactoryActions.addActionTransferToAcd(choice1.outputSequence);
await transfer.setQueueByName("Sales Queue");

// Jump to menu from initial state
const jumpToMenu = archFactoryActions.addActionJumpToMenu(sequence);
jumpToMenu.targetMenu = menu;
```

## States (Reusable Segments)

```typescript
const { archFactoryStates } = scripting.factories;

const state = archFactoryStates.addState(flow, "MyState");
// Add actions to state.outputSequence...

// Jump to state from elsewhere
const changeState = archFactoryActions.addActionChangeState(someSequence);
changeState.targetState = state;
```

## Reusable Tasks

```typescript
const { archFactoryTasks } = scripting.factories;

const task = archFactoryTasks.addTask(flow, "My Task");
// Add actions to task.outputSequence...

// Jump to task from elsewhere
const jumpToTask = archFactoryActions.addActionJumpToTask(someContainer, "jump", task);
```

For circular references (task A → task B → task A), create all tasks as empty shells first, then populate them with actions.

## User Input Settings (Bot Flows)

Bot flows and digital bot flows have `flow.userInputSettings` for controlling UX behaviour during slot and intent collection:

```typescript
const userInput = flow.userInputSettings;

// Remove the default "Sorry." prefix from no-match messages
userInput.noMatchApology.setExpression('""');

// Limit no-match retries before outputMaxNoMatches fires
userInput.noMatchesMax.setLiteralInt(3);

// Limit no-input retries
userInput.noInputsMax.setLiteralInt(3);
```

These are on the flow object directly (`flow.userInputSettings`), not on `flow.botFlowSettings`.

## Expression Functions

Useful Architect expression functions for building dynamic text:

- `Append("part1", variable, "part2")` — string concatenation
- `ToInt(Slot.Name)` — convert a slot value to integer for numeric comparison
- `ToString(variable)` — convert to string

## Async Operations

Always `await` these:
- Flow creation (`createFlow*Async`)
- Flow save (`checkInAsync`)
- Flow publish (`publishAsync`)
- Queue lookup (`setQueueByName`)
- Flow info lookup (`getFlowInfoByFlowNameAsync`)

## Flow Lifecycle

1. **Create in-memory**: `archFactoryFlows.createFlow*Async()`
2. **Build logic**: add variables, states, actions, menus
3. **Save**: `flow.checkInAsync()` — saves to Genesys Cloud and unlocks
4. **Publish** (optional): `flow.publishAsync()` — makes flow live

## Re-creating Existing Flows

`createFlow*Async` will delete an existing flow with the same name before creating. This requires `architect:flow:delete` permission. If the flow is referenced by another flow, delete the dependent flow first.
