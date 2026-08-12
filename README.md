# Genesys Cloud Architect Claude Code Plugin

Create, debug and test Genesys Cloud Architect Flows using Claude Code.

**This is under heavy development. Feedback is welcome!**

## Installation

```
# Add the marketplace
/plugin marketplace add nilsertv/genesys-cloud-architect

# Install the plugin
/plugin install genesys-cloud-architect@nilsertv-genesys-cloud-architect
```

## Configuration

The MCP server needs your Genesys Cloud OAuth client credentials, scoped **per project** — each
Genesys Cloud tenant/org you work with gets its own credentials, instead of a single global set
shared across every project on the machine.

### Option A — project `.env` file (recommended, works out of the box)

Drop a `.env` file in the root of the project you're using the plugin in:

`GENESYS_REGION` is the bare API domain — no `https://`, no `api.` prefix:

```
GENESYS_REGION=mypurecloud.com
GENESYS_CLIENT_ID=your-oauth-client-id
GENESYS_CLIENT_SECRET=your-oauth-client-secret
```

Common regions:

| Region | `GENESYS_REGION` |
|---|---|
| US East (N. Virginia) | `mypurecloud.com` |
| US West (Oregon) | `usw2.pure.cloud` |
| South America (São Paulo) | `sae1.pure.cloud` |

The MCP server reads this file automatically at startup from `CLAUDE_PROJECT_DIR/.env` (the
project root Claude Code itself resolves) — no shell setup required, and it works no matter how
or from where `claude` was launched. `.env*` is already in `.gitignore`, so this file never gets
committed.

### Option B — export in your shell before launching `claude`

If you already manage per-project env vars via [direnv](https://direnv.net/) (a per-project
`.envrc` with `dotenv`) or a similar per-directory shell mechanism, that also works: `.mcp.json`
forwards `GENESYS_REGION`, `GENESYS_CLIENT_ID`, and `GENESYS_CLIENT_SECRET` from Claude Code's own
launch-time environment into the MCP server's environment.

Install direnv, then hook it into your shell (add to `~/.bashrc` or `~/.zshrc`):

```
eval "$(direnv hook bash)"   # or `zsh` if you use zsh
```

In the project root, create `.envrc` reusing the same `.env` file from Option A:

```
dotenv
```

Then approve it once per project:

```
direnv allow
```

`direnv` exports the vars into your shell automatically on `cd` into the project — launch `claude`
from that same shell afterward.

**This only works if the variables are exported *before* `claude` starts.** `cd`-ing into the
project and letting direnv export mid-session, in a different terminal than the one that launched
`claude`, or in an editor/IDE integration that doesn't run your shell's rc files, will **not**
retroactively reach an already-running Claude Code process — restart `claude` from a shell where
the vars are already set, or use Option A instead.

If neither option provides the credentials, the MCP server fails to start with a
`Missing required environment variables` error (surfaces to Claude Code as a `-32000` reconnect
error).

## Updating

This marketplace doesn't pin a semver version — `claude plugin update` tracks the latest commit
SHA on `main` instead, so every push becomes installable. To pick up a new fix or feature:

```
# Refresh the marketplace listing cache — required first, or the next step no-ops
claude plugin marketplace update nilsertv-genesys-cloud-architect

# Install the update
claude plugin update genesys-cloud-architect@nilsertv-genesys-cloud-architect
```

Then **restart Claude Code** — `claude plugin update` says so explicitly, and `/reload-plugins`
alone isn't confirmed sufficient.

## Getting Started

Once you've installed the plugin you can start working with Claude Code to create your Architect flows.

Try some of the following examples:

> Create a Digital Chatbot that asks the customer for their name, then welcomes them by their name.


## Development

Docs to help understand how this works, or contribute:

* [docs/development.md](docs/development.md)
* [docs/architecture.md](docs/architecture.md)
