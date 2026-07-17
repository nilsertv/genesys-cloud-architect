import { spawn } from "node:child_process";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

interface ReadRunnerLine {
    type: "log" | "result";
    level?: string;
    message?: string;
    success?: boolean;
    flowId?: string;
    flowName?: string;
    content?: string;
    fileName?: string;
    truncated?: boolean;
    error?: string;
    errorKind?:
        | "locked-by-other-user"
        | "not-found"
        | "type-mismatch"
        | "unknown";
}

const READ_TIMEOUT_MS = 120_000;

// Per design.md § Differentiated Error Handling — do not collapse these into
// one generic message (openspec/config.yaml `rules.apply` explicitly forbids
// the flow-dependencies.ts pattern of flattening every error to "not found").
// Unlike update-flow.ts, "read" mode never acquires a lock, so
// "locked-by-other-user" and "type-mismatch" are left unmapped (undefined)
// here — they fall through to the raw SDK message below, same as "unknown".
const ERROR_KIND_MESSAGES: Record<
    NonNullable<ReadRunnerLine["errorKind"]>,
    string | undefined
> = {
    "not-found":
        "Flow not found for the given flowId/flowName+flowType. If using flowName, note a mismatched flowType produces this same error (the SDK cannot distinguish the two).",
    "locked-by-other-user": undefined,
    "type-mismatch": undefined,
    unknown: undefined,
};

export interface ReadFlowConfig {
    readonly deployScriptPath: string;
    readonly region: string;
    readonly clientId: string;
    readonly clientSecret: string;
}

// NOTE: `inputSchema` MUST stay a flat `ZodRawShape` (plain `{ field: z... }`
// object), NOT `z.object({...}).refine(...)`. A `.refine()` call returns a
// `ZodEffects` instance, which does not expose a top-level `.shape` — the
// installed `@modelcontextprotocol/sdk`'s `normalizeObjectSchema()` (in
// `dist/esm/server/zod-compat.js`) can only read raw shapes or objects with
// a top-level `.shape`, so a `ZodEffects` schema silently degrades the
// `tools/list` response to an empty parameter schema. This is a confirmed
// production bug already found and fixed once for `update_flow` (see
// `openspec/changes/update-flow/tasks.md` 2.6) — do not reintroduce it here.
// The "exactly one of flowId or flowName" cross-field rule is therefore
// enforced manually in the handler below, after parsing, matching
// `update-flow.ts`'s post-fix pattern (`read-flow.test.ts` is the mechanical
// safeguard against this regressing).
const inputSchema = {
    flowId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Existing flow ID to read. Provide exactly one of flowId or flowName.",
        ),
    flowName: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Existing flow name to read. Provide exactly one of flowId or flowName.",
        ),
    flowType: z
        .string()
        .min(1)
        .describe(
            'Flow type (e.g. "inboundcall", "digitalbot"). Always required by the Architect Scripting SDK, for both flowId and flowName lookups.',
        ),
    flowVersion: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Version to read: "latest" (default), "debug", "published", or a numeric commit version as a string. Not validated client-side — the SDK is the source of truth for rejecting invalid values.',
        ),
};

export const readFlow: ToolFactory<ReadFlowConfig> = (toolConfig) => ({
    config: {
        description:
            "Reads an existing Genesys Cloud Architect flow's full definition as " +
            "YAML (states, tasks, variables, actions) WITHOUT checking it out or " +
            "acquiring a lock — safe to call at any time, including while the " +
            "flow is being edited elsewhere by update_flow or another user. " +
            "Useful for inspecting a flow's current structure before authoring " +
            "an update_flow body. The exported YAML is returned as the tool's " +
            "text content and may be truncated for very large flows.",
        annotations: {
            title: "Read Flow",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async (args) => {
        const { flowId, flowName, flowType, flowVersion } = args as {
            flowId?: string;
            flowName?: string;
            flowType: string;
            flowVersion?: string;
        };

        if (Boolean(flowId) === Boolean(flowName)) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: flowId
                            ? "Provide exactly one of flowId or flowName, not both. Remove one of the two identifiers."
                            : "Provide exactly one of flowId or flowName — neither was given.",
                    },
                ],
            };
        }

        const nodeArgs = [
            toolConfig.deployScriptPath,
            "--mode",
            "read",
            "--flow-type",
            flowType,
        ];
        if (flowId) {
            nodeArgs.push("--flow-id", flowId);
        } else if (flowName) {
            nodeArgs.push("--flow-name", flowName);
        }
        if (flowVersion) {
            nodeArgs.push("--flow-version", flowVersion);
        }

        return new Promise((resolve) => {
            const logs: string[] = [];
            let resultLine: ReadRunnerLine | undefined;
            let settled = false;

            const settle = (value: {
                isError?: boolean;
                content: Array<{ type: "text"; text: string }>;
            }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };

            const child = spawn("node", nodeArgs, {
                env: {
                    ...process.env,
                    GENESYS_REGION: toolConfig.region,
                    GENESYS_CLIENT_ID: toolConfig.clientId,
                    GENESYS_CLIENT_SECRET: toolConfig.clientSecret,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Read timed out after ${READ_TIMEOUT_MS / 1000}s.\n\nLogs:\n${logs.join("\n")}`,
                        },
                    ],
                });
            }, READ_TIMEOUT_MS);

            let stdoutBuf = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split("\n");
                stdoutBuf = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line) as ReadRunnerLine;
                        if (parsed.type === "log") {
                            logs.push(`[${parsed.level}] ${parsed.message}`);
                        } else if (parsed.type === "result") {
                            resultLine = parsed;
                        }
                    } catch {
                        logs.push(line);
                    }
                }
            });

            let stderrBuf = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderrBuf += chunk.toString();
            });

            child.on("close", (code) => {
                if (stdoutBuf.trim()) {
                    try {
                        const parsed = JSON.parse(
                            stdoutBuf.trim(),
                        ) as ReadRunnerLine;
                        if (parsed.type === "result") resultLine = parsed;
                        else if (parsed.type === "log")
                            logs.push(`[${parsed.level}] ${parsed.message}`);
                    } catch {
                        if (stdoutBuf.trim()) logs.push(stdoutBuf.trim());
                    }
                }

                const filteredStderr = stderrBuf
                    .split("\n")
                    .filter(
                        (l) =>
                            !l.includes("url.parse()") &&
                            !l.includes("[DEP0169]"),
                    )
                    .join("\n")
                    .trim();
                if (filteredStderr) {
                    logs.push(`[stderr] ${filteredStderr}`);
                }

                const logOutput = logs.length
                    ? `\n\nLogs:\n${logs.join("\n")}`
                    : "";

                if (resultLine?.success) {
                    settle({
                        content: [
                            {
                                type: "text",
                                text: resultLine.content ?? "",
                            },
                        ],
                    });
                } else {
                    const errorKind = resultLine?.errorKind;
                    const mapped =
                        errorKind !== undefined
                            ? ERROR_KIND_MESSAGES[errorKind]
                            : undefined;
                    const errorMsg =
                        mapped ??
                        resultLine?.error ??
                        `Read runner exited with code ${code}`;

                    settle({
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Read failed: ${errorMsg}${logOutput}`,
                            },
                        ],
                    });
                }
            });
        });
    },
});
