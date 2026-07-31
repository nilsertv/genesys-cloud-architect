# Exploration: update-flow-safeguards — hardening `update_flow` with export-before-edit, persisted baseline, publish-confirmation, and diff-gated publish

## Current State (confirmed against code, not re-audited from scratch)

1. **Export before edit** — `read_flow` exists (`src/mcp-server/tools/read-flow.ts`, using `exportFlowContent()` in `src/deploy-runner/update-helpers.ts:142-158`, wrapping `ArchBaseFlow#exportToObjectAsync` requesting `archEnums.FLOW_FORMAT_TYPES.yaml`). `skills/write-flow/SKILL.md` (~180-202) instructs calling it before authoring `updateFlow` edits, but `update_flow`'s own code path (`src/deploy-runner/index.ts`'s `updateFlow()`) never calls it — checkout goes straight from `resolveFlowIdentifier` to `checkoutAndLoadFlowBy{FlowId,FlowName}Async`.
2. **Persist baseline for later comparison** — Not implemented. `readFlow()` (`index.ts:468-536`) returns the YAML as the tool's text response only; nothing is written to disk anywhere in the repo. No baseline-file convention exists (closest analog: `test-bot-flow.ts`'s unbounded in-memory session map, already flagged in `docs/assessment.md` as a gap, not a pattern to reuse).
3. **Edit based on that reference** — Only skill-level instruction today; no code enforces the baseline was actually read before an edit is applied.
4. **Confirm same-name vs. new-version/new-flow before publish** — Not implemented. `resolveFlowIdentifier()` (`update-helpers.ts:22-40`) only resolves *which* flow to check out; `publish: boolean` only toggles `checkInAsync()` vs `publishAsync()` inside `applyUpdateAndSave()` (`update-helpers.ts:69-97`).
5. **Diff-gated publish** — Not implemented. `applyUpdateAndSave()` goes `mutate → checkInAsync()/publishAsync()` directly; no post-edit re-export, no comparison against a pre-edit baseline. This is the most critical gap.

## Affected Areas

- `src/deploy-runner/update-helpers.ts` — home of existing pure helpers; natural home for new pure baseline-capture/diff helpers, following the same "zero top-level side effects, node:test-able" pattern.
- `src/deploy-runner/index.ts` — `updateFlow()`/`readFlow()`/`main()`. Any enforcement must live inside/around the existing `applyUpdateAndSave()` try/catch that guarantees `unlockAsync()` on failure.
- `src/mcp-server/tools/update-flow.ts` — zod schema/tool surface (flat shape + manual post-parse validation, per the documented MCP SDK `.refine()`/`ZodEffects` bug already fixed once here). Any new flag or NDJSON payload field (diff summary, baseline content) lands here.
- `src/mcp-server/tools/read-flow.ts` — potential reuse point if baseline persistence hooks through `read_flow` rather than duplicating logic in `update_flow`.
- `src/mcp-server/tools/types.ts` — `ToolFactory`/`ToolConfig`'s `handler: (args) => Promise<...>` has NO second `extra`/context parameter. If MCP elicitation is used for the confirm step, this shared type needs widening — blast radius across all 4 registered tools, not just `update_flow`.
- `skills/write-flow/SKILL.md` — currently the *only* enforcement layer for requirements #1/#3; needs rewriting once code enforces them.
- `node_modules/purecloud-flow-scripting-api-sdk-javascript/types.d.ts` — confirms the real available SDK primitives (below).
- `node_modules/@modelcontextprotocol/sdk` (`^1.12.0` installed) — confirms `Server#elicitInput(params): Promise<ElicitResult>` exists server-side (`dist/esm/server/index.d.ts:158`).

## Where the Baseline Could Live

- **In-process only** (captured at the start of the same `updateFlow()` runner invocation, diffed after mutate, before checkIn/publish): no disk state/cleanup/TTL, consistent with this codebase's stateless-per-call model (each `update_flow` call spawns a fresh child process; no existing multi-call session concept for flows). Satisfies req #5's intent fully; only partially satisfies #2's literal "persisted" wording.
- **Persisted to disk**: requires deciding location, write timing, cleanup policy (delete on success / keep on failure / TTL), and stale-baseline collision handling. None of this machinery exists anywhere in the repo today.

## Diff Mechanism — Options and the Empirical Unknown

- All exports use `archEnums.FLOW_FORMAT_TYPES.yaml` (structured, human-readable — not the semi-opaque `architect` backup format).
- **Unconfirmed empirically**: whether two exports of the identical, unmodified flow are byte-identical. Nothing in this repo confirms or denies it. If the export embeds anything Genesys regenerates per-export (version stamp, timestamp, regenerated internal IDs), a naive text diff would false-positive on a genuinely no-op edit. Same posture as prior changes' "Open Questions" (e.g. `MAX_YAML_CHARS`'s "provisional, unvalidated" note) — must verify empirically against a real org (export the same flow twice, diff raw bytes) before committing to a strategy.
- Options once confirmed:
  1. **Raw text/line diff** — simplest, safe only if export is confirmed byte-deterministic for no-op edits.
  2. **Parsed-YAML structural diff** — diff as objects (by node/task/action key), tolerant of reordering; still needs a volatile-field allowlist if any exists.
  3. **SDK-level structural diff** — reload both baseline and post-edit content as live `ArchBaseFlow` objects and walk the SDK's own object graph. Most robust to cosmetic differences, heaviest to implement.

## Confirm Same-Name vs. New Version/Flow — Real SDK Options

- The SDK has **no "fork with history" operation**. `checkInAsync()`/`publishAsync()` always operate on the *same* checked-out flow; every checkIn/publish auto-creates a new numbered `flowVersion` under the *same* `flowId` — versioning is automatic, not a caller choice (confirmed by `loadFlowByFlowIdAsync`/`loadFlowByFlowNameAsync`'s `flowVersion` param accepting a commit-version number, `"latest"`, `"debug"`, `"published"`).
- The only way to avoid touching the existing flow is to create a **genuinely new flow object** via the type-specific `createFlow<Type>Async(flowName, ...)` factory (same one `deploy_flow`/`buildFlow` already use for create), then populate it via `ArchBaseFlow#importFromContentAsync(exportContent)` / `#importFromFileAsync(exportFilePath)` (`types.d.ts:13081-13101`) — confirmed to exist specifically for importing previously-exported content into a (new) flow instance.
- So requirement #4's real underlying choice is between two SDK code paths:
  - (a) **Edit in place** — today's path: same `flowId`/name, automatic new version on checkIn/publish.
  - (b) **Fork** — `createFlow<Type>Async(newName)` + `importFromContentAsync(baselineYaml)` + re-apply the same edit mutation to the new object + checkIn/publish.
- **Ordering tension (unresolved here)**: asking "in place or fork?" makes sense either (i) up front — a fork needs a fresh flow object *before* any mutation — or (ii) right before checkIn/publish, after the diff-gate has shown what changed, which is more informative but means a "fork" answer requires re-running the mutation against a different object rather than reusing the already-mutated one. `sdd-propose`/`sdd-design` need to pick one.

## What Happens When the Diff Detects Unsolicited Changes — Postures (undecided)

1. **Hard-block, no override** — safest, but needs some machine-readable way to express "declared intent," which nothing in this codebase does today.
2. **Block with explicit override flag** — mirrors the existing `forceUnlock` precedent (a second "override a safety check explicitly" flag would be consistent with that convention).
3. **Warn and proceed** — reuses the existing `warnings`/NDJSON payload shape, but doesn't actually satisfy req #5's stated intent since nothing is blocked.

## Approaches

1. **In-process baseline + in-memory diff, hard-block-by-default with an explicit override flag**
   - Pros: no new disk state; reuses `exportFlowContent`/`applyUpdateAndSave`'s shape; fully unit-testable with fake SDK objects like `update-helpers.test.ts`; no MCP protocol changes.
   - Cons: doesn't literally satisfy req #2's "persisted" wording; req #4's confirmation is still just a caller-set flag, not an interactive prompt.
   - Effort: Medium.

2. **Persisted baseline file + structural diff + MCP elicitation for publish-time confirmation**
   - Pros: literally satisfies req #2; gives req #4 a real interactive confirmation via `Server#elicitInput()`.
   - Cons: introduces genuinely new state (no precedent in this repo); requires widening `types.ts`'s `ToolFactory`/`ToolConfig` signature across all 4 tools; **client-side elicitation support is unconfirmed** — server-side `elicitInput` existing doesn't guarantee Claude Code's client honors `ElicitRequest`.
   - Effort: High.

3. **Hybrid — in-process (non-persisted) baseline + hard diff-gate + two-call/explicit-flag confirmation protocol, no MCP elicitation**
   - Pros: fully satisfies req #5 in code (real block, not a warning); satisfies req #4 via a documented two-step protocol (call once without `publish`, show the diff, re-invoke with an explicit confirm flag) — mirrors this project's existing "skill instruction + code guardrail" pattern; smallest code/type blast radius.
   - Cons: confirm step still relies on the calling agent behaving correctly, same class of gap as today, one level down; no literal persisted file for req #2.
   - Effort: Medium.

**Recommendation**: Approach 3 as the pragmatic default for `sdd-propose` to scope — smallest change that closes the most critical gap (req #5) in code, with Approach 2's elicitation flagged as a possible follow-up once client-side support is verified. This is a recommendation for the user to confirm, not a decision made here.

## Risks

- Empirical unknown: YAML export byte-stability across repeated exports of an unmodified flow (false-positive risk for any diff strategy).
- Lock/unlock interplay: new baseline-capture and re-export+diff steps both happen while the flow lock is held — must be added *inside* `applyUpdateAndSave`'s existing unlock guarantee, not around it.
- Requirement #4 ambiguity ("same name or new version") conflates automatic same-flow versioning (not a real choice) with forking to a new flow (a real SDK-level choice) — must be disambiguated with the user before scoping.
- MCP elicitation client support is unconfirmed — do not scope a design around it without first verifying Claude Code's client honors `ElicitRequest`.
- `openspec/config.yaml` staleness: still declares `strict_tdd: false`/no test command despite `update-flow`'s archived `state.yaml` showing `node:test` was added and used (already an open verify-report SUGGESTION). New diff/baseline helpers should still follow `update-helpers.test.ts`'s precedent regardless.

## Open Questions for the User (before sdd-propose)

1. Does requirement #4 mean "ask whether to fork to a brand-new flow" or "ask checkIn vs. publish" (already the `publish` flag)?
2. Should the baseline be in-process only, or literally persisted to disk? If persisted: where, and what cleanup/staleness policy?
3. When the diff detects unsolicited changes: hard-block (no override), block with explicit override flag, or warn-and-proceed?
4. Should publish-time confirmation rely on MCP elicitation (needs client-support verification) or a documented two-call/explicit-flag protocol?

## Ready for Proposal

Yes — with the 4 open questions above flagged explicitly for the user to resolve during `sdd-propose`.
