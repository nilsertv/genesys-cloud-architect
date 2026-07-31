// Pure, side-effect-free helpers shared by the "update" (edit-in-place) and
// "read" (read-only export) flow modes.
//
// This module has ZERO top-level side effects on purpose: index.ts patches
// global https.request/https.get, console.log, and process.stdout.write at
// module load time (to intercept the Architect Scripting SDK's HTTP errors
// and TRACE logging). Importing index.ts from a node:test file would corrupt
// the test runner's own I/O. This module is imported by BOTH index.ts and
// update-helpers.test.ts precisely to avoid that.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type FlowIdentifier =
    | { kind: "byId"; flowId: string }
    | { kind: "byName"; flowName: string; flowType: string };

/**
 * Resolves which identifier to use when checking out a flow for update.
 * Precedence: flowId wins if both are present (defensive — the MCP tool's
 * zod `.refine()` already forbids ambiguous combinations at the boundary).
 * Throws if neither a valid flowId nor a valid flowName+flowType pair is
 * supplied.
 */
export function resolveFlowIdentifier(opts: {
    flowId?: string;
    flowName?: string;
    flowType?: string;
}): FlowIdentifier {
    if (opts.flowId) {
        return { kind: "byId", flowId: opts.flowId };
    }
    if (opts.flowName && opts.flowType) {
        return {
            kind: "byName",
            flowName: opts.flowName,
            flowType: opts.flowType,
        };
    }
    throw new Error(
        "Must provide either flowId, or flowName together with flowType.",
    );
}

export interface UpdatableFlow {
    checkInAsync(): Promise<unknown>;
    publishAsync(): Promise<unknown>;
    unlockAsync(): Promise<unknown>;
}

/**
 * Applies a mutation to an already-checked-out flow, then saves it via
 * checkInAsync (default) or publishAsync (when publish is true).
 *
 * On failure from mutate/checkInAsync/publishAsync, calls unlockAsync()
 * best-effort (a second failure there is swallowed, not thrown) so the flow
 * is never left orphaned/locked, then rethrows the ORIGINAL error. The
 * unlock outcome is attached to that same error object as an `unlocked`
 * boolean property so callers (index.ts's updateFlow orchestrator) can
 * surface it without a second return channel — a rejected promise can't
 * also carry a resolved value.
 *
 * The failing step (user's `mutate`, or the SDK's checkIn/publish) can
 * reject with anything, not just an `Error` — e.g. `throw "boom"` or
 * `throw 42`. A bare string/number/etc. has no writable properties in the
 * way this function needs, so the `unlocked` signal would silently vanish.
 * To guarantee the signal always survives, any rejection that isn't an
 * object is normalized into an `Error` (preserving the original value's
 * string representation as the message, and the original value itself
 * under `cause`) before `unlocked` is attached and it is rethrown.
 */
export async function applyUpdateAndSave(
    flow: UpdatableFlow,
    mutate: (flow: unknown) => Promise<unknown>,
    publish: boolean,
): Promise<{ unlocked: boolean }> {
    try {
        await mutate(flow);
        if (publish) {
            await flow.publishAsync();
        } else {
            await flow.checkInAsync();
        }
        return { unlocked: false };
    } catch (originalError) {
        let unlocked = true;
        try {
            await flow.unlockAsync();
        } catch {
            unlocked = false;
        }
        const carrier = (
            originalError && typeof originalError === "object"
                ? originalError
                : new Error(String(originalError), { cause: originalError })
        ) as { unlocked?: boolean };
        carrier.unlocked = unlocked;
        throw carrier;
    }
}

/**
 * Truncates `content` to at most `maxChars` characters, appending a marker
 * comment when truncation occurs so callers never mistake a cut-off export
 * for the full document. Pure — no I/O, no side effects.
 *
 * Used by the "read" mode to cap exported flow YAML at `MAX_YAML_CHARS`
 * before it's emitted, so a very large/complex flow can't silently blow out
 * the caller's context window.
 */
export function truncateContent(
    content: string,
    maxChars: number,
): { content: string; truncated: boolean } {
    if (maxChars <= 0) {
        return { content: "", truncated: content.length > 0 };
    }
    if (content.length <= maxChars) {
        return { content, truncated: false };
    }
    const marker =
        `\n\n# [TRUNCATED — original size ${content.length} chars, showing first ${maxChars}. ` +
        `Request a specific flowVersion or narrow the review to reduce size.]`;
    return { content: content.slice(0, maxChars) + marker, truncated: true };
}

export interface ExportableFlow {
    exportToObjectAsync(
        callbackFunction: (exportObject: {
            content: string;
            fileName: string;
        }) => void,
        flowFormat: string,
    ): Promise<unknown>;
}

/**
 * Wraps `ArchBaseFlow#exportToObjectAsync`, working around a confirmed SDK
 * quirk (see readFlow()'s doc comment in index.ts for the empirical
 * finding): the awaited Promise resolves to `undefined` even on success —
 * the real `{content, fileName}` is only ever delivered via the callback
 * parameter. Throws if the callback is never invoked (e.g. the SDK call
 * itself fails silently) instead of returning `undefined` downstream.
 */
export async function exportFlowContent(
    flow: ExportableFlow,
    flowFormat: string,
): Promise<{ content: string; fileName: string }> {
    let exported: { content: string; fileName: string } | undefined;
    await flow.exportToObjectAsync((result) => {
        exported = result;
    }, flowFormat);

    if (!exported) {
        throw new Error(
            "exportToObjectAsync completed without invoking its callback " +
                "with export content.",
        );
    }
    return exported;
}

/**
 * Persisted pre-edit/post-edit snapshot for a single in-progress `updateFlow`
 * call, written to `exports/<flowId>.baseline.yaml`.
 *
 * `originalContent` is captured right after checkout, before any edit runs.
 * `requestedContent` is captured after the edit but before check-in, and is
 * absent until that second write happens (see design.md's "Baseline write
 * timing" decision — two separate writes, not one).
 */
export interface BaselineEnvelope {
    flowId: string;
    capturedAt: string;
    originalContent: string;
    requestedContent?: string;
}

/**
 * Builds the on-disk path for a flow's baseline envelope:
 * `<exportsDir>/<flowId>.baseline.yaml`.
 *
 * `flowId` is caller-supplied input that feeds directly into a file path, and
 * nothing upstream validates its shape — so this throws if it contains `/`,
 * `\`, or `..`, instead of silently allowing path traversal outside
 * `exportsDir`.
 */
export function baselineFilePath(exportsDir: string, flowId: string): string {
    if (
        flowId.includes("/") ||
        flowId.includes("\\") ||
        flowId.includes("..")
    ) {
        throw new Error(
            `Unsafe flowId for baseline file path: ${JSON.stringify(flowId)}`,
        );
    }
    return join(exportsDir, `${flowId}.baseline.yaml`);
}

/**
 * Serializes a BaselineEnvelope to YAML and writes it to `filePath`,
 * overwriting any existing file at that path (per design.md's "Baseline
 * collision" decision: a successful checkout's exclusive lock is the sole
 * staleness signal, so any prior file is always overwritten, never merged
 * with or preserved).
 */
export async function writeBaselineFile(
    filePath: string,
    envelope: BaselineEnvelope,
): Promise<void> {
    await writeFile(filePath, stringifyYaml(envelope), "utf8");
}

/**
 * Reads and parses the BaselineEnvelope at `filePath`, or returns `undefined`
 * if the file does not exist (ENOENT). Any other read/parse error is
 * rethrown.
 */
export async function readBaselineFile(
    filePath: string,
): Promise<BaselineEnvelope | undefined> {
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    return parseYaml(raw) as BaselineEnvelope;
}

/**
 * Deletes the baseline file at `filePath`. Ignores ENOENT (already deleted or
 * never existed) so callers can always call this unconditionally on a
 * successful publish without a preceding existence check.
 */
export async function deleteBaselineFile(filePath: string): Promise<void> {
    try {
        await rm(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
}
