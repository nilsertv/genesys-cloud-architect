import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFlow } from "./read-flow.ts";

// This test exists specifically to catch the confirmed production bug from
// update_flow (openspec/changes/update-flow/tasks.md 2.6): a `.refine()`
// wrapped inputSchema (ZodEffects) silently degrades to zero advertised
// parameters in `tools/list`, because the installed
// `@modelcontextprotocol/sdk`'s `normalizeObjectSchema()` cannot read
// `.shape` off a `ZodEffects` instance. read-flow.ts's schema MUST stay a
// flat `ZodRawShape` — if this test ever fails because the schema has zero
// or missing properties, the fix is to REMOVE any `.refine()`/`.object()`
// wrapping, never to re-add one.

async function createLinkedClient(): Promise<{
    client: Client;
    close: () => Promise<void>;
}> {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    const readFlowTool = readFlow({
        deployScriptPath: "/fake/deploy-runner.js",
        region: "us_east_1",
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        getUserToken: () => undefined,
    });
    server.registerTool("read_flow", readFlowTool.config, readFlowTool.handler);

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

describe("read_flow — tools/list schema", () => {
    let client: Client;
    let close: () => Promise<void>;

    before(async () => {
        ({ client, close } = await createLinkedClient());
    });

    after(async () => {
        await close();
    });

    it("advertises exactly the 4 expected input keys", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "read_flow");
        assert.ok(tool, "read_flow was not found in tools/list");

        const schema = tool.inputSchema as {
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
        };

        assert.ok(
            schema.properties,
            "read_flow's inputSchema has no properties — this is the ZodEffects/.refine() regression",
        );
        assert.deepEqual(
            Object.keys(schema.properties).sort(),
            ["flowId", "flowName", "flowType", "flowVersion"].sort(),
        );
    });

    it("marks only flowType as required", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "read_flow");
        const schema = tool?.inputSchema as { required?: string[] };

        assert.deepEqual(schema.required, ["flowType"]);
    });

    it("advertises readOnlyHint:true and destructiveHint:false, unlike update_flow", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "read_flow");

        assert.equal(tool?.annotations?.readOnlyHint, true);
        assert.equal(tool?.annotations?.destructiveHint, false);
    });
});

describe("read_flow — cross-field flowId/flowName validation (callTool)", () => {
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
            name: "read_flow",
            arguments: { flowType: "inboundcall" },
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
            name: "read_flow",
            arguments: {
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

    it("produces two distinct messages, not one collapsed generic message", async () => {
        const neither = await client.callTool({
            name: "read_flow",
            arguments: { flowType: "inboundcall" },
        });
        const both = await client.callTool({
            name: "read_flow",
            arguments: {
                flowId: "abc-123",
                flowName: "SomeFlow",
                flowType: "inboundcall",
            },
        });

        const neitherText = (
            neither.content as Array<{ type: string; text: string }>
        )[0].text;
        const bothText = (
            both.content as Array<{ type: string; text: string }>
        )[0].text;
        assert.notEqual(neitherText, bothText);
    });
});
