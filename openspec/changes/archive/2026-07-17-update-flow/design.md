# Design: `update_flow` — Edit Existing Architect Flows

## Technical Approach

Reuse `src/deploy-runner/index.ts`'s existing session/interceptor bootstrap (HTTPS patch, `console.log`/`stdout` TRACE patch, `installLogging`) for a new `updateFlow` orchestrator, and add a dedicated `update_flow` MCP tool mirroring `deploy-flow.ts`'s spawn+NDJSON shape. Testable logic is extracted to a **side-effect-free sibling module** so `node:test` never triggers the interceptor monkey-patching.

## Architecture Decisions

| Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|
| Tool surface | Dedicated `update_flow` tool | `mode` param on `deploy_flow` | MCP annotations are static per-tool; `.refine()` gymnastics + name-based mode inference is unsafe (per proposal). |
| CLI dispatch | `--mode create\|update` flag on the existing deploy-runner script (default `create`) | Two separate scripts | A second script would re-install the HTTPS/console.log/session bootstrap (~150 lines), duplicating monkey-patching the user explicitly asked not to repeat. |
| Testable-logic location | New `src/deploy-runner/update-helpers.ts`, zero top-level side effects, imported by both `index.ts` and its test file | Export `resolveFlowIdentifier`/unlock logic directly from `index.ts` | `index.ts`'s top-level code patches global `https.request`, `console.log`, `process.stdout.write` on import. Importing it from a test file would corrupt the test runner's own I/O. Splitting keeps `updateFlow()` (SDK-calling orchestrator) in `index.ts` next to `buildFlow`'s caller, while the two testable units live where importing them is side-effect-free. |
| Identifier source | `flowId`/`flowName`/`flowType`/`forceUnlock` are **MCP tool call params**, not literals inside the user's flow file | Hardcode identifiers in the flow file like `buildFlow` hardcodes name/description | Update targets a flow whose identity is caller-known runtime state (from a prior deploy), not authoring-time data. |
| checkIn/publish ownership | Deploy-runner's `applyUpdateAndSave` calls `flow.checkInAsync()`/`flow.publishAsync()` itself, gated by a caller-supplied `publish` flag | User's flow file calls `checkInAsync`/`publishAsync` itself (mirroring `buildFlow`'s current pattern) | Spec requires `publish: false\|true` to select save-vs-publish as a per-invocation choice; the user's `updateFlow(scripting, flow)` export becomes edits-only, so the deploy-runner can wrap the save call in the same try/catch that guarantees `unlockAsync()` on failure — a save failure the user file forgot to catch would otherwise still orphan the lock. |
| MCP `inputSchema` shape | Full `z.object({...}).refine(...)` schema (not a raw shape) | Raw shape + post-parse `if` (existing pattern in the other 3 tools) | Installed `@modelcontextprotocol/sdk` (`^1.29`) types `inputSchema` as `ZodRawShapeCompat \| AnySchema`, and `AnySchema` includes `z3.ZodTypeAny` — the result of `.refine()`. Confirmed by reading `zod-compat.d.ts`. This is new precedent in the codebase; documented here so future tools know it's available. |
| NDJSON parsing | Duplicate the inline parse loop in `update-flow.ts` (not extracted) | Extract shared `DeployRunnerLine` parser | Extraction touches the working, zero-test `deploy-flow.ts`, increasing Slice B's diff beyond its scope. `docs/assessment.md` already tracks this debt (§"Undocumented private protocol") — treat as a separate future change, not bundled here. |

## Data Flow

```
update_flow (MCP tool)
  → spawn node deploy-runner --mode update --flow-file F
                              [--flow-id I | --flow-name N --flow-type T]
                              [--force-unlock] [--publish]
  → deploy-runner main(): resolveFlowIdentifier(opts)   [update-helpers.ts]
      → archFactoryFlows.checkoutAndLoadFlowBy{FlowId,FlowName}Async(...)
      → capture flow.id / flow.name directly off the returned object
      → dynamic import(flowFile); mod.updateFlow(scripting, flow)   [user file — edits only]
      → applyUpdateAndSave(flow, mutate, publish)        [update-helpers.ts]
          → await mutate(flow)
          → await (publish ? flow.publishAsync() : flow.checkInAsync())
          → on throw from either step: flow.unlockAsync(); rethrow with unlocked flag
  ← emit({type:"result", success, flowId, flowName, unlocked?, errorKind?, error?})
  → update-flow.ts parses NDJSON, maps errorKind → distinct message
```

## `updateFlow` Contract

```typescript
// src/deploy-runner/update-helpers.ts (pure/no top-level side effects)
export type FlowIdentifier =
  | { kind: "byId"; flowId: string }
  | { kind: "byName"; flowName: string; flowType: string };

export function resolveFlowIdentifier(opts: {
  flowId?: string; flowName?: string; flowType?: string;
}): FlowIdentifier;
// Precedence: flowId wins if both are present (defensive; zod .refine()
// already forbids both at the MCP boundary). Throws if neither is valid.

export async function applyUpdateAndSave(
  flow: { checkInAsync(): Promise<unknown>; publishAsync(): Promise<unknown>; unlockAsync(): Promise<unknown> },
  mutate: (flow: unknown) => Promise<unknown>,
  publish: boolean,
): Promise<{ unlocked: boolean }>;
// Calls mutate(flow), then flow.publishAsync() if publish else flow.checkInAsync().
// On throw from either step, calls flow.unlockAsync() (best-effort — a second
// failure is caught and reported via unlocked:false) then rethrows the original error.

// src/deploy-runner/index.ts (I/O orchestrator, reuses installed interceptors)
export async function updateFlow(
  scripting: ArchitectScripting,
  absoluteFlowPath: string,
  opts: { flowId?: string; flowName?: string; flowType?: string; forceUnlock?: boolean; publish?: boolean },
): Promise<{ flowId: string; flowName: string }>;
```

The user's flow file exports `updateFlow(scripting, flow): Promise<void>` — edits only, no `checkInAsync`/`publishAsync` call (unlike `buildFlow`, which still owns that call for the create path).

CLI: `--mode update` selects `updateFlow(...)` over the existing `mod.buildFlow(scripting)` path in `main()`; new `--flow-id`, `--flow-name`, `--flow-type`, `--force-unlock`, `--publish` args feed `opts`. `emit("result", ...)` payload widens with optional `unlocked` and `errorKind`.

## Sequence Diagram

```mermaid
sequenceDiagram
    participant Tool as update_flow (MCP tool)
    participant Runner as deploy-runner (--mode update)
    participant SDK as Architect Scripting SDK
    participant File as user flow file (mod.updateFlow)

    Tool->>Runner: spawn(node, [--mode update, --flow-file, --flow-id/--flow-name+--flow-type, --force-unlock, --publish?])
    Runner->>Runner: resolveFlowIdentifier(opts)
    Runner->>SDK: checkoutAndLoadFlowBy{FlowId,FlowName}Async(id/name, type?, forceUnlock)
    SDK-->>Runner: flow {id, name, unlockAsync, checkInAsync, publishAsync}
    Runner->>File: import(flowFile); mod.updateFlow(scripting, flow)
    File->>SDK: mutate flow (edits only)
    File-->>Runner: resolves
    Runner->>SDK: publish ? flow.publishAsync() : flow.checkInAsync()
    SDK-->>Runner: success
    Runner-->>Tool: emit result {success:true, flowId, flowName}

    Note over Runner,SDK: Error path — checkout succeeded, save failed
    Runner->>SDK: checkoutAndLoadFlowBy...Async
    SDK-->>Runner: flow (checked out, locked)
    Runner->>File: mod.updateFlow(scripting, flow)
    File->>SDK: mutate flow (edits only)
    File-->>Runner: resolves (mutation itself succeeded)
    Runner->>SDK: flow.checkInAsync() / publishAsync()
    SDK-->>Runner: throws (validation/permission/etc.)
    Runner->>SDK: flow.unlockAsync()
    SDK-->>Runner: unlocked
    Runner-->>Tool: emit result {success:false, unlocked:true, errorKind, error}
```

## Zod Schema (`src/mcp-server/tools/update-flow.ts`)

```typescript
import { z } from "zod/v3";

const inputSchema = z
    .object({
        flowFile: z.string().min(1)
            .describe("Path to the TypeScript file exporting updateFlow(scripting, flow)"),
        flowId: z.string().min(1).optional()
            .describe("Existing flow ID to update"),
        flowName: z.string().min(1).optional()
            .describe("Existing flow name to update (requires flowType)"),
        flowType: z.string().min(1).optional()
            .describe("Flow type; required when using flowName"),
        forceUnlock: z.boolean().default(false)
            .describe("Forcibly unlock a flow held by another user before editing — discards their unsaved Architect UI edits"),
        publish: z.boolean().default(false)
            .describe("Publish the flow after editing instead of just checking it in"),
    })
    .refine(
        (d) => Boolean(d.flowId) !== Boolean(d.flowName && d.flowType),
        { message: "Provide exactly one of flowId, or flowName together with flowType.", path: ["flowId"] },
    );
```

`destructiveHint: true` (still mutates a live org) with description text explicitly stating no delete/history loss, distinguishing it from `deploy_flow`.

## Differentiated Error Handling

Per `openspec/config.yaml`, do not collapse errors like `flow-dependencies.ts`. `update-flow.ts` maps `errorKind` (set by `index.ts`'s `classifyUpdateError()`) to distinct `isError` messages:

| `errorKind` | Message template |
|---|---|
| `locked-by-other-user` | "Flow is locked by another user. Retry with forceUnlock:true to override (discards their unsaved edits)." |
| `not-found` | "Flow not found for the given flowId/flowName+flowType." |
| `type-mismatch` | "flowType does not match the existing flow's type." (kept for API completeness — see below) |
| `unknown` (default) | Raw SDK error message, unmodified — never silently swallowed. |

**Empirically confirmed against a real Genesys Cloud org (tasks.md 1.6/2.6)**: `not-found` covers both `checkoutAndLoadFlowByFlowIdAsync`'s 404 (`"Could not find flow with specified ID. (architect.flow.not.found)"`) and `checkoutAndLoadFlowByFlowNameAsync`'s `"no matches"`. `type-mismatch` is **not reachable** — checkout by `flowId` doesn't enforce `flowType` at all, and checkout by `flowName` with the wrong `flowType` returns the identical `"no matches"` response as a genuinely nonexistent name, so the SDK gives no signal to distinguish the two. The `type-mismatch` kind and message stay defined for forward compatibility (in case a future SDK version changes this), but `classifyUpdateError()` never actively detects it — anything matching this description surfaces as `not-found`. `locked-by-other-user` remains unconfirmed (requires a second real user/OAuth identity, out of scope for solo verification).

When `unlocked:true` is present on a failure, append: "The flow lock was automatically released after this failure." When `unlocked:false` (second failure calling `unlockAsync`), append: "WARNING: automatic unlock also failed — the flow may remain locked; manual intervention required."

## Tool Registration (`src/mcp-server/index.ts`)

Add `import { updateFlow } from "./tools/update-flow.ts";`, instantiate with the same `{ region, clientId, clientSecret, deployScriptPath: envVars.DEPLOY_SCRIPT_PATH }` config as `deployFlow` (same bundle, differentiated by `--mode`), then `server.registerTool("update_flow", updateFlowTool.config, updateFlowTool.handler);` immediately after `deploy_flow`'s registration.

## `node:test` Design

`package.json`: `"test": "node --experimental-strip-types --test src/**/*.test.ts"`.

`src/deploy-runner/update-helpers.test.ts` — imports only `update-helpers.ts` (no interceptor side effects):

| Test | Input | Expected |
|---|---|---|
| resolves by ID | `{ flowId: "1" }` | `{ kind: "byId", flowId: "1" }` |
| resolves by name+type | `{ flowName: "n", flowType: "inboundcall" }` | `{ kind: "byName", ... }` |
| both given → ID wins | `{ flowId: "1", flowName: "n", flowType: "t" }` | `{ kind: "byId", flowId: "1" }` |
| name without type | `{ flowName: "n" }` | throws |
| type without name | `{ flowType: "t" }` | throws |
| neither given | `{}` | throws |
| unlock on mutate failure | fake `flow = { checkInAsync/publishAsync/unlockAsync: mocks resolving }`, `mutate` that rejects, `publish=false` | `checkInAsync`/`publishAsync` never called; `unlockAsync` called once; rejects with original error |
| unlock on checkIn failure | `mutate` resolves, fake `flow.checkInAsync` rejects, `publish=false` | `unlockAsync` called once; rejects with the checkIn error, not a mutate error |
| unlock on publish failure | `mutate` resolves, fake `flow.publishAsync` rejects, `publish=true` | `flow.publishAsync` called (not `checkInAsync`); `unlockAsync` called once; rejects with the publish error |
| double failure | `mutate` rejects and fake `flow.unlockAsync` also rejects | `applyUpdateAndSave` resolves `{unlocked:false}` (catches the unlock error) then rethrows the original mutate error |
| happy path — checkIn | `mutate` resolves, `flow.checkInAsync` resolves, `publish=false` | `flow.checkInAsync` called, `flow.publishAsync` and `unlockAsync` never called; resolves `{unlocked:false}` |
| happy path — publish | `mutate` resolves, `flow.publishAsync` resolves, `publish=true` | `flow.publishAsync` called, `flow.checkInAsync` and `unlockAsync` never called; resolves `{unlocked:false}` |

Fake SDK object is a plain literal (`{ unlockAsync: () => Promise.resolve() }`) — no `purecloud-flow-scripting-api-sdk-javascript` import needed, keeping tests fast and dependency-free.

## Migration / Rollout

No migration required — both slices are additive (proposal's rollback plan applies unchanged).

## Open Questions

- [ ] Exact SDK error text/status for locked/not-found/type-mismatch — empirical verification against a real dev org during `sdd-apply` (per proposal).
- [ ] `architect:flow:edit` permission scope — pattern-inferred, confirm empirically during `sdd-apply`.
