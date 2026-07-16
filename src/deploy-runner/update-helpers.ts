// Pure, side-effect-free helpers shared by the "update" (edit-in-place) and
// "read" (read-only export) flow modes.
//
// This module has ZERO top-level side effects on purpose: index.ts patches
// global https.request/https.get, console.log, and process.stdout.write at
// module load time (to intercept the Architect Scripting SDK's HTTP errors
// and TRACE logging). Importing index.ts from a node:test file would corrupt
// the test runner's own I/O. This module is imported by BOTH index.ts and
// update-helpers.test.ts precisely to avoid that.

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
    if (content.length <= maxChars) {
        return { content, truncated: false };
    }
    const marker =
        `\n\n# [TRUNCATED — original size ${content.length} chars, showing first ${maxChars}. ` +
        `Request a specific flowVersion or narrow the review to reduce size.]`;
    return { content: content.slice(0, maxChars) + marker, truncated: true };
}
