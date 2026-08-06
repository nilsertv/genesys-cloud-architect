import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import platformClient from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { deployFlow } from "./tools/deploy-flow.ts";
import { flowDependencies } from "./tools/flow-dependencies.ts";
import { readFlow } from "./tools/read-flow.ts";
import { testBotFlow } from "./tools/test-bot-flow.ts";
import { updateFlow } from "./tools/update-flow.ts";

// Fallback for launch contexts where .mcp.json's ${VAR} expansion had nothing
// to expand (e.g. direnv wasn't loaded in the shell that started Claude Code).
// CLAUDE_PROJECT_DIR is the documented, stable project root — not `cwd`,
// which Claude Code does not guarantee for spawned MCP servers.
if (!process.env.GENESYS_CLIENT_ID && process.env.CLAUDE_PROJECT_DIR) {
    loadDotenv({ path: path.join(process.env.CLAUDE_PROJECT_DIR, ".env") });
}

const envResults = z
    .object({
        GENESYS_REGION: z.string().min(1),
        GENESYS_CLIENT_ID: z.string().min(1),
        GENESYS_CLIENT_SECRET: z.string().min(1),
        DEPLOY_SCRIPT_PATH: z.string().min(1),
        // Used for MCP Server smoke test in CI workflow
        PREVENT_LOGIN: z
            .enum(["TRUE", "FALSE"])
            .default("FALSE")
            .transform((v) => v === "TRUE"),
    })
    .safeParse(process.env);

if (!envResults.success) {
    const missing = envResults.error.issues.map((i) => i.path[0]).join("\n ");
    console.error(`Missing required environment variables:\n ${missing}`);
    process.exit(1);
}

const envVars = envResults.data;

const server = new McpServer({
    name: "genesys-cloud-architect",
    version: process.env.npm_package_version ?? "0.0.0",
});

const flowDependenciesTool = flowDependencies({
    architectApi: new platformClient.ArchitectApi(),
});
server.registerTool(
    "flow_dependencies",
    flowDependenciesTool.config,
    flowDependenciesTool.handler,
);

const deployFlowTool = deployFlow({
    region: envVars.GENESYS_REGION,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
    deployScriptPath: envVars.DEPLOY_SCRIPT_PATH,
});
server.registerTool(
    "deploy_flow",
    deployFlowTool.config,
    deployFlowTool.handler,
);

const updateFlowTool = updateFlow({
    region: envVars.GENESYS_REGION,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
    deployScriptPath: envVars.DEPLOY_SCRIPT_PATH,
});
server.registerTool(
    "update_flow",
    updateFlowTool.config,
    updateFlowTool.handler,
);

const readFlowTool = readFlow({
    region: envVars.GENESYS_REGION,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
    deployScriptPath: envVars.DEPLOY_SCRIPT_PATH,
});
server.registerTool("read_flow", readFlowTool.config, readFlowTool.handler);

const testBotFlowTool = testBotFlow({
    textbotsApi: new platformClient.TextbotsApi(),
});
server.registerTool(
    "test_bot_flow",
    testBotFlowTool.config,
    testBotFlowTool.handler,
);

void (async () => {
    if (envVars.PREVENT_LOGIN) {
        console.warn(
            "Login for Platform API skipped. Calling tools will result in an auth failure.",
        );
    } else {
        const client = platformClient.ApiClient.instance;
        client.setEnvironment(envVars.GENESYS_REGION);
        await client.loginClientCredentialsGrant(
            envVars.GENESYS_CLIENT_ID,
            envVars.GENESYS_CLIENT_SECRET,
        );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
})().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
