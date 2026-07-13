# Genesys Cloud Architect Claude Code Plugin

Create, debug and test Genesys Cloud Architect Flows using Claude Code.

**This is under heavy development. Feedback is welcome!**

## Installation

```
# Add the marketplace
/plugin marketplace add MakingChatbots/genesys-cloud-architect

# Install the plugin
/plugin install genesys-cloud-architect@makingchatbots
```

## Configuration

The MCP server needs your Genesys Cloud OAuth client credentials. Set these as environment
variables in the project where you're using the plugin (e.g. via [direnv](https://direnv.net/)
and a per-project `.envrc`, or any other per-directory env mechanism), so Claude Code inherits
them when it launches the MCP server:

```
GENESYS_REGION=https://api.mypurecloud.com
GENESYS_CLIENT_ID=your-oauth-client-id
GENESYS_CLIENT_SECRET=your-oauth-client-secret
```

This keeps credentials scoped per project — each Genesys Cloud tenant/org you work with gets its
own env vars, instead of a single global set shared across every project on the machine.

## Getting Started

Once you've installed the plugin you can start working with Claude Code to create your Architect flows.

Try some of the following examples:

> Create a Digital Chatbot that asks the customer for their name, then welcomes them by their name.


## Development

Docs to help understand how this works, or contribute:

* [docs/development.md](docs/development.md)
* [docs/architecture.md](docs/architecture.md)
