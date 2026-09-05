# Apply Progress: `flow-ir`

## PR1 — Real Fixture + Stale Config Fix

Status: **partially done, blocked**. See Blockers below.

### Task 1.1 — `find_flow` + `fetch-flow-configuration` capture — BLOCKED

No Genesys Cloud OAuth credentials (`GENESYS_REGION`, `GENESYS_CLIENT_ID`,
`GENESYS_CLIENT_SECRET`) are available anywhere in this environment:

- The project's `.env` exists but contains only `NODE_AUTH_TOKEN` (for the
  private npm registry) — no Genesys credentials.
- No `.envrc` (direnv) exists in the project or is exported in the shell.
- No `op` (1Password) CLI is installed.
- The `genesys-cloud-architect-mcp` MCP server was `CONNECTION_CLOSED` at
  session start, so the `find_flow`/`fetch-flow-configuration` MCP tools
  were not callable either.

A one-off capture script
(`platformClient.ApiClient.instance.loginClientCredentialsGrant(...)` +
`new platformClient.ArchitectApi().getFlowLatestconfiguration(flowId)`,
mirroring `src/mcp-server/index.ts`'s auth pattern and
`fetch-flow-configuration.ts`'s SDK call) was written, run, and confirmed to
fail immediately on missing credentials — then deleted (was scratch-only,
never committed). No network call to Genesys Cloud was made.

**No fixture file exists at
`src/mcp-server/tools/__fixtures__/real-calidda-flow.json`.** Tasks 1.2,
1.3, and 1.5 (scrub, confirm real field names, round-trip verification) are
consequently also not done — they depend on 1.1's output.

**Unblock path**: someone with the Calidda org's Genesys Cloud OAuth client
credentials sets `GENESYS_REGION`/`GENESYS_CLIENT_ID`/`GENESYS_CLIENT_SECRET`
in this project's `.env` (see `README.md`'s Configuration section), then a
follow-up `sdd-apply` run repeats task 1.1 onward. PR2/PR3's synthetic
per-warning-code fixtures do not depend on this and can proceed
independently once PR1's other changes are committed, but PR2's task 2.20
(`parseFlow(real-calidda-flow.json)` trace test) does depend on it.

### Task 1.4 — `openspec/config.yaml` stale `testing` section — DONE

Corrected `context`, `testing.strict_tdd` (→ `true`), `testing.test_command`
(→ `"pnpm test"`), `testing.reason` (documents the 3 existing `node:test`
files and that CI itself still doesn't run `pnpm test`), and the matching
`rules.apply.tdd`/`test_command` and `rules.verify.test_command` fields, to
reflect the real state: `node --experimental-strip-types --test` via
`pnpm test`, no external test-runner dependency. Preserved the file's
existing (pre-existing, not introduced by this change) mixed
list-item/mapping-key structure under `rules.apply`/`rules.verify` exactly,
per the task's instruction not to restructure the file — note this
structure already fails strict YAML parsing (`yaml` npm package) even on
the pre-change file (verified via `git stash`), so this is a pre-existing
quirk, not a regression.

### Task 1.2, 1.3, 1.5 — BLOCKED (depend on 1.1)

### Commits — RESOLVED (orchestrator correction, post-agent)

Root cause was not "PR3 hasn't happened yet" — the private devDependency
was never actually needed at all, since the confirmed decision for this
whole SDD change is to reimplement `parseFlow`/`findRawActions`/
`searchRawActions` natively rather than depend on the private package.
Removed `@makingchatbots/genesys-cloud-architect-diagram-lib` from
`package.json` and deleted the now-pointless `.npmrc` (its only content was
the GitHub Packages registry mapping for that one dependency). `pnpm
install` now succeeds instantly with no auth needed.

`flow-ir.ts`, `flow-action.ts`, `search-in-flow.ts` (which still import the
old package name — PR2/PR3 will point them at the new native module
instead) were unstaged and left as **untracked** files on disk; they still
fail `tsc --noEmit` standalone (expected, unenforced by pre-commit — this
project's own `tsc strict, noEmit, NOT wired into CI/pre-commit` policy),
but no longer block `pnpm build` (esbuild only bundles what's reachable
from `index.ts`, and their import/registration was removed from `index.ts`
for now — `find_flow` alone is registered).

Committed on `feat/adopt-upstream-flow-ir`:
- `9a08698` — `feat(mcp-server): add find_flow tool` (find-flow.ts,
  fetch-flow-configuration.ts, skills/interpret-flow-ir/SKILL.md, trimmed
  index.ts registering only find_flow, types.ts widening)
- `5718fda` — `docs(openspec): correct stale testing section in
  config.yaml` (task 1.4)

`pnpm run build` / `lint` / `test` (55/55) all pass on this branch now.
`pnpm run typecheck` still reports errors, but only from the 3 untracked,
not-yet-committed files — consistent with the project's documented
unenforced-typecheck policy, not a regression.

## Next

A human needs to provide Genesys Cloud OAuth credentials for org "Calidda"
(`GENESYS_REGION`/`GENESYS_CLIENT_ID`/`GENESYS_CLIENT_SECRET` in `.env`) to
unblock the fixture capture (tasks 1.1–1.3, 1.5) — everything else in PR1
is done. Once provided, re-run `sdd-apply` to finish PR1, then continue to
PR2 (`flow-ir-parser.ts`).
