import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import platformClient from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { getUserToken, setUserToken } from "./auth/user-auth-state.ts";
import {
    isTokenExpired,
    readUserToken,
    resolveTokenFilePath,
} from "./auth/user-token-store.ts";
import { deployFlow } from "./tools/deploy-flow.ts";
import { findFlow } from "./tools/find-flow.ts";
import { findQueue } from "./tools/find-queue.ts";
import { flowAction } from "./tools/flow-action.ts";
import { flowDependencies } from "./tools/flow-dependencies.ts";
import { flowIr } from "./tools/flow-ir.ts";
import { loginUser } from "./tools/login-user.ts";
import { readFlow } from "./tools/read-flow.ts";
import { searchInFlow } from "./tools/search-in-flow.ts";
import { testBotFlow } from "./tools/test-bot-flow.ts";
import { updateFlow } from "./tools/update-flow.ts";

process.env.DOTENV_CONFIG_QUIET = "true";
// Fallback for launch contexts where the MCP client didn't forward env vars
// directly. Looks for .env in CLAUDE_PROJECT_DIR (Claude Code) or process.cwd()
// (Antigravity agy, Cursor, VS Code, standalone).
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
if (!process.env.GENESYS_CLIENT_ID && !process.env.GENESYS_PKCE_CLIENT_ID) {
    // override: true — pre-populated empty env vars don't block loading values from .env
    // quiet: true — dotenv v17 logs "◇ injected env..." to stdout by default, which corrupts MCP JSON-RPC
    loadDotenv({
        path: path.join(projectDir, ".env"),
        override: true,
        quiet: true,
    });
}

const envSchema = z
    .object({
        GENESYS_REGION: z.string().min(1).default("mypurecloud.com"),
        GENESYS_CLIENT_ID: z.string().min(1).optional(),
        GENESYS_CLIENT_SECRET: z.string().min(1).optional(),
        GENESYS_PKCE_CLIENT_ID: z.string().min(1).optional(),
        GENESYS_PKCE_CLIENT_SECRET: z.string().min(1).optional(),
        DEPLOY_SCRIPT_PATH: z.preprocess(
            (v) =>
                typeof v === "string" && v.length > 0
                    ? v
                    : path.resolve(__dirname, "../bin/deploy-runner.js"),
            z.string().min(1),
        ),
        // Used for MCP Server smoke test in CI workflow
        PREVENT_LOGIN: z
            .enum(["TRUE", "FALSE"])
            .default("FALSE")
            .transform((v) => v === "TRUE"),
    })
    .refine(
        (data) =>
            (data.GENESYS_CLIENT_ID && data.GENESYS_CLIENT_SECRET) ||
            data.GENESYS_PKCE_CLIENT_ID,
        {
            message:
                "Either (GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET) or GENESYS_PKCE_CLIENT_ID must be provided.",
        },
    );

const envResults = envSchema.safeParse(process.env);

if (!envResults.success) {
    const missing = envResults.error.issues
        .map((i) => i.message || String(i.path[0]))
        .join("\n ");
    console.error(`Invalid or missing environment configuration:\n ${missing}`);
    process.exit(1);
}

const envVars = envResults.data;
process.env.GENESYS_REGION = envVars.GENESYS_REGION;

// PKCE user login (opt-in, see auth/). The token file lives inside the
// project, not ~/.config — resolved from the project root the same way the
// `.env` fallback above is. Actually reading the file happens inside the
// login IIFE further down (not here) so this stays synchronous: esbuild's
// cjs output format (see package.json's build:mcp-server script) does not
// support top-level await.
const tokenFilePath = resolveTokenFilePath(projectDir);

const server = new McpServer({
    name: "genesys-cloud-architect",
    version: process.env.npm_package_version ?? "0.0.0",
});

const architectApi = new platformClient.ArchitectApi();
const routingApi = new platformClient.RoutingApi();

const flowDependenciesTool = flowDependencies({
    architectApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
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
    getUserToken,
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
    getUserToken,
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
    getUserToken,
});
server.registerTool("read_flow", readFlowTool.config, readFlowTool.handler);

const findFlowTool = findFlow({
    architectApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool("find_flow", findFlowTool.config, findFlowTool.handler);

const findQueueTool = findQueue({
    routingApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool("find_queue", findQueueTool.config, findQueueTool.handler);

const testBotFlowTool = testBotFlow({
    textbotsApi: new platformClient.TextbotsApi(),
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool(
    "test_bot_flow",
    testBotFlowTool.config,
    testBotFlowTool.handler,
);

const flowIrTool = flowIr({
    architectApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool("flow_ir", flowIrTool.config, flowIrTool.handler);

const flowActionTool = flowAction({
    architectApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool(
    "flow_action",
    flowActionTool.config,
    flowActionTool.handler,
);

const searchInFlowTool = searchInFlow({
    architectApi,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
});
server.registerTool(
    "search_in_flow",
    searchInFlowTool.config,
    searchInFlowTool.handler,
);

// PKCE user login is 100% opt-in: the login_user tool doesn't even exist in
// the session unless a PKCE client id is configured.
if (envVars.GENESYS_PKCE_CLIENT_ID) {
    const loginUserTool = loginUser({
        region: envVars.GENESYS_REGION,
        pkceClientId: envVars.GENESYS_PKCE_CLIENT_ID,
        pkceClientSecret: envVars.GENESYS_PKCE_CLIENT_SECRET,
        tokenFilePath,
    });
    server.registerTool(
        "login_user",
        loginUserTool.config,
        loginUserTool.handler,
    );
}

void (async () => {
    // Pick up a previously saved user token (from a prior login_user run),
    // if it's still valid for the region this session is configured for.
    // Never blocks/fails startup — a stale or unreadable token file just
    // falls back to Client Credentials below, same as no token at all.
    const storedUserToken = await readUserToken(tokenFilePath);
    if (storedUserToken) {
        if (
            storedUserToken.region === envVars.GENESYS_REGION &&
            !isTokenExpired(storedUserToken)
        ) {
            setUserToken(storedUserToken);
        } else {
            console.warn(
                "Stored user token in .genesys-user-token.json is stale or " +
                    "for a different region. Run the login_user tool to refresh it.",
            );
        }
    }

    if (envVars.PREVENT_LOGIN) {
        console.warn(
            "Login for Platform API skipped. Calling tools will result in an auth failure.",
        );
    } else {
        const client = platformClient.ApiClient.instance;
        client.setEnvironment(envVars.GENESYS_REGION);
        const userToken = getUserToken();
        if (userToken) {
            client.setAccessToken(userToken.accessToken);
        } else if (envVars.GENESYS_CLIENT_ID && envVars.GENESYS_CLIENT_SECRET) {
            await client.loginClientCredentialsGrant(
                envVars.GENESYS_CLIENT_ID,
                envVars.GENESYS_CLIENT_SECRET,
            );
        } else {
            console.warn(
                "No valid user token found and no Client Credentials provided. " +
                    "The server is ready; run the login_user tool to authenticate.",
            );
        }
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
})().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
