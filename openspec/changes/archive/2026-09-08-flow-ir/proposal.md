# Proposal: Native `flow-ir` Parser — Replace Private Diagram-Lib Dependency

## Intent

Three ported MCP tools (`flow_ir`, `flow_action`, `search_in_flow`, staged
uncommitted on `feat/adopt-upstream-flow-ir`) import `parseFlow`,
`findRawActions`, `searchRawActions` from
`@makingchatbots/genesys-cloud-architect-diagram-lib` — a devDependency that
is confirmed **private** (403 on GitHub Packages even with a `read:packages`
PAT, no public source). The tools cannot ship. This change implements those
three functions natively, in-repo, against the raw Architect
flow-configuration JSON, so the already-ported tool files work with only an
import-path change.

## Scope

### In Scope
- New native module implementing `parseFlow`, `findRawActions`,
  `searchRawActions` per the contract documented in
  `skills/interpret-flow-ir/SKILL.md` (IR shape, ID scheme, warning codes).
- Fetch and check in at least one **real** captured Architect
  flow-configuration JSON fixture via the existing `find_flow` /
  `fetch-flow-configuration` code path — none exists in the repo today and
  the private library's real algorithm is unverifiable.
- Import-path swap only in `flow-ir.ts`, `flow-action.ts`,
  `search-in-flow.ts` — no behavioral changes to those files.
- Remove the unused `@makingchatbots/genesys-cloud-architect-diagram-lib`
  devDependency from `package.json`.
- Correct `openspec/config.yaml`'s stale `testing` section, which claims no
  test runner exists; `node --experimental-strip-types --test` plus 3
  passing `node:test` files already exist.

### Out of Scope
- `read_flow`, `update_flow`, and `update-flow-safeguards` — a different,
  unrelated problem (edit/publish via the Scripting SDK), no upstream
  equivalent, untouched by this change.
- Any change to `fetch-flow-configuration.ts` or `find-flow.ts` — both
  already work with no dependency.
- Enumerating every Architect action `__type` individually (see Approach).

## Capabilities

### New Capabilities
- `flow-ir`: parses raw Architect flow-configuration JSON into the
  documented IR graph (`parseFlow`), looks up raw actions by ID
  (`findRawActions`), and full-text searches raw actions
  (`searchRawActions`) — backing the `flow_ir`, `flow_action`, and
  `search_in_flow` MCP tools.

### Modified Capabilities
None.

## Approach

Hybrid design (Approach 3 from exploration): a generic recursive wiring walk
over the common `outputs`/`paths[]`/`disabled` shape, with explicit handling
only for documented exceptions — task jumps (`<taskId>::start`), Switch
`cases[].referenceId ↔ paths[].outputId`, inline menu-choice actions,
intent-listen exclusion from fan-out resolution, no synthetic loop
back-edges. This mirrors how the SKILL.md spec itself is organized (one rule
plus named exceptions) and avoids enumerating dozens of action types
up front while staying forward-compatible via the generic fallback.

Because the private library's real DFS/reachability/ordering semantics are
unverifiable (403, no public mirror), the native implementation is
clean-room from documented, *observable* behavior only, validated against
one real captured fixture plus synthetic fixtures per warning code.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| New module (location decided in `sdd-design`) | New | `parseFlow`/`findRawActions`/`searchRawActions` — graph build, DFS, reachability, warnings |
| `src/mcp-server/tools/flow-ir.ts` | Modified | Import path only |
| `src/mcp-server/tools/flow-action.ts` | Modified | Import path only |
| `src/mcp-server/tools/search-in-flow.ts` | Modified | Import path only |
| `package.json` | Modified | Remove `@makingchatbots/genesys-cloud-architect-diagram-lib` devDependency |
| `openspec/config.yaml` | Modified | Correct stale `testing` section |
| test fixtures dir (path decided in `sdd-design`) | New | One real captured flow-configuration JSON + synthetic per-warning-code fixtures |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| No real raw flow-config JSON exists yet; shape reconstructed from docs + bundled SDK internals, not an actual sample | High | Fetch and check in a real fixture via `find_flow`/`fetch-flow-configuration` before/during design |
| Private library's exact semantics (DFS order, reachability, back-edges) unknown and unverifiable | Med | Clean-room implementation from documented contract only; flag divergence risk explicitly in `design.md`; validate against real + synthetic fixtures |
| Warning-code fidelity easy to get subtly wrong (`UNRESOLVED_INTENT_FANOUT` × `reachabilityIsComplete`, `DISABLED_BRANCH`) without dedicated fixtures | Med | One synthetic fixture per warning code, checked in with expected output |
| Real fixture may contain sensitive org data | Low | Use a disposable/test flow when fetching, scrub identifying names before commit |

## Rollback Plan

Fully additive/import-path-only. Revert the new module, restore the three
tool files' original import paths, and re-add the devDependency to
`package.json` — no prior working tool (`fetch-flow-configuration`,
`find-flow`, `read-flow`) is touched or needs restoring.

## Dependencies

- Requires the already-working `find_flow` / `fetch-flow-configuration`
  tools to obtain the real fixture (no new external dependency).

## Success Criteria

- [ ] `parseFlow`, `findRawActions`, `searchRawActions` implemented natively
      and satisfy the documented contract in `skills/interpret-flow-ir/SKILL.md`.
- [ ] At least one real captured flow-configuration JSON fixture checked in.
- [ ] `flow_ir`, `flow_action`, `search_in_flow` MCP tools work end-to-end
      with only an import-path change from their current staged state.
- [ ] `@makingchatbots/genesys-cloud-architect-diagram-lib` removed from
      `package.json`.
- [ ] `openspec/config.yaml` `testing` section reflects the real
      `node:test` setup.

## Proposal question round — CONFIRMED

1. **`openspec/config.yaml` fix scope** — confirmed: stays included in this
   change.
2. **Fixture sourcing** — confirmed: reuse the same disposable test flow
   already used for `update-flow`/`read-flow`/`update-flow-safeguards`
   empirical verification — org "Calidda", flow
   `ZZZ-SDD-Test-DoNotUse-UpdateFlow` (flowId
   `69cd3550-0848-4fd7-a5c7-4be615b20ced`).
