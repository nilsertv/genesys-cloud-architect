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
- [ ] 1.6 **Empirical (real org)** — export the same unmodified flow twice via existing `read_flow`; diff parsed structures; record any volatile/regenerated field names for Phase 2's `KNOWN_VOLATILE_FLOW_PATHS`. **BLOCKED in this apply session**: no live Genesys Cloud org credentials/MCP tool access available in this sandboxed environment (env file access denied by sandbox policy). Must be run by a session with real org access before Phase 2 finalizes `KNOWN_VOLATILE_FLOW_PATHS` — Phase 2 can still proceed with the array shipping empty per design.md's fallback.

## Phase 2: Structural Diff + Gate (PR 2, base = PR1 branch)

- [x] 2.1 RED — `diffFlowYaml` tests: added/removed/changed leaves, nested structures, array reorder tolerated via `name`/`id` keys, array reorder falls back to index without keys.
- [x] 2.2 GREEN — `update-helpers.ts`: `diffFlowYaml(baselineYaml, candidateYaml): FlowDiffResult`.
- [x] 2.3 RED — `evaluateFlowDiffGate` tests: clean diff allows, blocked on untouched-path delta, allowed on requested-path same value, blocked on requested-path different value, volatile path always allowed.
- [x] 2.4 GREEN — `update-helpers.ts`: `evaluateFlowDiffGate(requestedDiff, confirmDiff, volatilePaths?)` + exported `KNOWN_VOLATILE_FLOW_PATHS` (seed from 1.6 findings, else empty). Satisfies spec: Full-Baseline Diff Gate at Confirm Time.
- [ ] 2.5 **Empirical (real org)** — confirm Architect flow YAML arrays carry stable `name`/`id` keys; adjust `diffFlowYaml` keying if not confirmed. **BLOCKED**: same reason as 1.6 — no live Genesys Cloud org credentials/MCP tool access in this sandboxed apply session. `diffFlowYaml`'s `name`/`id`-then-index fallback (see design.md's "Diff format" decision) does not depend on this confirmation to function — it degrades safely to index-based comparison (strictly MORE conservative, not less) if arrays turn out not to carry stable keys, so this does not block Phase 3.

## Phase 3: Wiring — Two-Call Protocol (PR 3, base = PR2 branch)

- [ ] 3.1 `index.ts` — `updateFlow()`: capture baseline `{original}` right after checkout (own unlock-on-failure guard); mutate callback = edit + snapshot + write baseline `{original, requested}`; return `{requestedDiff, baselinePath}`. Never calls `publishAsync`. Satisfies spec: Two-Call Explicit-Flag Publish Confirmation (call 1).
- [ ] 3.2 `index.ts` — new `confirmAndPublishFlow()`: read baseline pre-checkout (fail fast if byId & missing), checkout, export live, `applyUpdateAndSave(flow, verify=diff+gate, publish=true)`, delete baseline only on publish success. New `UpdateErrorKind` values `no-baseline-found`/`unsolicited-changes-detected` set as `errorKind` on the thrown Error. Satisfies spec: call 2, Baseline Cleanup Tied to Publish Success Only.
- [ ] 3.3 `index.ts` — `classifyUpdateError()` prefers a pre-set `err.errorKind` before falling back to regex classification.
- [ ] 3.4 `index.ts` CLI — replace `--publish` with `--confirm-publish`; add `--exports-dir` (required in update mode); dispatch `updateFlow` vs `confirmAndPublishFlow` by `confirmPublish`.
- [ ] 3.5 `update-flow.ts` — zod schema: remove `publish`, add `confirmPublish` (default false); compute `--exports-dir` via `path.join(process.cwd(), "exports")`.
- [ ] 3.6 `update-flow.ts` — surface `requestedDiff` + `baselinePath` in call-1 response; surface blocked-reason/`unrequestedPaths` in call-2 block response. Satisfies spec: Baseline path returned to caller.
- [ ] 3.7 `.gitignore` — add `exports/`.
- [ ] 3.8 `skills/write-flow/SKILL.md` — rewrite step 4 of "Updating an Existing Flow" for the two-call `confirmPublish` protocol; remove the `publish:true` bot-flow example, replace with a `confirmPublish: true` call 2.
- [ ] 3.9 **Empirical (real org)** — full two-call flow: edit → call1 (baseline+diff shown) → simulate drift via Architect UI → call2 (hard block, baseline kept) → resolve drift → call2 clean (publish, baseline deleted). Satisfies spec: all Two-Call and Diff Gate scenarios end-to-end.
- [ ] 3.10 **Empirical** — confirm the MCP server's `process.cwd()` equals the project root under Claude Code's plugin launch model; adjust `--exports-dir` computation if not reliable.
