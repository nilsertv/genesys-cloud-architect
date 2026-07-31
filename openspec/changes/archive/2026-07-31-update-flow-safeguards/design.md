# Design: `update_flow` Safeguards — Persisted Baseline, Diff-Gated Publish, Two-Call Confirmation

## Technical Approach

New pure helpers in `update-helpers.ts` — `diffFlowYaml`/`evaluateFlowDiffGate` (structural diff + gate) and a baseline-envelope module (`baselineFilePath`/write/read/delete/serialize/parse) — wired into `index.ts`'s existing `applyUpdateAndSave` lock guarantee. Call 1 (`confirmPublish` false, default) captures a baseline right after checkout, runs the user's edit, captures a **requested snapshot** right after the edit (before checkIn), persists both to `exports/<flowId>.baseline.yaml`, checks in, and returns the requested-delta as a diff summary. Call 2 (`confirmPublish: true`) re-checks out, re-exports, and reuses `applyUpdateAndSave` with a **verify** callback in place of a mutate callback: it diffs live-vs-baseline, runs the gate, and only when clean does `applyUpdateAndSave` proceed to `publishAsync`. The baseline file is deleted only after that publish succeeds.

## Resolved: expressing "requested" (previously deferred)

No human-declared-intent field is added. The edit script's own effect is the source of truth. Call 1 computes `requestedDiff = diff(baseline, postEditSnapshot)`. Call 2 computes `confirmDiff = diff(baseline, liveAtConfirm)`. A confirm-diff path blocks publish unless it is in `KNOWN_VOLATILE_FLOW_PATHS` (ships empty) AND either absent from `requestedDiff`, or present there with the same value the edit produced. A path the edit touched but that now holds a *different* value than the edit produced still blocks — this also catches a same-path re-edit by anyone (including the original caller) between calls, folded into the same hard-block-no-override posture already confirmed.

## Architecture Decisions

| Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|
| Diff format | Parsed-YAML structural diff: flatten to path→leaf-value map, array elements keyed by `name`/`id` when present else index | (a) raw line diff (b) reload as SDK `ArchBaseFlow` objects | Raw text false-positives on key reordering; SDK reload needs a second checkout/lock for no extra fidelity the YAML export doesn't already carry |
| "Requested" source of truth | Self-scoping: `diff(baseline, postEditSnapshot)`, computed by the runner | Explicit script-declared manifest of touched paths | A manifest changes the fixed `updateFlow(scripting, flow)` contract and is as unreliable as any self-reported intent; self-scoping adds no caller-facing surface |
| Volatile-field allowlist | Exported `KNOWN_VOLATILE_FLOW_PATHS: string[]` in `update-helpers.ts`, ships empty | Hardcode guessed field names now | Regenerated-field names are unconfirmed (proposal's empirical risk); a data array means future Genesys export changes are a one-line addition + regression test, not an algorithm change |
| Call 2 implementation | Reuse `applyUpdateAndSave(flow, verify, true)`; `verify` throws on missing baseline or blocked diff instead of mutating | New dedicated try/catch/unlock path | Reuses the already-tested unlock guarantee verbatim; zero duplicated lock-safety code |
| `publish` input | Removed, replaced entirely by `confirmPublish` | Keep both flags | Two publish paths would let callers bypass the gate — breaking change, see Migration |
| Exports directory | MCP tool computes `path.join(process.cwd(), "exports")`, passes `--exports-dir` to the CLI | deploy-runner infers it from the flow file's directory (today's spawn `cwd`) | Flow files can live in a subdirectory; inferring from `cwd` would misplace `exports/` away from the real project root |
| flowId path safety | `baselineFilePath` rejects a flowId containing `/`, `\`, or `..` | Trust flowId as-is | flowId is caller-supplied input feeding a file path; nothing upstream validates its shape |
| Baseline write timing | Two writes: (1) original-only right after checkout, own unlock-on-failure guard (2) original+requested inside the mutate callback, before checkIn | Single write after checkIn succeeds | A crash between checkIn and one post-hoc write would leave no requested snapshot for call 2; the checkout-time write needs its own guard since it runs before `applyUpdateAndSave`'s try begins |
| Baseline collision | Call 1 always overwrites any existing baseline for that flowId | Fail if a baseline already exists | Per proposal: the exclusive checkout lock guarantees any prior file is abandoned/stale |

## Data Flow

```
call 1 (confirmPublish=false)
  checkout → write baseline{original} [own unlock guard]
  → applyUpdateAndSave(flow, mutate=edit+snapshot+write baseline{original,requested}, publish=false)
  → checkIn → emit {requestedDiff, baselinePath}

call 2 (confirmPublish=true)
  [byId: read baseline pre-checkout, fail fast if missing]
  checkout → export live
  → applyUpdateAndSave(flow, verify=diff+gate (throws if blocked/missing), publish=true)
  → publishAsync → delete baseline
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/deploy-runner/update-helpers.ts` | Modify | `diffFlowYaml`, `evaluateFlowDiffGate`, `KNOWN_VOLATILE_FLOW_PATHS`, baseline envelope read/write/delete/serialize/parse, `baselineFilePath` |
| `src/deploy-runner/index.ts` | Modify | `updateFlow()` gains baseline capture; new `confirmAndPublishFlow()`; `classifyUpdateError()` prefers a pre-set `errorKind` on the thrown error; new `--confirm-publish`/`--exports-dir` CLI args |
| `src/mcp-server/tools/update-flow.ts` | Modify | Remove `publish`, add `confirmPublish`; compute/pass `--exports-dir`; surface diff summary / block reasons |
| `package.json` | Modify | Add `yaml` dependency |
| `.gitignore` | Modify | Add `exports/` |
| `skills/write-flow/SKILL.md` | Modify | Document two-call protocol, remove `publish:true` bot-flow example |
| `openspec/specs/update-flow/spec.md` | Modify | New requirements |

## Interfaces / Contracts

```typescript
export interface FlowDiffResult { changed: FlowDiffEntry[]; added: FlowDiffEntry[]; removed: FlowDiffEntry[]; }
export function diffFlowYaml(baselineYaml: string, candidateYaml: string): FlowDiffResult;
export const KNOWN_VOLATILE_FLOW_PATHS: readonly string[];
export function evaluateFlowDiffGate(
  requestedDiff: FlowDiffResult, confirmDiff: FlowDiffResult,
  volatilePaths?: readonly string[],
): { blocked: boolean; unrequestedPaths: string[] };

export interface BaselineEnvelope {
  flowId: string; capturedAt: string; originalContent: string; requestedContent?: string;
}
export function baselineFilePath(exportsDir: string, flowId: string): string; // throws on unsafe flowId
export function writeBaselineFile(filePath: string, envelope: BaselineEnvelope): Promise<void>;
export function readBaselineFile(filePath: string): Promise<BaselineEnvelope | undefined>; // undefined on ENOENT
export function deleteBaselineFile(filePath: string): Promise<void>; // ignores ENOENT
```

New `UpdateErrorKind` values: `no-baseline-found`, `unsolicited-changes-detected` — both set directly as an `errorKind` property on the thrown Error (not message-sniffed) since they originate in our own code, not the SDK.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `diffFlowYaml`: added/removed/changed leaves, array reordering tolerated via `name`/`id` keys, nested structures | `node:test`, plain object fixtures via `yaml` parse |
| Unit | `evaluateFlowDiffGate`: requested-path allowed same value, blocked on different value, blocked on untouched path, volatile path always allowed | `node:test`, synthetic `FlowDiffResult`s |
| Unit | baseline envelope round-trip + `writeBaselineFile`/`readBaselineFile`/`deleteBaselineFile` incl. missing-file case | `node:test` against `os.tmpdir()`, no mocking |
| Unit | `baselineFilePath` rejects `..`/`/`/`\\` in flowId | `node:test` |
| Integration | End-to-end two-call flow against a real org: edit, call1 (baseline+diff shown), simulate drift via Architect UI, call2 (hard block, baseline kept), resolve, call2 clean (publish, baseline deleted) | Manual, `sdd-apply` |
| Integration | Export byte-stability: export same unmodified flow twice, diff parsed structures, feed findings into `KNOWN_VOLATILE_FLOW_PATHS` | Manual, `sdd-apply` |

## Threat Matrix

N/A — no routing, shell-command construction, VCS/PR automation, or executable-file classification changes; subprocess spawning stays the existing array-form `spawn("node", nodeArgs)`, only new boolean/string flags added. Path-traversal risk on caller-supplied `flowId` is handled as an ordinary Architecture Decision (`baselineFilePath` validation), not a threat-matrix row.

## Migration / Rollout

Breaking change: `update_flow`'s `publish: boolean` input is removed. Existing callers using `publish:true` (e.g. the bot-flow testing step in `skills/write-flow/SKILL.md`) must switch to the two-call `confirmPublish` protocol. No data migration; `exports/` is new and gitignored.

## Open Questions

- [ ] Export byte-stability and real volatile field names — verify empirically in `sdd-apply` (feeds `KNOWN_VOLATILE_FLOW_PATHS`).
- [ ] Whether Architect flow YAML's arrays reliably carry stable `name`/`id` keys (assumed here) — confirm against a real export in `sdd-apply`.
- [ ] Whether the MCP server process's `process.cwd()` reliably equals the user's project root in Claude Code's plugin launch model — confirm in `sdd-apply`.
- [ ] Call 2 identified by `flowName` (not `flowId`) defers the missing-baseline check until after checkout (unlike the `flowId` path, which fails fast); `write-flow` skill should recommend always passing the `flowId` returned by call 1.
