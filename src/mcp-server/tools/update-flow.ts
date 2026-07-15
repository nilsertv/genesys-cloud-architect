import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

interface UpdateRunnerLine {
    type: "log" | "result";
    level?: string;
    message?: string;
    success?: boolean;
    flowId?: string;
    flowName?: string;
    warnings?: string[];
    error?: string;
    unlocked?: boolean;
    errorKind?:
        | "locked-by-other-user"
        | "not-found"
        | "type-mismatch"
        | "unknown";
}

const UPDATE_TIMEOUT_MS = 120_000;

// Per design.md § Differentiated Error Handling — do not collapse these into
// one generic message (openspec/config.yaml `rules.apply` explicitly forbids
// the flow-dependencies.ts pattern of flattening every error to "not found").
const ERROR_KIND_MESSAGES: Record<
    NonNullable<UpdateRunnerLine["errorKind"]>,
    string | undefined
> = {
    "locked-by-other-user":
        "Flow is locked by another user. Retry with forceUnlock:true to override (discards their unsaved edits).",
    "not-found": "Flow not found for the given flowId/flowName+flowType.",
    "type-mismatch": "flowType does not match the existing flow's type.",
    // "unknown" falls through to the raw SDK error message, unmodified.
    unknown: undefined,
};

export interface UpdateFlowConfig {
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
// `tools/list` response to an empty parameter schema (verified empirically
// by instantiating the server and calling `tools/list` — see apply-progress
// for the confirming transcript). The "exactly one of flowId or flowName"
// cross-field rule is therefore enforced manually in the handler below,
// after parsing, matching the post-parse validation pattern already used by
// `deploy-flow.ts`/`flow-dependencies.ts` in this project.
const inputSchema = {
    flowFile: z
        .string()
        .min(1)
        .describe(
            "Path to the TypeScript file exporting updateFlow(scripting, flow) — edits only, does not call checkInAsync/publishAsync itself",
        ),
    flowId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Existing flow ID to update. Provide exactly one of flowId or flowName.",
        ),
    flowName: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Existing flow name to update. Provide exactly one of flowId or flowName.",
        ),
    flowType: z
        .string()
        .min(1)
        .describe(
            'Flow type (e.g. "inboundcall", "digitalbot"). Always required by the Architect Scripting SDK, for both flowId and flowName lookups.',
        ),
    forceUnlock: z
        .boolean()
        .default(false)
        .describe(
            "Forcibly unlock a flow held by another user before editing — discards their unsaved Architect UI edits",
        ),
    publish: z
        .boolean()
        .default(false)
        .describe(
            "Publish the flow after editing instead of just checking it in",
        ),
};

export const updateFlow: ToolFactory<UpdateFlowConfig> = (toolConfig) => ({
    config: {
        description:
            "Edits an existing Genesys Cloud Architect flow in place (checkout, " +
            "apply edits, check-in or publish) WITHOUT deleting or recreating it — " +
            "unlike deploy_flow, this never resets version history or the flow ID. " +
            "The file must export an async updateFlow(scripting, flow) function " +
            "that mutates the already-checked-out flow using the Architect " +
            "Scripting SDK; it must not call checkInAsync/publishAsync itself. " +
            'The project\'s package.json must have "type": "module" for the ES module import to work.',
        annotations: {
            title: "Update Flow",
            readOnlyHint: false,
            destructiveHint: true,
        },
        inputSchema,
    },
    handler: async (args) => {
        const { flowFile, flowId, flowName, flowType, forceUnlock, publish } =
            args as {
                flowFile: string;
                flowId?: string;
                flowName?: string;
                flowType: string;
                forceUnlock: boolean;
                publish: boolean;
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

        const absolutePath = path.resolve(flowFile);
        if (!fs.existsSync(absolutePath)) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Flow file not found: ${absolutePath}`,
                    },
                ],
            };
        }

        const nodeArgs = [
            toolConfig.deployScriptPath,
            "--mode",
            "update",
            "--flow-file",
            absolutePath,
            "--flow-type",
            flowType,
        ];
        if (flowId) {
            nodeArgs.push("--flow-id", flowId);
        } else if (flowName) {
            nodeArgs.push("--flow-name", flowName);
        }
        if (forceUnlock) {
            nodeArgs.push("--force-unlock");
        }
        if (publish) {
            nodeArgs.push("--publish");
        }

        return new Promise((resolve) => {
            const logs: string[] = [];
            let resultLine: UpdateRunnerLine | undefined;
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
                cwd: path.dirname(absolutePath),
                stdio: ["ignore", "pipe", "pipe"],
            });

            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Update timed out after ${UPDATE_TIMEOUT_MS / 1000}s.\n\nLogs:\n${logs.join("\n")}`,
                        },
                    ],
                });
            }, UPDATE_TIMEOUT_MS);

            let stdoutBuf = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split("\n");
                stdoutBuf = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line) as UpdateRunnerLine;
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
                        ) as UpdateRunnerLine;
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
                    const parts = ["Flow updated successfully."];
                    if (resultLine.flowId)
                        parts.push(`Flow ID: ${resultLine.flowId}`);
                    if (resultLine.flowName)
                        parts.push(`Flow Name: ${resultLine.flowName}`);
                    parts.push(
                        publish ? "Published." : "Checked in (not published).",
                    );
                    if (resultLine.warnings?.length)
                        parts.push(
                            `\nValidation warnings:\n${resultLine.warnings.join("\n")}`,
                        );

                    settle({
                        content: [
                            {
                                type: "text",
                                text: parts.join("\n") + logOutput,
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
                        `Update runner exited with code ${code}`;

                    const lockNote =
                        resultLine?.unlocked === true
                            ? " The flow lock was automatically released after this failure."
                            : resultLine?.unlocked === false
                              ? " WARNING: automatic unlock also failed — the flow may remain locked; manual intervention required."
                              : "";

                    settle({
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Update failed: ${errorMsg}${lockNote}${logOutput}`,
                            },
                        ],
                    });
                }
            });
        });
    },
});
