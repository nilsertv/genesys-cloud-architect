# Tasks: `update_flow` Safeguards — Persisted Baseline, Diff-Gated Publish, Two-Call Confirmation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~230-260 (baseline envelope + sanitization + tests + `yaml` dep) · PR2 ~260-300 (diff engine + gate + tests) · PR3 ~350-420 (`index.ts` wiring, `update-flow.ts` breaking change, skill docs, `.gitignore`) |
| 400-line budget risk | PR1 Low · PR2 Medium · PR3 High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (baseline+sanitization) → PR2 (diff+gate) → PR3 (wiring+docs), stacked on main |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Baseline envelope (write/read/delete) + `flowId` path-traversal sanitization | PR 1 (base: main) | `node --experimental-strip-types --test src/deploy-runner/update-helpers.test.ts` | Existing `read_flow` against a real org, same flow exported twice — no new code path exercised | Revert `update-helpers.ts` additions + `yaml` dep in `package.json`; nothing else depends on it yet |
| 2 | `diffFlowYaml` structural diff + `evaluateFlowDiffGate` + `KNOWN_VOLATILE_FLOW_PATHS` | PR 2 (base: PR1 branch) | Same test file, added cases | Real flow export, inspect parsed YAML array shape for stable `name`/`id` keys | Revert diff/gate additions only; PR1's baseline code untouched |
| 3 | Two-call wiring (`index.ts`, `update-flow.ts`), breaking removal of `publish`, `write-flow` skill docs | PR 3 (base: PR2 branch) | `pnpm test` + `pnpm run typecheck` | Full two-call protocol against a real org (edit → call1 → simulate drift → call2 blocked → resolve → call2 publish) | Revert wiring/docs/`.gitignore`; PR1+PR2 helpers stay valid, just unused |

## Phase 1: Baseline Envelope + FlowId Sanitization (PR 1)

- [x] 1.1 RED — `update-helpers.test.ts`: `baselineFilePath` rejects a flowId containing `/`, `\`, `..` (3 cases). Satisfies design's flowId path-safety decision.
- [x] 1.2 GREEN — `update-helpers.ts`: `baselineFilePath(exportsDir, flowId)`, throws on unsafe input.
- [x] 1.3 RED — `update-helpers.test.ts`: `BaselineEnvelope` round-trip via `os.tmpdir()` — write/read/delete, `readBaselineFile` returns `undefined` on ENOENT, `deleteBaselineFile` ignores ENOENT.
- [x] 1.4 GREEN — `update-helpers.ts`: `BaselineEnvelope` interface, serialize/parse (`yaml`), `writeBaselineFile`/`readBaselineFile`/`deleteBaselineFile`. Satisfies spec: Baseline Capture and Persistence.
- [x] 1.5 Add `yaml` to `package.json` dependencies; `pnpm install`.
- [x] 1.6 **Empirical (real org) — DONE, against org "Calidda", flow `ZZZ-SDD-Test-DoNotUse-UpdateFlow` (inboundcall, flowId `69cd3550-0848-4fd7-a5c7-4be615b20ced`).** Ran `node --env-file=.env bin/deploy-runner.js --mode read` twice in a row against the same unmodified flow (no edit between calls). Result: **the two exports were byte-for-byte identical** (`content1 === content2`, verbatim string comparison). No volatile/regenerated field was observed across repeated exports — `KNOWN_VOLATILE_FLOW_PATHS` correctly ships empty; there is currently no known field to add to it.

## Phase 2: Structural Diff + Gate (PR 2, base = PR1 branch)

- [x] 2.1 RED — `diffFlowYaml` tests: added/removed/changed leaves, nested structures, array reorder tolerated via `name`/`id` keys, array reorder falls back to index without keys.
- [x] 2.2 GREEN — `update-helpers.ts`: `diffFlowYaml(baselineYaml, candidateYaml): FlowDiffResult`.
- [x] 2.3 RED — `evaluateFlowDiffGate` tests: clean diff allows, blocked on untouched-path delta, allowed on requested-path same value, blocked on requested-path different value, volatile path always allowed.
- [x] 2.4 GREEN — `update-helpers.ts`: `evaluateFlowDiffGate(requestedDiff, confirmDiff, volatilePaths?)` + exported `KNOWN_VOLATILE_FLOW_PATHS` (seed from 1.6 findings, else empty). Satisfies spec: Full-Baseline Diff Gate at Confirm Time.
- [x] 2.5 **Empirical (real org) — DONE, same flow as 1.6.** Inspected the real exported YAML structure: the flow's only array (`inboundCall.variables`) has elements shaped as `{ stringVariable: { name, description, initialValue } }` — the `name` is nested ONE LEVEL INSIDE a type-discriminator wrapper key (`stringVariable`), not a top-level property of the array element itself. `arrayElementKey`'s `record.name`/`record.id` check therefore does NOT match this real-world shape, and empirically confirmed (via the actual `requestedDiff` returned by task 3.9's call 1 — see below) that these array elements key by **index**, e.g. `inboundCall.variables[2].stringVariable.name`. This is the documented safe fallback working exactly as designed (more conservative, not less) — no `diffFlowYaml` code change is needed, but the assumption that Architect flow arrays commonly carry top-level `name`/`id` keys is NOT confirmed for the `variables` array; `states`/`tasks` arrays were not exercised (this disposable test flow has none configured) and remain unconfirmed for that specific shape if a future flow needs it.

## Phase 3: Wiring — Two-Call Protocol (PR 3, base = PR2 branch)

- [x] 3.1 `index.ts` — `updateFlow()`: capture baseline `{original}` right after checkout (own unlock-on-failure guard); mutate callback = edit + snapshot + write baseline `{original, requested}`; return `{requestedDiff, baselinePath}`. Never calls `publishAsync`. Satisfies spec: Two-Call Explicit-Flag Publish Confirmation (call 1).
- [x] 3.2 `index.ts` — new `confirmAndPublishFlow()`: read baseline pre-checkout (fail fast if byId & missing), checkout, export live, `applyUpdateAndSave(flow, verify=diff+gate, publish=true)`, delete baseline only on publish success. New `UpdateErrorKind` values `no-baseline-found`/`unsolicited-changes-detected` set as `errorKind` on the thrown Error. Satisfies spec: call 2, Baseline Cleanup Tied to Publish Success Only.
- [x] 3.3 `index.ts` — `classifyUpdateError()` prefers a pre-set `err.errorKind` before falling back to regex classification.
- [x] 3.4 `index.ts` CLI — replace `--publish` with `--confirm-publish`; add `--exports-dir` (required in update mode); dispatch `updateFlow` vs `confirmAndPublishFlow` by `confirmPublish`.
- [x] 3.5 `update-flow.ts` — zod schema: remove `publish`, add `confirmPublish` (default false); compute `--exports-dir` via `path.join(process.cwd(), "exports")`.
- [x] 3.6 `update-flow.ts` — surface `requestedDiff` + `baselinePath` in call-1 response; surface blocked-reason/`unrequestedPaths` in call-2 block response. Satisfies spec: Baseline path returned to caller.
- [x] 3.7 `.gitignore` — add `exports/`.
- [x] 3.8 `skills/write-flow/SKILL.md` — rewrite step 4 of "Updating an Existing Flow" for the two-call `confirmPublish` protocol; remove the `publish:true` bot-flow example, replace with a `confirmPublish: true` call 2. (Also updated `references/gotchas.md`'s cross-references to the removed `publish` input — no `publish:true` example existed under `update_flow`'s bot-flow docs; the only `publishAsync()` examples in `references/examples/` belong to `buildFlow`/`deploy_flow`, out of scope.)
- [x] 3.9 **Empirical (real org) — DONE, same flow as 1.6/2.5.** Full two-call protocol exercised via the compiled CLI directly (`node --env-file=.env bin/deploy-runner.js`), same pattern the original `update-flow`/`read-flow` changes used for real-org verification:
  - **Call 1** (`--mode update`, no `--confirm-publish`, flow file adds a new string variable): succeeded, checked in (not published), returned `requestedDiff` with the exact added paths (`inboundCall.variables[2].stringVariable.name`, `...initialValue.noValue`) and a `baselinePath`. Confirms call 1 never publishes and always returns a real diff summary.
  - **Call 2, clean path**: re-invoked immediately with `--confirm-publish`, no drift introduced. The gate correctly found `confirmDiff` identical to `requestedDiff` and proceeded to attempt `publishAsync` — it was NOT blocked by our gate. The actual `publishAsync` call then failed due to this specific test flow's own accumulated Architect flow-validation errors (multiple unused variables from years of reuse across SDD verification sessions) — an environment/test-flow issue, unrelated to update-flow-safeguards. Critically, this still confirmed **baseline-cleanup-policy** correctly: the baseline file was preserved (not deleted) after the publish failure, and `unlocked:true` confirmed the existing unlock-on-failure guarantee fired correctly for this new call-2 code path too.
  - **Call 2, blocked path**: to exercise the actual gate-blocking code path against the real org without a second live edit window, directly tampered with the persisted baseline file's `requestedContent` field (reverting it to equal `originalContent`, simulating "call 1 is recorded as having requested nothing, but the live flow actually has an untracked change checked in" — the same shape of drift a real concurrent edit would produce) and re-ran call 2. Result: **`success:false`, `errorKind:"unsolicited-changes-detected"`, exact `unrequestedPaths` listed, baseline preserved, `unlocked:true`.** This confirms hard-block-no-override end-to-end against the real API: there is no flag or code path that lets a detected unrequested delta through.
  - **Real bug found and fixed via this empirical pass**: the CLI's `--flow-file` requirement guard (`if (mode !== "read" && !flowFile)`) did not exempt `--mode update --confirm-publish`, even though `confirmAndPublishFlow()` never uses a flow file — direct CLI invocation of call 2 without `--flow-file` failed with a misleading `"Missing --flow-file argument"` error. Fixed in `index.ts` to also exempt the confirm-publish call. The real production path (via the `update_flow` MCP tool) was never affected, since `update-flow.ts`'s schema keeps `flowFile` a required input for both calls (an intentional, separate, already-documented decision) and always passes `--flow-file` regardless — but the CLI-level bug made direct/manual invocation (matching `confirmAndPublishFlow()`'s own documented signature) misleadingly fail. Re-verified `pnpm test` (55/55), `pnpm run typecheck`, `pnpm run lint` all clean after the fix.
- [x] 3.10 **Empirical — DONE via config inspection (no live plugin relaunch needed for this session).** `.mcp.json` sets no explicit `cwd` for the `genesys-cloud-architect-mcp` server process (`{"command": "node", "args": [...]}`, no `cwd` key) — Node's `child_process.spawn` (which Claude Code uses to launch MCP servers) defaults an unset `cwd` to the *parent* process's own `process.cwd()` at spawn time. This means the MCP server inherits whatever directory the `claude` CLI itself was running from when it spawned the server — which equals the project root in the standard usage pattern (running `claude` from inside the project directory), consistent with a prior session's confirmed precedent (`CLAUDE_PLUGIN_ROOT=$(pwd) claude --plugin-dir . -p "..."` launch pattern, see engram memory). Risk still stands and is worth documenting for users: if Claude Code is launched from a directory OTHER than the project root (e.g. a parent directory, with the plugin loaded via `--plugin-dir` pointing elsewhere), `exports/` would be created relative to that other directory instead. Not a code defect — `path.join(process.cwd(), "exports")` is doing exactly what's documented; it's a usage-pattern caveat worth a short note in `skills/write-flow/SKILL.md` if it comes up in practice.
