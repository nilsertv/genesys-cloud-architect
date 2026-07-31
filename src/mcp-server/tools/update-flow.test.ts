import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateFlow } from "./update-flow.ts";

// Same regression guard as read-flow.test.ts (openspec/changes/update-flow/
// tasks.md 2.6): update-flow.ts's inputSchema MUST stay a flat `ZodRawShape`,
// never `.refine()`-wrapped, or `tools/list` silently degrades to zero
// advertised parameters.

async function createLinkedClient(): Promise<{
    client: Client;
    close: () => Promise<void>;
}> {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    const updateFlowTool = updateFlow({
        deployScriptPath: "/fake/deploy-runner.js",
        region: "us_east_1",
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
    });
    server.registerTool(
        "update_flow",
        updateFlowTool.config,
        updateFlowTool.handler,
    );

    const [serverTransport, clientTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

describe("update_flow — tools/list schema", () => {
    let client: Client;
    let close: () => Promise<void>;

    before(async () => {
        ({ client, close } = await createLinkedClient());
    });

    after(async () => {
        await close();
    });

    it("advertises exactly the 6 expected input keys, with confirmPublish instead of publish", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "update_flow");
        assert.ok(tool, "update_flow was not found in tools/list");

        const schema = tool.inputSchema as {
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
        };

        assert.ok(
            schema.properties,
            "update_flow's inputSchema has no properties — this is the ZodEffects/.refine() regression",
        );
        assert.deepEqual(
            Object.keys(schema.properties).sort(),
            [
                "flowFile",
                "flowId",
                "flowName",
                "flowType",
                "forceUnlock",
                "confirmPublish",
            ].sort(),
        );
        assert.equal(
            "publish" in schema.properties,
            false,
            "publish must be removed — breaking change, no compatibility alias",
        );
    });

    it("marks only flowFile and flowType as required", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "update_flow");
        const schema = tool?.inputSchema as { required?: string[] };

        assert.deepEqual(schema.required?.sort(), ["flowFile", "flowType"]);
    });

    it("advertises destructiveHint:true and readOnlyHint:false", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "update_flow");

        assert.equal(tool?.annotations?.readOnlyHint, false);
        assert.equal(tool?.annotations?.destructiveHint, true);
    });
});

describe("update_flow — cross-field flowId/flowName validation (callTool)", () => {
    let client: Client;
    let close: () => Promise<void>;

    before(async () => {
        ({ client, close } = await createLinkedClient());
    });

    after(async () => {
        await close();
    });

    it("rejects with the 'neither given' message when both flowId and flowName are omitted", async () => {
        const result = await client.callTool({
            name: "update_flow",
            arguments: {
                flowFile: "/tmp/does-not-matter.ts",
                flowType: "inboundcall",
            },
        });

        assert.equal(result.isError, true);
        const content = result.content as Array<{
            type: string;
            text: string;
        }>;
        assert.match(
            content[0].text,
            /Provide exactly one of flowId or flowName — neither was given\./,
        );
    });

    it("rejects with the 'not both' message when both flowId and flowName are given", async () => {
        const result = await client.callTool({
            name: "update_flow",
            arguments: {
                flowFile: "/tmp/does-not-matter.ts",
                flowId: "abc-123",
                flowName: "SomeFlow",
                flowType: "inboundcall",
            },
        });

        assert.equal(result.isError, true);
        const content = result.content as Array<{
            type: string;
            text: string;
        }>;
        assert.match(
            content[0].text,
            /Provide exactly one of flowId or flowName, not both\. Remove one of the two identifiers\./,
        );
    });
});
