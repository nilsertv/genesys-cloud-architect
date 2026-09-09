import {
    enumerateRawActions,
    type RawActionOccurrence,
} from "./flow-ir-parser.ts";

export interface RawActionLookup {
    actionId: string;
    action: unknown;
    taskId: string;
    taskName: string;
    menuChoice?: { digit?: string; name?: string };
}

export interface RawActionSearchMatch {
    actionId: string;
    actionType?: string;
    name?: string;
    taskId: string;
    taskName: string;
    menuChoice?: { digit?: string; name?: string };
    matchedPaths: {
        path: string;
        value: string;
        matchIndex: number;
        matchLength: number;
    }[];
    truncated?: boolean;
}

/**
 * Strips synthetic suffixes (e.g. `<actionId>::<outputId>`) from a requested action ID
 * to resolve the underlying action GUID.
 */
function stripSyntheticSuffix(id: string): string {
    return id.split("::")[0] || id;
}

/**
 * Finds raw actions in a flow configuration by their IDs.
 * Tolerates malformed configurations without throwing and accounts for every
 * distinct requested GUID exactly once across `found` and `notFound`.
 */
export function findRawActions(
    configuration: unknown,
    actionIds: readonly string[],
): { found: RawActionLookup[]; notFound: string[] } {
    const requestedDistinct = new Set<string>();
    for (const rawId of actionIds) {
        if (typeof rawId === "string" && rawId.length > 0) {
            requestedDistinct.add(stripSyntheticSuffix(rawId));
        }
    }

    const occurrencesByActionId = new Map<string, RawActionOccurrence>();
    try {
        for (const occ of enumerateRawActions(configuration)) {
            if (occ.actionId && !occurrencesByActionId.has(occ.actionId)) {
                occurrencesByActionId.set(occ.actionId, occ);
            }
        }
    } catch {
        // Defensive: enumerateRawActions never throws, but guard ensures contract
    }

    const found: RawActionLookup[] = [];
    const notFound: string[] = [];

    for (const guid of requestedDistinct) {
        const occ = occurrencesByActionId.get(guid);
        if (occ) {
            found.push({
                actionId: occ.actionId ?? guid,
                action: occ.raw,
                taskId: occ.taskId,
                taskName: occ.taskName,
                ...(occ.menuChoice ? { menuChoice: occ.menuChoice } : {}),
            });
        } else {
            notFound.push(guid);
        }
    }

    return { found, notFound };
}

function isSearchable(configuration: unknown): boolean {
    return (
        typeof configuration === "object" &&
        configuration !== null &&
        !Array.isArray(configuration) &&
        Array.isArray(
            (configuration as { flowSequenceItemList?: unknown })
                .flowSequenceItemList,
        )
    );
}

function matchLeaf(
    value: string,
    query: string | RegExp,
    caseSensitive: boolean,
): { matchIndex: number; matchLength: number } | null {
    if (typeof query === "string") {
        const matchIndex = caseSensitive
            ? value.indexOf(query)
            : value.toLowerCase().indexOf(query.toLowerCase());
        if (matchIndex === -1) {
            return null;
        }
        return { matchIndex, matchLength: query.length };
    }

    if (query instanceof RegExp) {
        let flags = query.flags.replace(/g/g, "");
        if (!caseSensitive && !flags.includes("i")) {
            flags += "i";
        } else if (caseSensitive && flags.includes("i")) {
            flags = flags.replace(/i/g, "");
        }
        const rx = new RegExp(query.source, flags);
        const m = rx.exec(value);
        if (!m) {
            return null;
        }
        return { matchIndex: m.index, matchLength: m[0].length };
    }

    return null;
}

function walkLeaves(
    value: unknown,
    currentPath: string,
    visitor: (path: string, leafValue: string) => void,
): void {
    if (typeof value === "string") {
        visitor(currentPath, value);
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const subPath =
                currentPath.length > 0 ? `${currentPath}.${i}` : `${i}`;
            walkLeaves(value[i], subPath, visitor);
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            const subPath = currentPath.length > 0 ? `${currentPath}.${k}` : k;
            walkLeaves(v, subPath, visitor);
        }
    }
}

/**
 * Searches string leaf values within raw actions of a flow configuration.
 * Throws if the configuration lacks a valid flowSequenceItemList.
 * Only searches string values (never object keys). Caps matched paths per action
 * at maxMatchesPerAction and marks truncated: true when the cap is exceeded.
 */
export function searchRawActions(
    configuration: unknown,
    query: string | RegExp,
    opts: { caseSensitive: boolean; maxMatchesPerAction: number },
): { hasMatches: boolean; matches: RawActionSearchMatch[] } {
    if (!isSearchable(configuration)) {
        throw new Error("Configuration has no flowSequenceItemList to search");
    }

    const matches: RawActionSearchMatch[] = [];

    for (const occ of enumerateRawActions(configuration)) {
        const leafMatches: {
            path: string;
            value: string;
            matchIndex: number;
            matchLength: number;
        }[] = [];

        walkLeaves(occ.raw, "", (path, leafValue) => {
            const hit = matchLeaf(leafValue, query, opts.caseSensitive);
            if (hit) {
                leafMatches.push({
                    path,
                    value: leafValue,
                    matchIndex: hit.matchIndex,
                    matchLength: hit.matchLength,
                });
            }
        });

        if (leafMatches.length > 0) {
            const isTruncated = leafMatches.length > opts.maxMatchesPerAction;
            const cappedPaths = leafMatches.slice(0, opts.maxMatchesPerAction);

            const actionType =
                typeof occ.raw.type === "string"
                    ? occ.raw.type
                    : typeof occ.raw.__type === "string"
                      ? occ.raw.__type
                      : undefined;
            const name =
                typeof occ.raw.name === "string" ? occ.raw.name : undefined;

            matches.push({
                actionId:
                    occ.actionId ??
                    (typeof occ.raw.id === "string" ? occ.raw.id : ""),
                ...(actionType ? { actionType } : {}),
                ...(name ? { name } : {}),
                taskId: occ.taskId,
                taskName: occ.taskName,
                ...(occ.menuChoice ? { menuChoice: occ.menuChoice } : {}),
                matchedPaths: cappedPaths,
                ...(isTruncated ? { truncated: true } : {}),
            });
        }
    }

    return {
        hasMatches: matches.length > 0,
        matches,
    };
}
