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

/**
 * Searches string leaf values within raw actions of a flow configuration.
 * Placeholder implementation — full functionality lands in tasks 3.5-3.8.
 */
export function searchRawActions(
    _configuration: unknown,
    _query: string | RegExp,
    _opts: { caseSensitive: boolean; maxMatchesPerAction: number },
): { hasMatches: boolean; matches: RawActionSearchMatch[] } {
    return { hasMatches: false, matches: [] };
}
