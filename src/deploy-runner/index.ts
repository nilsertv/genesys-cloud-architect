// biome-ignore-all lint/suspicious/noExplicitAny: monkey-patching the SDK requires unsafe casts
// biome-ignore-all lint/complexity/noBannedTypes: same reason
// biome-ignore-all lint/style/noNonNullAssertion: statusCode is guaranteed non-null inside the >= 400 guard
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyUpdateAndSave, resolveFlowIdentifier } from "./update-helpers.ts";

const TIMEOUT_MS = 90_000;

type LogLevel = "info" | "warn" | "error";

// "not-found" is empirically confirmed (tasks.md 1.6/2.6, real Genesys Cloud
// org): both checkoutAndLoadFlowByFlowIdAsync's 404
// ("Could not find flow with specified ID. (architect.flow.not.found)") and
// checkoutAndLoadFlowByFlowNameAsync's "no matches" are covered below.
//
// "type-mismatch" is kept in this union for API completeness but is NOT
// reachable in practice, confirmed empirically: (1) on the flowId path,
// checkoutAndLoadFlowByFlowIdAsync does not enforce flowType at all — a
// valid flowId with an unrelated flowType still succeeds; (2) on the
// flowName path, a name that exists under a different type produces the
// exact same "no matches" response as a name that doesn't exist at all —
// the SDK gives no signal to distinguish "wrong type" from "not found".
// classifyUpdateError() therefore folds both into "not-found" below.
//
// "locked-by-other-user" remains a provisional guess — not empirically
// confirmed (requires a second real user/OAuth identity to hold a
// conflicting lock, which was out of scope for solo verification).
export type UpdateErrorKind =
    | "locked-by-other-user"
    | "not-found"
    | "type-mismatch"
    | "unknown";

function emit(type: "log", level: LogLevel, message: string): void;
function emit(
    type: "result",
    payload: {
        success: boolean;
        flowId?: string;
        flowName?: string;
        warnings?: string[];
        error?: string;
        unlocked?: boolean;
        errorKind?: UpdateErrorKind;
    },
): void;
function emit(type: string, ...args: unknown[]): void {
    if (type === "log") {
        const [level, message] = args as [LogLevel, string];
        process.stdout.write(`${JSON.stringify({ type, level, message })}\n`);
    } else {
        const [payload] = args as [Record<string, unknown>];
        process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
    }
}

// ── HTTPS interceptor ──────────────────────────────────────────────────
// Must be installed before requiring the SDK so all its requests are wrapped.

interface HttpError {
    status: number;
    method: string;
    path: string | undefined;
    body: unknown;
}

const httpErrors: HttpError[] = [];
const traces: string[] = [];

function wrapResponseCallback(args: any[], opts: RequestOptions): void {
    const lastIdx = args.length - 1;
    if (lastIdx < 0 || typeof args[lastIdx] !== "function") return;
    const origCb = args[lastIdx] as (res: IncomingMessage) => void;
    args[lastIdx] = (res: IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk));
            res.on("end", () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    parsed = body;
                }
                const entry: HttpError = {
                    status: res.statusCode!,
                    method: opts.method || "GET",
                    path: opts.path ?? undefined,
                    body: parsed,
                };
                httpErrors.push(entry);
                const msg =
                    typeof parsed === "object" && parsed !== null
                        ? (parsed as any).message ||
                          (parsed as any).error ||
                          JSON.stringify(parsed)
                        : parsed;
                emit(
                    "log",
                    "error",
                    `HTTP ${entry.status} ${entry.method} ${entry.path} — ${msg}`,
                );
            });
        }
        origCb(res);
    };
}

function extractOpts(args: any[]): RequestOptions {
    for (const arg of args) {
        if (typeof arg === "object" && arg !== null && !(arg instanceof URL))
            return arg as RequestOptions;
    }
    return {};
}

const origRequest = https.request;
(https as any).request = function patchedRequest(...args: any[]) {
    wrapResponseCallback(args, extractOpts(args));
    return origRequest.apply(this, args as any);
};

const origGet = https.get;
(https as any).get = function patchedGet(...args: any[]) {
    wrapResponseCallback(args, extractOpts(args));
    return origGet.apply(this, args as any);
};

// ── TRACE interceptor ──────────────────────────────────────────────────
// The SDK writes TRACE: lines directly to console.log and stdout, bypassing
// the logging callback. These often contain the actual permission error text.

const origConsoleLog = console.log;
const tracePrefix = "TRACE:";

const SUPPRESSED_TRACES = [/Unknown feature being requested/];

function interceptTrace(text: string): boolean {
    if (text.startsWith(tracePrefix)) {
        const msg = text.slice(tracePrefix.length).trim();
        if (SUPPRESSED_TRACES.some((p) => p.test(msg))) return true;
        traces.push(msg);
        emit("log", "info", msg);
        return true;
    }
    return false;
}

console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
        if (interceptTrace(first)) return;
        if (first.startsWith("- ") || first.startsWith("navigator unavailable"))
            return;
    }
    origConsoleLog.apply(console, args);
};

const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const str = typeof chunk === "string" ? chunk : String(chunk);
    if (str.startsWith(tracePrefix)) {
        interceptTrace(str.trimEnd());
        return true;
    }
    return (origStdoutWrite as Function)(chunk, ...rest);
}) as typeof process.stdout.write;

// ── SDK logging ────────────────────────────────────────────────────────

import type {
    ArchitectScripting,
    ArchSession,
} from "purecloud-flow-scripting-api-sdk-javascript";

const LEVEL_PREFIX: Record<string, LogLevel> = {
    error: "error",
    warning: "warn",
    info: "info",
};

interface SdkLogMessage {
    logType?: string;
    messageParts?: { message?: string };
    messageFull?: string;
}

let publishedFlowId: string | undefined;
let publishedFlowName: string | undefined;
let publishSucceeded = false;
const validationIssues: string[] = [];
let inValidationSummary = false;

const FLOW_CREATED_RE =
    /successfully created flow name '(.+?)' \(id: '(.+?)'\)/;

function installLogging(scripting: ArchitectScripting): void {
    const logging = scripting.services.archLogging;
    logging.setLoggingCallback((logMessage: SdkLogMessage) => {
        const level = logMessage.logType || "info";
        const msg =
            logMessage.messageParts?.message || logMessage.messageFull || "";
        if (msg.includes("clientSecret:") || msg.includes("auth token"))
            return false;

        const created = msg.match(FLOW_CREATED_RE);
        if (created) {
            publishedFlowName = created[1];
            publishedFlowId = created[2];
        }
        if (msg.includes("publish successful")) {
            publishSucceeded = true;
        }

        if (msg.includes("Validation Summary Done")) {
            inValidationSummary = false;
        } else if (msg.includes("Validation Summary")) {
            inValidationSummary = true;
        } else if (inValidationSummary) {
            const trimmed = msg.trim();
            if (trimmed && trimmed !== "No validation issues.") {
                validationIssues.push(trimmed);
            }
        }

        if (level === "warning" || level === "error") {
            const mappedLevel = LEVEL_PREFIX[level] || "info";
            if (
                mappedLevel === "warn" &&
                !msg.includes("end method is being called")
            ) {
                validationIssues.push(msg);
            }
        }

        emit("log", LEVEL_PREFIX[level] || "info", msg);
        return false;
    });
}

// ── Session wrapper ────────────────────────────────────────────────────

interface SessionConfig {
    region: string;
    clientId: string;
    clientSecret: string;
}

function startSession(
    scripting: ArchitectScripting,
    { region, clientId, clientSecret }: SessionConfig,
): Promise<ArchSession> {
    const session = scripting.environment.archSession;
    session.endTerminatesProcess = false;

    return new Promise((resolve, reject) => {
        let started = false;
        session.startWithClientIdAndSecret(
            region,
            function onStarted() {
                started = true;
                resolve(session);
            },
            clientId,
            clientSecret,
            function onEnding() {
                if (started) return;
                const lastHttp = httpErrors[httpErrors.length - 1];
                const lastTrace = traces[traces.length - 1];
                const detail = lastHttp
                    ? `HTTP ${lastHttp.status}: ${typeof lastHttp.body === "object" ? (lastHttp.body as any).message || JSON.stringify(lastHttp.body) : lastHttp.body}`
                    : lastTrace ||
                      "Session ended before authentication completed";
                reject(new Error(`Session start failed — ${detail}`));
            },
            true,
        );
    });
}

// ── Region mapping ────────────────────────────────────────────────────
// The Platform Client SDK uses API domains (e.g. "usw2.pure.cloud") but
// the Architect Scripting SDK expects enum strings (e.g. "prod_us_west_2").

const API_DOMAIN_TO_SDK_REGION: Record<string, string> = {
    "mypurecloud.com": "prod_us_east_1",
    "use2.us-gov-pure.cloud": "prod_us_east_2",
    "usw2.pure.cloud": "prod_us_west_2",
    "cac1.pure.cloud": "prod_ca_central_1",
    "mypurecloud.ie": "prod_eu_west_1",
    "euw2.pure.cloud": "prod_eu_west_2",
    "euc1.pure.cloud": "prod_eu_central_1",
    "euc2.pure.cloud": "prod_eu_central_2",
    "apse2.pure.cloud": "prod_ap_southeast_2",
    "apne1.pure.cloud": "prod_ap_northeast_1",
    "apne2.pure.cloud": "prod_ap_northeast_2",
    "apne3.pure.cloud": "prod_ap_northeast_3",
    "aps1.pure.cloud": "prod_ap_south_1",
    "apse1.pure.cloud": "prod_ap_southeast_1",
    "mec1.pure.cloud": "prod_me_central_1",
    "sae1.pure.cloud": "prod_sa_east_1",
    "afs1.pure.cloud": "prod_af_south_1",
};

function toArchitectSdkRegion(
    scripting: ArchitectScripting,
    apiDomain: string,
): string | undefined {
    const mapped = API_DOMAIN_TO_SDK_REGION[apiDomain];
    if (mapped) return mapped;
    const locations = scripting.enums.archEnums.LOCATIONS as Record<
        string,
        string
    >;
    if (Object.values(locations).includes(apiDomain)) return apiDomain;
    return undefined;
}

// ── Update flow (edit-in-place) ─────────────────────────────────────────

/**
 * Error classifier — see UpdateErrorKind's doc comment for what's empirically
 * confirmed vs. still provisional.
 */
function classifyUpdateError(err: unknown): UpdateErrorKind {
    const message = err instanceof Error ? err.message : String(err);
    if (/locked/i.test(message)) return "locked-by-other-user";
    // Empirically captured SDK text, real Genesys Cloud org:
    //   by id:   "Could not find flow with specified ID. (architect.flow.not.found)"
    //   by name: "no matches" (also covers the unreachable type-mismatch case)
    if (
        /could not find|not[\s-]?found|does not exist|architect\.flow\.not\.found|no matches/i.test(
            message,
        )
    )
        return "not-found";
    return "unknown";
}

/**
 * Checks out an existing flow, applies the user flow file's edits-only
 * `updateFlow(scripting, flow)` export, and checks in or publishes it —
 * never calling createFlow<Type>Async or any delete-and-recreate route.
 *
 * NOTE — deviations from design.md's contract, discovered by reading the
 * installed SDK's types.d.ts (purecloud-flow-scripting-api-sdk-javascript):
 *   1. `flowType` is REQUIRED by both `checkoutAndLoadFlowByFlowIdAsync` and
 *      `checkoutAndLoadFlowByFlowNameAsync` — the SDK has no id-only lookup.
 *      This applies even on the FlowIdentifier "byId" branch, which design.md
 *      models without a flowType field. Callers must supply `opts.flowType`
 *      regardless of whether they identify the flow by id or by name+type.
 *
 * The user flow file is imported and validated (must export a function named
 * `updateFlow`) BEFORE the flow is checked out. This is deliberate: checkout
 * acquires a lock on the live flow, and `applyUpdateAndSave` is the only
 * function that guarantees `unlockAsync()` runs on failure. If the import
 * happened after checkout, a broken flow file (syntax error, missing file,
 * missing export) would leave the flow locked with nothing to release it —
 * an orphaned lock. Importing first means checkout is never reached unless
 * the flow file is already known-good, so no lock is ever taken that isn't
 * released.
 */
export async function updateFlow(
    scripting: ArchitectScripting,
    absoluteFlowPath: string,
    opts: {
        flowId?: string;
        flowName?: string;
        flowType?: string;
        forceUnlock?: boolean;
        publish?: boolean;
    },
): Promise<{ flowId: string; flowName: string }> {
    const identifier = resolveFlowIdentifier(opts);

    const flowType = opts.flowType;
    if (!flowType) {
        throw new Error(
            "flowType is required by the Architect Scripting SDK for both " +
                "checkoutAndLoadFlowByFlowIdAsync and checkoutAndLoadFlowByFlowNameAsync " +
                "— provide it even when identifying the flow by flowId.",
        );
    }

    emit("log", "info", `Importing flow file: ${absoluteFlowPath}`);
    const mod = await import(pathToFileURL(absoluteFlowPath).href);

    if (typeof mod.updateFlow !== "function") {
        throw new Error(
            `Flow file does not export an updateFlow function: ${absoluteFlowPath}`,
        );
    }

    const forceUnlock = opts.forceUnlock ?? false;
    const { archFactoryFlows } = scripting.factories;

    emit(
        "log",
        "info",
        identifier.kind === "byId"
            ? `Checking out flow by id: ${identifier.flowId}`
            : `Checking out flow by name: ${identifier.flowName} (${identifier.flowType})`,
    );

    const flow =
        identifier.kind === "byId"
            ? await archFactoryFlows.checkoutAndLoadFlowByFlowIdAsync(
                  identifier.flowId,
                  flowType,
                  forceUnlock,
              )
            : await archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync(
                  identifier.flowName,
                  identifier.flowType,
                  forceUnlock,
              );

    const publish = opts.publish ?? false;
    await applyUpdateAndSave(
        flow,
        (f) => mod.updateFlow(scripting, f),
        publish,
    );

    return {
        flowId: flow.id,
        flowName: flow.name,
    };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const timer = setTimeout(() => {
        emit("result", {
            success: false,
            error: `Deploy timed out after ${TIMEOUT_MS / 1000}s`,
        });
        process.exit(2);
    }, TIMEOUT_MS);
    timer.unref();

    const { values } = parseArgs({
        options: {
            "flow-file": { type: "string" },
            mode: { type: "string" },
            "flow-id": { type: "string" },
            "flow-name": { type: "string" },
            "flow-type": { type: "string" },
            "force-unlock": { type: "boolean", default: false },
            publish: { type: "boolean", default: false },
        },
        strict: true,
    });

    const flowFile = values["flow-file"];

    // Default (no --mode given) is "create" — the historical `deploy_flow`
    // behavior, preserved for backward compatibility. But if --mode IS given
    // and is neither "create" nor "update", fail loudly rather than silently
    // falling back to "create" — that fallback is the MOST destructive path
    // (delete-and-recreate), so a typo like "--mode updte" must never be
    // allowed to trigger it silently.
    const rawMode = values.mode;
    if (rawMode !== undefined && rawMode !== "create" && rawMode !== "update") {
        emit("result", {
            success: false,
            error: `Invalid --mode "${rawMode}". Must be "create" or "update".`,
        });
        process.exit(1);
    }
    const mode = rawMode === "update" ? "update" : "create";

    if (!flowFile) {
        emit("result", {
            success: false,
            error: "Missing --flow-file argument",
        });
        process.exit(1);
    }

    const absoluteFlowPath = path.resolve(flowFile);

    const region = process.env.GENESYS_REGION;
    const clientId = process.env.GENESYS_CLIENT_ID;
    const clientSecret = process.env.GENESYS_CLIENT_SECRET;

    if (!region || !clientId || !clientSecret) {
        emit("result", {
            success: false,
            error: "Missing required environment variables: GENESYS_REGION, GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET",
        });
        process.exit(1);
    }

    emit("log", "info", "Loading Architect Scripting SDK...");
    const scripting: ArchitectScripting = require("purecloud-flow-scripting-api-sdk-javascript");

    installLogging(scripting);

    const sdkRegion = toArchitectSdkRegion(scripting, region);
    if (!sdkRegion) {
        emit("result", {
            success: false,
            error: `Unknown region "${region}". Known API domains: ${Object.keys(API_DOMAIN_TO_SDK_REGION).join(", ")}`,
        });
        process.exit(1);
    }

    emit("log", "info", `Starting SDK session (region: ${sdkRegion})...`);

    const session = await startSession(scripting, {
        region: sdkRegion,
        clientId,
        clientSecret,
    });

    if (mode === "update") {
        try {
            const result = await updateFlow(scripting, absoluteFlowPath, {
                flowId: values["flow-id"],
                flowName: values["flow-name"],
                flowType: values["flow-type"],
                forceUnlock: values["force-unlock"],
                publish: values.publish,
            });
            emit("result", {
                success: true,
                flowId: result.flowId,
                flowName: result.flowName,
            });
        } catch (err) {
            const unlocked = (err as { unlocked?: boolean } | undefined)
                ?.unlocked;
            const errorKind = classifyUpdateError(err);
            const message = err instanceof Error ? err.message : String(err);
            emit("result", {
                success: false,
                error: message,
                unlocked,
                errorKind,
            });
        } finally {
            session.endExitCode = 0;
            session.end();
        }
        return;
    }

    try {
        emit("log", "info", `Importing flow file: ${absoluteFlowPath}`);
        const mod = await import(pathToFileURL(absoluteFlowPath).href);

        if (typeof mod.buildFlow !== "function") {
            emit("result", {
                success: false,
                error: `Flow file does not export a buildFlow function: ${absoluteFlowPath}`,
            });
            return;
        }

        const flowResult = await mod.buildFlow(scripting);

        let warnings: string[] | undefined;
        if (typeof flowResult?.validateAsync === "function") {
            try {
                const validation = await flowResult.validateAsync();
                if (validation.hasErrorsOrWarnings) {
                    warnings = [];
                    for (const issue of validation.issues) {
                        const label = issue.archObject?.logStr ?? "Unknown";
                        for (const err of issue.errors ?? [])
                            warnings.push(`ERROR [${label}]: ${err}`);
                        for (const warn of issue.warnings ?? [])
                            warnings.push(`WARN [${label}]: ${warn}`);
                    }
                    for (const w of warnings) emit("log", "warn", w);
                }
            } catch {
                if (validationIssues.length > 0) {
                    warnings = validationIssues;
                }
            }
        }

        emit("result", {
            success: true,
            flowId: publishedFlowId,
            flowName: publishedFlowName,
            warnings,
        });
    } catch (err) {
        if (publishSucceeded) {
            const warnings =
                validationIssues.length > 0 ? validationIssues : undefined;
            emit("result", {
                success: true,
                flowId: publishedFlowId,
                flowName: publishedFlowName,
                warnings,
            });
        } else {
            const message = err instanceof Error ? err.message : String(err);
            emit("result", { success: false, error: message });
        }
    } finally {
        session.endExitCode = 0;
        session.end();
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        emit("result", {
            success: false,
            error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exit(1);
    });
