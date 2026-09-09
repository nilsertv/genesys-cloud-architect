import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RoutingApi } from "purecloud-platform-client-v2";
import { findQueue } from "./find-queue.ts";

function fakeRoutingApi(
    getRoutingQueues: RoutingApi["getRoutingQueues"],
): RoutingApi {
    return { getRoutingQueues } as unknown as RoutingApi;
}

function textOf(result: {
    content: Array<{ type: string; text?: string }>;
}): string {
    return result.content[0]?.text ?? "";
}

async function createLinkedClient(
    routingApi: RoutingApi,
): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    const findQueueTool = findQueue({
        routingApi,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
    });
    server.registerTool(
        "find_queue",
        findQueueTool.config,
        findQueueTool.handler,
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

describe("find_queue — tools/list schema", () => {
    let client: Client;
    let close: () => Promise<void>;

    before(async () => {
        ({ client, close } = await createLinkedClient(
            fakeRoutingApi(async () => ({ entities: [], total: 0 })),
        ));
    });

    after(async () => {
        await close();
    });

    it("advertises exactly the 1 expected input key, required", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "find_queue");
        assert.ok(tool, "find_queue was not found in tools/list");

        const schema = tool.inputSchema as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        assert.ok(
            schema.properties,
            "find_queue's inputSchema has no properties",
        );
        assert.deepEqual(Object.keys(schema.properties), ["name"]);
        assert.deepEqual(schema.required, ["name"]);
    });

    it("advertises readOnlyHint:true and destructiveHint:false", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "find_queue");
        assert.equal(tool?.annotations?.readOnlyHint, true);
        assert.equal(tool?.annotations?.destructiveHint, false);
    });
});

describe("find_queue — handler behaviour", () => {
    it("returns matching queues mapped to a summary shape", async () => {
        const tool = findQueue({
            routingApi: fakeRoutingApi(async () => ({
                entities: [
                    {
                        id: "q1",
                        name: "UK_Sales",
                        division: { id: "d1", name: "Home" },
                        memberCount: 5,
                        joinedMemberCount: 2,
                        dateModified: "2024-01-01T00:00:00Z",
                    },
                ],
                total: 1,
            })),
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
        });

        const result = await tool.handler({ name: "sales" });
        assert.equal(result.isError, undefined);

        const parsed = JSON.parse(textOf(result));
        assert.equal(parsed.total, 1);
        assert.equal(parsed.queues.length, 1);
        assert.deepEqual(parsed.queues[0], {
            id: "q1",
            name: "UK_Sales",
            division: { id: "d1", name: "Home" },
            memberCount: 5,
            joinedMemberCount: 2,
            dateModified: "2024-01-01T00:00:00Z",
        });
    });

    it("sorts an exact name match to the top", async () => {
        const tool = findQueue({
            routingApi: fakeRoutingApi(async () => ({
                entities: [
                    { id: "q1", name: "UK_Sales_Overflow" },
                    { id: "q2", name: "Sales" },
                ],
                total: 2,
            })),
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
        });

        const result = await tool.handler({ name: "Sales" });
        const parsed = JSON.parse(textOf(result));
        assert.equal(parsed.queues[0].id, "q2");
    });

    it("reports a note and no queues when nothing matches", async () => {
        const tool = findQueue({
            routingApi: fakeRoutingApi(async () => ({
                entities: [],
                total: 0,
            })),
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
        });

        const result = await tool.handler({ name: "nonexistent" });
        const parsed = JSON.parse(textOf(result));
        assert.equal(parsed.queues.length, 0);
        assert.ok(
            parsed.notes?.[0]?.includes('No queues matched "nonexistent"'),
        );
    });

    it("wraps a getRoutingQueues rejection into an isError text response", async () => {
        const tool = findQueue({
            routingApi: fakeRoutingApi(async () => {
                throw { status: 403, message: "Forbidden" };
            }),
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
        });

        const result = await tool.handler({ name: "sales" });
        assert.equal(result.isError, true);
        const text = textOf(result);
        assert.match(text, /Failed to search for queues/);
        assert.match(text, /Routing > Queue > View/);
    });
});
