import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import {
    buildRunnerEnv,
    checkRunnerAuth,
    type RunnerAuthConfig,
} from "./runner-env.ts";
import type { ToolFactory } from "./types.ts";

interface FlowDiffEntry {
    path: string;
    oldValue?: unknown;
    newValue?: unknown;
}

interface FlowDiffResult {
    changed: FlowDiffEntry[];
    added: FlowDiffEntry[];
    removed: FlowDiffEntry[];
}

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
        | "no-baseline-found"
        | "unsolicited-changes-detected"
        | "unknown";
    requestedDiff?: FlowDiffResult;
    baselinePath?: string;
    unrequestedPaths?: string[];
    lockInfo?: {
        lockedByUserName?: string;
        lockedByUserEmail?: string;
        dateLocked?: string;
    };
    baselineExportPath?: string;
    diff?: FlowDiffResult;
    requiresConfirmation?: boolean;
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
    "not-found":
        "Flow not found for the given flowId/flowName+flowType. If using flowName, note a mismatched flowType produces this same error (the SDK cannot distinguish the two).",
    // Kept for forward compatibility — empirically unreachable with the
    // current SDK, see classifyUpdateError()'s doc comment in
    // src/deploy-runner/index.ts. A mismatched flowType always surfaces as
    // "not-found" instead.
    "type-mismatch": "flowType does not match the existing flow's type.",
    "no-baseline-found":
        "No baseline found for this flow. Call update_flow without confirmPublish first to capture one before confirming.",
    // "unsolicited-changes-detected" gets a dedicated message built from
    // `unrequestedPaths` at the call site below, not this static map.
    "unsolicited-changes-detected": undefined,
    // "unknown" falls through to the raw SDK error message, unmodified.
    unknown: undefined,
};

/**
 * Renders a `FlowDiffResult` (call 1's `diff(baseline, postEditSnapshot)`)
 * as a short human-readable summary for the tool response, so the caller can
 * review exactly what the edit touched before deciding to confirm publish.
 */
function formatDiffSummary(diff: FlowDiffResult | undefined): string {
    if (
        !diff ||
        (diff.changed.length === 0 &&
            diff.added.length === 0 &&
            diff.removed.length === 0)
    ) {
        return "\nRequested diff: no changes detected.";
    }
    const lines = ["\nRequested diff:"];
    for (const entry of diff.changed)
        lines.push(
            `  ~ ${entry.path}: ${JSON.stringify(entry.oldValue)} -> ${JSON.stringify(entry.newValue)}`,
        );
    for (const entry of diff.added)
        lines.push(`  + ${entry.path}: ${JSON.stringify(entry.newValue)}`);
    for (const entry of diff.removed)
        lines.push(`  - ${entry.path}: ${JSON.stringify(entry.oldValue)}`);
    return lines.join("\n");
}

export interface UpdateFlowConfig extends RunnerAuthConfig {
    readonly deployScriptPath: string;
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
    confirmPublish: z
        .boolean()
        .default(false)
        .describe(
            "Two-call protocol, call 2: re-checks out the flow, re-runs the " +
                "full-baseline diff gate against the baseline captured by call " +
                "1 (confirmPublish not set), and publishes only if the diff is " +
                "clean. Call 1 never publishes regardless of this flag's " +
                "absence — there is no single-call publish path.",
        ),
};

export const updateFlow: ToolFactory<UpdateFlowConfig> = (toolConfig) => ({
    config: {
        description:
            "Edits an existing Genesys Cloud Architect flow in place " +
            "WITHOUT deleting or recreating it — unlike deploy_flow, this " +
            "never resets version history or the flow ID. Publishing " +
            "requires a mandatory two-call protocol: call 1 (confirmPublish " +
            "not set) checks out, applies edits, checks in, and returns a " +
            "diff summary plus a baseline file path — it never publishes. " +
            "Call 2 (confirmPublish: true) re-checks out, re-diffs the live " +
            "flow against that same baseline, and publishes only if nothing " +
            "changed beyond the requested edit; any unrequested delta blocks " +
            "the publish unconditionally, with no override. The file must " +
            "export an async updateFlow(scripting, flow) function that " +
            "mutates the already-checked-out flow using the Architect " +
            "Scripting SDK; it must not call checkInAsync/publishAsync " +
            'itself. The project\'s package.json must have "type": "module" ' +
            "for the ES module import to work.",
        annotations: {
            title: "Update Flow",
            readOnlyHint: false,
            destructiveHint: true,
        },
        inputSchema,
    },
    handler: async (args) => {
        const {
            flowFile,
            flowId,
            flowName,
            flowType,
            forceUnlock,
            confirmPublish,
        } = args as {
            flowFile: string;
            flowId?: string;
            flowName?: string;
            flowType: string;
            forceUnlock: boolean;
            confirmPublish: boolean;
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

        const auth = checkRunnerAuth(toolConfig);
        if (!auth.ok) {
            return {
                isError: true,
                content: [{ type: "text", text: auth.error }],
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

        // Computed from the MCP server process's own cwd, not the flow
        // file's directory — a flow file can live in a subdirectory, and
        // `exports/` must stay anchored at the real project root (see
        // design.md's "Exports directory" decision).
        const exportsDir = path.join(process.cwd(), "exports");

        const nodeArgs = [
            toolConfig.deployScriptPath,
            "--mode",
            "update",
            "--flow-file",
            absolutePath,
            "--flow-type",
            flowType,
            "--exports-dir",
            exportsDir,
        ];
        if (flowId) {
            nodeArgs.push("--flow-id", flowId);
        } else if (flowName) {
            nodeArgs.push("--flow-name", flowName);
        }
        if (forceUnlock) {
            nodeArgs.push("--force-unlock");
        }
        if (confirmPublish) {
            nodeArgs.push("--confirm-publish");
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
                env: buildRunnerEnv(toolConfig),
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

            child.on("error", (err) => {
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to start update runner: ${err.message}`,
                        },
                    ],
                });
            });

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
                        confirmPublish
                            ? "Published."
                            : "Checked in (not published).",
                    );
                    if (!confirmPublish && resultLine.baselinePath) {
                        parts.push(`Baseline file: ${resultLine.baselinePath}`);
                        parts.push(formatDiffSummary(resultLine.requestedDiff));
                        parts.push(
                            "\nReview the diff above, then call update_flow " +
                                "again with confirmPublish: true (same flowId) to publish.",
                        );
                    }
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
                    const unrequestedNote =
                        errorKind === "unsolicited-changes-detected" &&
                        resultLine?.unrequestedPaths?.length
                            ? `Publish blocked: unsolicited changes detected outside the requested edit at path(s): ${resultLine.unrequestedPaths.join(", ")}. The baseline file was preserved — restart from call 1 (confirmPublish not set) against the same flowId.`
                            : undefined;
                    const errorMsg =
                        unrequestedNote ??
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
