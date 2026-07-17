# Exploration: `updateFlow` capability

**Change:** `update-flow`
**Date:** 2026-07-14
**Status:** Ready for proposal (3 open decisions to confirm — see bottom)

## Current state

The plugin's `write-flow` skill and `sdk-patterns.md` teach exclusively
`archFactoryFlows.createFlow<Type>Async(name, description)` — a create-only,
one-shot workflow.

`skills/write-flow/references/gotchas.md` (lines ~101-103) already
half-documents the real fix in a footnote:

> *"createFlow*Async deletes an existing flow with the same name... use
> checkoutAndLoadFlowByFlowNameAsync to update existing flows"*

Nobody implemented it — it's a footnote, not a workflow.

`src/deploy-runner/index.ts`'s `buildFlow(scripting)` is the only entry
point (dynamic `import()` of the user's flow file). `FLOW_CREATED_RE =
/successfully created flow name '(.+?)' \(id: '(.+?)'\)/` (line ~172-173)
is the **only** mechanism that captures `flowId`/`flowName`, tied to a log
string emitted internally only by the create path.

`src/mcp-server/tools/deploy-flow.ts`'s `deploy_flow` tool takes only
`{ flowFile }`, `destructiveHint: true`, spawns the deploy-runner and
parses NDJSON `{type:"log"|"result"}` lines.

`flow-dependencies.ts` (unrelated REST `ArchitectApi` tool) already takes
`flowId` directly as input — precedent that `flowId` is the identity
Genesys tools converge on.

`openspec/config.yaml` confirms `strict_tdd: false`, zero tests, CI =
lint+build+boot-smoke only, and explicitly flags "adding a test runner" as
high-value and "don't collapse errors like flow-dependencies.ts does" as a
standing rule.

## SDK verification (read directly from `node_modules`, not assumed)

Source: `node_modules/.pnpm/purecloud-flow-scripting-api-sdk-javascript@0.66.1/node_modules/purecloud-flow-scripting-api-sdk-javascript/types.d.ts`

- `archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync<T>(flowName, flowType, forceUnlock?, flowVersion?)`
  (and the `ByFlowIdAsync`/`ByFlowInfoAsync` siblings) does **checkout +
  load in one call**, returning a fully editable `ArchBaseFlow` — the same
  object shape `createFlow*Async` returns.
- `ArchBaseFlow.id` (readonly) and `ArchBaseFlow.name` (mutable) are
  directly on the returned object. **Update does not need a new log
  regex** — `flowId`/`flowName` come straight off the object, before
  `checkInAsync`/`publishAsync`. This is more robust than create's
  regex-on-log-line approach (which exists only because a brand-new flow
  has no server ID until the internal create call logs it).
- Grepped the SDK bundle for real log strings:
  `"checkInAsync - checking in..."`, `"checkInAsync - checked in."`,
  `"is locked by another user."`, `"is locked by user %(user)s."`. None
  collide with `FLOW_CREATED_RE`; none carry name+id either — confirms
  the object-based capture above is the correct design.
- `ArchFlowInfo` exposes `isLocked`, `isLockedByAnotherUser`,
  `isLockedByCurrentUser` for precise error messages.

## External verification (WebSearch/WebFetch, per genesys-cloud-consultant protocol)

- Forum thread [`edit-an-existing-flow-using-flow-scripting-sdk/9738`](https://developer.genesys.cloud/forum/t/edit-an-existing-flow-using-flow-scripting-sdk/9738)
  confirms this exact reported problem and the
  `checkoutAndLoadFlowByFlowNameAsync` fix.
- `help.genesys.cloud/articles/architect-permissions-overview/` lists
  distinct role permissions: Architect > Flow > Add / Delete / **Edit**
  ("lock, check in, save, save as, export, discard unsaved changes") /
  Publish / **Unlock** ("unlock a flow that another user currently
  locks") / View / Search / Launch.
- By pattern-consistency with the already-confirmed `architect:flow:delete`
  (sdk-patterns.md) and `architect:flow:unlock` (literal SDK JSDoc text),
  the update path likely needs `architect:flow:edit` — **this exact
  string was not found verbatim in official docs.** Flagged as
  pattern-inferred, not confirmed. Recommend empirical verification
  during `sdd-apply` against a real dev org.

## Affected areas

- `src/deploy-runner/index.ts` — new `updateFlow(scripting, opts)` export
  using `checkoutAndLoadFlowByFlowNameAsync`/`ByFlowIdAsync`;
  `FLOW_CREATED_RE` stays untouched.
- `src/mcp-server/tools/deploy-flow.ts` (or new `update-flow.ts`) — new
  schema/annotations/spawn logic.
- `src/mcp-server/index.ts` — tool registration if a new tool is added.
- `skills/write-flow/SKILL.md`, `references/sdk-patterns.md`,
  `references/gotchas.md` — new update-flow workflow, contract, and
  promoted gotcha.
- `openspec/config.yaml` / `package.json` — only if a `node:test` script
  is added.

## Q1 — Tool surface

1. **New dedicated `update_flow` tool.** Pros: honest annotations, clean
   zod schema, matches `flow_dependencies`' `flowId`-as-input precedent,
   zero regression risk to the working `deploy_flow`/create path. Cons:
   duplicates spawn/NDJSON boilerplate (deferrable). Effort: Medium.
2. **`mode: "create"|"update"` param inside `deploy_flow`.** Cons: MCP
   annotations are static per-tool (can't express "this call is
   non-destructive"), schema needs `.refine()` gymnastics, and
   *autodetect-by-name-without-explicit-mode* is actively dangerous — it
   silently flips create-safe into delete-and-recreate based on server
   state the LLM caller can't reliably know. Effort: Medium-High.
3. **Phased**: ship new tool now, consider extraction/merging later.
   Effort: Low-Medium.

**Recommendation: Approach 1, phased per Approach 3.** Update is provably
less destructive than create (no delete, preserves flowId/history) but
that nuance can't be expressed per-call inside a shared tool — keep
`deploy_flow` untouched and ship `update_flow` separately, both
`destructiveHint: true` but with description text distinguishing them.

## Q2 — deploy-runner changes

Export `updateFlow(scripting, { flowId?, flowName?, flowType, forceUnlock? })`,
mirroring the `buildFlow` contract shape (user file exports `updateFlow`,
deploy-runner dynamically calls it based on `--mode`). Call
`checkoutAndLoadFlowByFlowNameAsync`/`ByFlowIdAsync` (combined call, fewer
failure points), capture `flow.id`/`flow.name` immediately after
resolution.

**Most important correctness risk:** if checkout succeeds but
`checkInAsync`/`publishAsync` fails afterward, the flow is left locked —
the catch path MUST call `flow.unlockAsync()` before rethrowing, unlike
the create path where nothing is locked before a failure.

## Q3 — MCP tool changes

zod schema:

```typescript
{
  flowFile: z.string().min(1),
  flowId: z.string().optional(),
  flowName: z.string().optional(),
  flowType: z.string().optional(),
  forceUnlock: z.boolean().default(false),
}
```

with `.refine()` requiring exactly one of `flowId` or (`flowName` +
`flowType`) — per `openspec/config.yaml`'s own design rule preferring
`.refine()` over post-parse `if`.

Keep `destructiveHint: true` (still mutates/potentially republishes live
production behavior) but describe explicitly that it does not delete or
reset history. Do not collapse distinct errors (locked / not found / type
mismatch) into one generic message — `config.yaml` explicitly calls out
`flow-dependencies.ts` for that anti-pattern.

## Q4 — write-flow skill changes

- New branch question in `SKILL.md` step 1 ("edit existing vs. create
  new").
- New "Updating an Existing Flow" section in `references/sdk-patterns.md`.
- Promote the `gotchas.md` footnote to the primary recommendation.

## Q5 — Risks / edge cases

- Flow locked by another user (needs `forceUnlock` +
  `architect:flow:unlock`).
- Flow not found.
- Flow type mismatch (SDK behavior here unconfirmed — verify against a
  real dev org during apply).
- Checkout-succeeds-then-checkin-fails leaving an orphaned lock (see Q2).
- `forceUnlock` discarding another human's unsaved Architect UI edits —
  genuinely destructive in a different way than "flow deletion," should
  be called out in the tool description.
- Permission scope `architect:flow:edit` pattern-inferred, not literally
  confirmed — flag for empirical verification.

## Q6 — Does TDD apply?

Given `strict_tdd: false` today (no test runner, no `test` script, zero
tests):

1. **Full vitest install as a prerequisite change** — matches
   `config.yaml`'s guidance but mocking the SDK (CJS, monkey-patched
   `https`, spawned child process) is nontrivial and unrelated to the
   actual ask. Effort: Medium.
2. **Ship now under Standard Mode, zero tests** — fastest, but the
   riskiest new logic (locked-flow races, unlock-on-failure) ships
   unverified. Effort: Low, real debt.
3. **Extract the update decision logic into a pure, injectable function
   and add `node:test` tests for just that, inside this change, without
   a full runner migration.** Effort: Medium.

**Recommendation: Approach 3, narrowly scoped.** Add
`"test": "node --test"` and tests for the new logic only (e.g. "which
identifier resolution path fires given flowId/flowName/flowType inputs",
"does the catch path call unlockAsync when checkout succeeded but
checkIn failed" using a fake SDK object). Explicitly do NOT flip
`strict_tdd: true` for the whole project in this change — that requires
CI wiring + re-running `sdd-init` + broader coverage, a legitimately
separate change.

## Q7 — PR slicing (delivery_strategy: ask-on-risk, ~400-line budget)

Two slices inside one `update-flow` change (no separate test-runner
change, since Q6 recommends narrow `node:test` extraction, not a
migration):

- **Slice A** — deploy-runner core (`updateFlow` export + extracted pure
  decision function + `node:test` tests + `"test"` script).
- **Slice B** — MCP tool (`update-flow.ts` + registration) + skill/
  reference doc updates. Depends on Slice A's exported signature.

Both comfortably under 400 lines given `deploy-flow.ts`/
`flow-dependencies.ts` are 125-200 lines each and this reuses their shape.

## Open decisions to confirm before/at `sdd-propose`

1. New `update_flow` tool vs. `mode` param on `deploy_flow` —
   **recommend new tool**.
2. Narrow `node:test` extraction vs. full vitest vs. no tests —
   **recommend narrow extraction**.
3. Two-slice PR plan (Slice A: deploy-runner core + tests, Slice B: MCP
   tool + skill docs) — **recommend as scoped above**.
