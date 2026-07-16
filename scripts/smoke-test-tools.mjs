#!/usr/bin/env node
// Validates the MCP server's tools/list response on stdin.
//
// Checks two things the previous smoke test (`grep -q '"tools"'`) missed:
// 1. Every expected tool is actually present.
// 2. Every tool's inputSchema declares at least one parameter.
//
// (2) exists specifically because a real bug shipped past `tsc`/lint once:
// a `.refine()`-wrapped zod schema made the MCP SDK's tools/list introspection
// silently advertise an empty parameter schema for a tool. `tsc` and the
// linter both stayed green — only a real tools/list response catches this.

const EXPECTED_TOOLS = [
    "flow_dependencies",
    "deploy_flow",
    "test_bot_flow",
    "update_flow",
];

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

// The inspector CLI's stdout is expected to be pure JSON, but parse
// defensively in case a banner/log line ends up mixed into stdout: fall back
// to the outermost {...} substring if a parse of the full text fails.
function parseToolsListOutput(text) {
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) throw new Error("no JSON object found");
        return JSON.parse(text.slice(start, end + 1));
    }
}

let parsed;
try {
    parsed = parseToolsListOutput(raw);
} catch (err) {
    console.error("Smoke test FAILED: tools/list output is not valid JSON.");
    console.error(raw.slice(0, 2000));
    console.error(String(err));
    process.exit(1);
}

const tools = parsed?.tools;
if (!Array.isArray(tools)) {
    console.error(
        "Smoke test FAILED: response has no 'tools' array.",
        JSON.stringify(parsed).slice(0, 500),
    );
    process.exit(1);
}

const byName = new Map(tools.map((t) => [t.name, t]));
const failures = [];

for (const name of EXPECTED_TOOLS) {
    const tool = byName.get(name);
    if (!tool) {
        failures.push(`Tool '${name}' is missing from tools/list.`);
        continue;
    }
    const properties = tool.inputSchema?.properties;
    const paramCount = properties ? Object.keys(properties).length : 0;
    if (paramCount === 0) {
        failures.push(
            `Tool '${name}' advertises an EMPTY parameter schema ` +
                `(inputSchema.properties has 0 keys). An MCP client cannot ` +
                `discover its arguments. This is the exact class of bug a ` +
                "z.object({...}).refine() inputSchema causes — see " +
                "src/mcp-server/tools/update-flow.ts's comment on why " +
                "inputSchema must stay a flat ZodRawShape.",
        );
    }
}

if (failures.length > 0) {
    console.error(`Smoke test FAILED (${failures.length} issue(s)):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}

console.log(
    `Smoke test passed: ${EXPECTED_TOOLS.length} tools present, each with a non-empty declared schema.`,
);
