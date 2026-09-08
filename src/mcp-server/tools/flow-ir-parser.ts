// Native replacement for `@makingchatbots/genesys-cloud-architect-diagram-lib`
// (private, unreachable — see openspec/changes/flow-ir/proposal.md). Parses a
// raw Genesys Cloud Architect flow-configuration JSON into the IR graph
// documented in skills/interpret-flow-ir/SKILL.md.
//
// Several raw field names below are UNCONFIRMED (no real fixture exercises
// them — see openspec/changes/flow-ir/design.md "Open Questions" and
// apply-progress.md's task 1.3 finding) and are probed defensively with `??`
// chains rather than hardcoded to one guess. Extend the allowlists below and
// tighten the probes empirically once a content-bearing real flow is
// available.

export interface IRTask {
    id: string;
    name: string;
    reusable: boolean;
}

export interface IREdge {
    id: string;
    label?: string;
    backEdge: boolean;
}

export interface IRNode {
    id: string;
    kind: "task-start" | "action" | "branch-output";
    actionType?: string;
    label: string;
    description?: string;
    predecessors: IREdge[];
    successors: IREdge[];
    order: number;
    taskId: string;
    taskName: string;
    reachable: boolean;
    terminal: boolean;
}

export interface IRWarning {
    code: string;
    message: string;
    nodeId?: string;
}

export interface IRGraph {
    flowName: string;
    flowType: string;
    entryTaskId?: string;
    reachabilityIsComplete: boolean;
    tasks: IRTask[];
    nodes: IRNode[];
}

export type ParseFlowResult =
    | { ok: true; ir: IRGraph; warnings: IRWarning[] }
    | { ok: false; error: { code: string; message: string } };

/** One occurrence of a raw action in `flowSequenceItemList` (see `enumerateRawActions`). */
export interface RawActionOccurrence {
    /** Absent when the raw entry carries no usable `id` (see `MISSING_ACTION_ID`). */
    actionId: string | undefined;
    taskId: string;
    taskName: string;
    raw: Record<string, unknown>;
    menuChoice?: { digit?: string; name?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFlowSequenceItemList(
    configuration: unknown,
): configuration is Record<string, unknown> & {
    flowSequenceItemList: unknown[];
} {
    return (
        isRecord(configuration) &&
        Array.isArray(configuration.flowSequenceItemList)
    );
}

/**
 * Walks `flowSequenceItemList[].actionList[]` and, for every item carrying a
 * `menuChoiceList`, each choice's inline `.action`. Tolerant — never throws;
 * malformed/absent `flowSequenceItemList` yields zero occurrences rather than
 * an error. Callers needing a hard error (`parseFlow`) check the precondition
 * themselves first.
 */
export function enumerateRawActions(
    configuration: unknown,
): RawActionOccurrence[] {
    if (!hasFlowSequenceItemList(configuration)) {
        return [];
    }

    const occurrences: RawActionOccurrence[] = [];
    for (const item of configuration.flowSequenceItemList) {
        if (!isRecord(item)) {
            continue;
        }
        const taskId = typeof item.id === "string" ? item.id : "";
        const taskName = typeof item.name === "string" ? item.name : "";

        const actionList = Array.isArray(item.actionList)
            ? item.actionList
            : [];
        for (const raw of actionList) {
            if (!isRecord(raw)) {
                continue;
            }
            occurrences.push({
                actionId: typeof raw.id === "string" ? raw.id : undefined,
                taskId,
                taskName,
                raw,
            });
        }

        const menuChoiceList = Array.isArray(item.menuChoiceList)
            ? item.menuChoiceList
            : [];
        for (const choice of menuChoiceList) {
            if (!isRecord(choice) || !isRecord(choice.action)) {
                continue;
            }
            const raw = choice.action;
            occurrences.push({
                actionId: typeof raw.id === "string" ? raw.id : undefined,
                taskId,
                taskName,
                raw,
                menuChoice: {
                    digit:
                        typeof choice.digit === "string"
                            ? choice.digit
                            : undefined,
                    name:
                        typeof choice.name === "string"
                            ? choice.name
                            : undefined,
                },
            });
        }
    }
    return occurrences;
}

/** Internal, mutable node shape used while the graph is being built. */
type BuildNode = IRNode;

/**
 * Wiring (task-jump/menu-choice/intent-fanout/generic-outputs probes) and the
 * DFS order/reachable/backEdge pass land in subsequent tasks (design.md's
 * Parsing Algorithm steps 3-5); this step (2.3/2.4) only creates one
 * task-start node per task and one action node per first `actionId`
 * occurrence, emitting `MISSING_ACTION_ID`/`DUPLICATE_ACTION_ID` for the
 * dropped occurrences. Every node's `predecessors`/`successors` stay empty
 * and `order`/`reachable`/`terminal` stay at their placeholder defaults until
 * the DFS pass (task 2.18) assigns real values.
 */
export function parseFlow(configuration: unknown): ParseFlowResult {
    if (!hasFlowSequenceItemList(configuration)) {
        return {
            ok: false,
            error: {
                code: "INVALID_CONFIGURATION",
                message:
                    "configuration is not an object with an array flowSequenceItemList.",
            },
        };
    }

    const warnings: IRWarning[] = [];
    const items = configuration.flowSequenceItemList.filter(isRecord);
    const tasks: IRTask[] = items.map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        name: typeof item.name === "string" ? item.name : "",
        reusable: Boolean(item.reusable ?? item.isReusable ?? false),
    }));

    const nodesById = new Map<string, BuildNode>();
    for (const task of tasks) {
        const id = `${task.id}::start`;
        nodesById.set(id, {
            id,
            kind: "task-start",
            label: task.name,
            predecessors: [],
            successors: [],
            order: 0,
            taskId: task.id,
            taskName: task.name,
            reachable: false,
            terminal: false,
        });
    }

    for (const occurrence of enumerateRawActions(configuration)) {
        if (occurrence.actionId === undefined) {
            warnings.push({
                code: "MISSING_ACTION_ID",
                message: "An action entry has no usable id.",
            });
            continue;
        }
        if (nodesById.has(occurrence.actionId)) {
            warnings.push({
                code: "DUPLICATE_ACTION_ID",
                message: `Action id "${occurrence.actionId}" occurs more than once; the repeat is ignored for wiring.`,
                nodeId: occurrence.actionId,
            });
            continue;
        }
        const raw = occurrence.raw;
        nodesById.set(occurrence.actionId, {
            id: occurrence.actionId,
            kind: "action",
            actionType:
                typeof raw.type === "string"
                    ? raw.type
                    : typeof raw.__type === "string"
                      ? raw.__type
                      : undefined,
            label:
                typeof raw.name === "string" ? raw.name : occurrence.actionId,
            description:
                typeof raw.description === "string"
                    ? raw.description
                    : undefined,
            predecessors: [],
            successors: [],
            order: 0,
            taskId: occurrence.taskId,
            taskName: occurrence.taskName,
            reachable: false,
            terminal: false,
        });
    }

    return {
        ok: true,
        ir: {
            flowName:
                typeof configuration.name === "string"
                    ? configuration.name
                    : "",
            flowType:
                typeof configuration.type === "string"
                    ? configuration.type
                    : "",
            reachabilityIsComplete: true,
            tasks,
            nodes: [...nodesById.values()],
        },
        warnings,
    };
}
