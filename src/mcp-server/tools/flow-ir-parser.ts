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

/**
 * Action types whose per-intent routing is not modelled in the IR (step 3c).
 * Best-effort seed from `skills/write-flow/references/gotchas.md`'s
 * `AskForIntent` (`AskForNLUIntentAction`) — no real fixture confirms this
 * yet (see design.md's Open Questions). Extend one line at a time as more
 * types are confirmed.
 */
export const INTENT_FANOUT_ACTION_TYPES: ReadonlySet<string> = new Set([
    "AskForNLUIntentAction",
]);

/**
 * Action types considered naturally terminal (step 3e).
 * An action of one of these types with zero discovered outputs is marked
 * `terminal: true` without emitting `UNKNOWN_ACTION_TYPE`.
 */
export const TERMINAL_ACTION_TYPES: ReadonlySet<string> = new Set([
    "DisconnectAction",
    "ExitBotFlowAction",
    "EndWorkflowAction",
    "WaitForInputAction",
]);

/**
 * (parentActionType, outcomeLabel) pairs whose zero-successor branch outputs
 * are legitimately terminal (step 4).
 */
export const TERMINAL_BRANCH_OUTCOMES: ReadonlySet<string> = new Set([
    "TransferToAcdAction::Success",
    "TransferToNumberAction::Success",
    "TransferToUserAction::Success",
    "TransferToFlowAction::Success",
    "TransferToSecureFlowAction::Success",
    "TransferToVoicemailAction::Success",
]);

/** Probes target action or task id from an output or action entry (step 3d). */

function probeTarget(raw: Record<string, unknown>): string | undefined {
    const t =
        raw.nextActionId ??
        raw.nextAction ??
        raw.targetActionId ??
        raw.actionId ??
        raw.targetTaskId ??
        raw.taskId ??
        raw.target;
    if (typeof t === "string") return t;
    if (isRecord(t) && typeof t.id === "string") return t.id;
    return undefined;
}

/**
 * Task-reference field on a task-jump action (step 3a). `taskReference`
 * (a bare GUID string) is the CONFIRMED real key — empirically verified
 * against a real deployed flow's `TransferTaskAction`/`TaskAction` entries
 * (see synthetic-menu-decision-flow.json). The other keys are kept as
 * defensive fallbacks for shapes not yet observed.
 */
function probeTaskReference(raw: Record<string, unknown>): string | undefined {
    if (typeof raw.taskReference === "string") {
        return raw.taskReference;
    }
    const task = raw.task;
    if (isRecord(task) && typeof task.id === "string") {
        return task.id;
    }
    if (typeof raw.taskId === "string") {
        return raw.taskId;
    }
    if (typeof raw.destinationTaskId === "string") {
        return raw.destinationTaskId;
    }
    return undefined;
}

/**
 * The action id a task item's `menuChoiceList` hangs off (step 3b).
 * Unconfirmed real key — probed defensively per design.md.
 */
function probeStartActionId(item: Record<string, unknown>): string | undefined {
    const startAction = item.startAction;
    if (isRecord(startAction) && typeof startAction.id === "string") {
        return startAction.id;
    }
    if (typeof startAction === "string") {
        return startAction;
    }
    if (typeof item.startActionId === "string") {
        return item.startActionId;
    }
    return undefined;
}

function probeInitialSequenceId(
    configuration: Record<string, unknown>,
): string | undefined {
    const raw = configuration.initialSequence;
    if (typeof raw === "string" && raw.trim() !== "") {
        return raw.trim();
    }
    if (isRecord(raw)) {
        if (typeof raw.id === "string" && raw.id.trim() !== "") {
            return raw.id.trim();
        }
        if (typeof raw.name === "string" && raw.name.trim() !== "") {
            return raw.name.trim();
        }
    }
    return undefined;
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
                    // CONFIRMED against a real deployed flow: `digit` is a
                    // number (e.g. 1), not a string.
                    digit:
                        typeof choice.digit === "string"
                            ? choice.digit
                            : typeof choice.digit === "number"
                              ? String(choice.digit)
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
    const rawByActionId = new Map<string, Record<string, unknown>>();
    for (const task of tasks) {
        const id = `${task.id}::start`;
        nodesById.set(id, {
            id,
            kind: "task-start",
            label: task.name,
            predecessors: [],
            successors: [],
            order: -1,
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
        rawByActionId.set(occurrence.actionId, raw);
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
            order: -1,
            taskId: occurrence.taskId,
            taskName: occurrence.taskName,
            reachable: false,
            terminal: false,
        });
    }

    let reachabilityIsComplete = true;
    const taskIds = new Set(tasks.map((task) => task.id));

    function addEdge(fromId: string, toId: string, label?: string): void {
        const fromNode = nodesById.get(fromId);
        const toNode = nodesById.get(toId);
        if (!fromNode || !toNode) {
            return;
        }
        fromNode.successors.push({ id: toId, label, backEdge: false });
        toNode.predecessors.push({ id: fromId, label, backEdge: false });
    }

    // Task items whose menuChoiceList hangs off one startAction (step 3b) —
    // these are wired exclusively via menu-choice expansion below, not the
    // generic per-action wiring loop.
    const startActionIds = new Set<string>();
    for (const item of items) {
        const menuChoiceList = Array.isArray(item.menuChoiceList)
            ? item.menuChoiceList
            : [];
        if (menuChoiceList.length === 0) {
            continue;
        }
        const startActionId = probeStartActionId(item);
        if (startActionId !== undefined) {
            startActionIds.add(startActionId);
        }
    }

    function wireTarget(fromId: string, target: string): void {
        if (nodesById.has(target)) {
            addEdge(fromId, target);
        } else if (taskIds.has(target)) {
            addEdge(fromId, `${target}::start`);
        } else {
            warnings.push({
                code: "DROPPED_EDGE",
                message: `Wiring target "${target}" from "${fromId}" resolves to neither a known action nor a known task.`,
                nodeId: fromId,
            });
        }
    }

    function addBranchOutput(
        id: string,
        label: string,
        taskId: string,
        taskName: string,
    ): void {
        nodesById.set(id, {
            id,
            kind: "branch-output",
            label,
            predecessors: [],
            successors: [],
            order: -1,
            taskId,
            taskName,
            reachable: false,
            terminal: false,
        });
    }

    // Wire each task's task-start node to its startAction (if present).
    for (const item of items) {
        const taskId = typeof item.id === "string" ? item.id : "";
        const startActionId = probeStartActionId(item);
        if (startActionId !== undefined) {
            wireTarget(`${taskId}::start`, startActionId);
        }
    }

    // Wiring, per action, in design.md's documented order (steps 3a/3c/3d/3e).
    // Menu-choice actions (step 3b) are excluded here and wired exclusively
    // in the pass below.
    for (const [actionId, node] of nodesById) {
        if (node.kind !== "action" || startActionIds.has(actionId)) {
            continue;
        }
        const raw = rawByActionId.get(actionId);
        if (!raw) {
            continue;
        }

        // 3a. Task-jump probe.
        const taskRef = probeTaskReference(raw);
        if (taskRef !== undefined) {
            if (taskIds.has(taskRef)) {
                addEdge(actionId, `${taskRef}::start`);
            } else {
                warnings.push({
                    code: "UNRESOLVED_REFERENCE",
                    message: `Task jump from action "${actionId}" targets unknown task "${taskRef}".`,
                    nodeId: actionId,
                });
            }
            continue;
        }

        // 3c. Intent-fan-out exclusion.
        if (
            node.actionType !== undefined &&
            INTENT_FANOUT_ACTION_TYPES.has(node.actionType)
        ) {
            warnings.push({
                code: "UNRESOLVED_INTENT_FANOUT",
                message: `Action "${actionId}" (${node.actionType}) has unmodelled per-intent routing.`,
                nodeId: actionId,
            });
            reachabilityIsComplete = false;
            continue;
        }

        // 3d. Generic outputs probe (base rule, everything else).
        const rawPaths = Array.isArray(raw.paths)
            ? raw.paths
            : Array.isArray(raw.outputs)
              ? raw.outputs
              : undefined;

        let discoveredOutputsCount = 0;

        if (rawPaths !== undefined) {
            discoveredOutputsCount += rawPaths.length;
            for (const output of rawPaths) {
                if (!isRecord(output)) {
                    continue;
                }
                const outputId =
                    typeof output.outputId === "string"
                        ? output.outputId
                        : typeof output.id === "string"
                          ? output.id
                          : undefined;
                const outcomeLabel =
                    typeof output.name === "string"
                        ? output.name
                        : typeof output.label === "string"
                          ? output.label
                          : outputId;

                if (outputId !== undefined) {
                    const branchId = `${actionId}::${outputId}`;
                    addBranchOutput(
                        branchId,
                        outcomeLabel ?? branchId,
                        node.taskId,
                        node.taskName,
                    );
                    addEdge(actionId, branchId, outcomeLabel);

                    if (output.disabled === true || output.enabled === false) {
                        warnings.push({
                            code: "DISABLED_BRANCH",
                            message: `Branch output "${branchId}" is disabled in the configuration.`,
                            nodeId: branchId,
                        });
                    }

                    const target = probeTarget(output);
                    if (target !== undefined) {
                        wireTarget(branchId, target);
                    }
                }
            }
        } else {
            const fallThroughTarget = probeTarget(raw);
            if (fallThroughTarget !== undefined) {
                discoveredOutputsCount += 1;
                wireTarget(actionId, fallThroughTarget);
            }
        }

        // 3e. Zero discovered outputs: terminal allowlist or UNKNOWN_ACTION_TYPE.
        if (discoveredOutputsCount === 0) {
            node.terminal = true;
            if (
                node.actionType === undefined ||
                !TERMINAL_ACTION_TYPES.has(node.actionType)
            ) {
                warnings.push({
                    code: "UNKNOWN_ACTION_TYPE",
                    message: `Action "${actionId}" (${node.actionType ?? "unknown type"}) has zero discovered outputs and is not recognized as a known terminal action.`,
                    nodeId: actionId,
                });
            }
        }
    }

    // 3b. Menu-choice expansion: one branch-output child of the anchor
    // action per choice, wired to the choice's already-indexed inline
    // action. The anchor is the item's own `startAction` when present, or
    // the item's own task-start node otherwise — CONFIRMED against a real
    // deployed flow that a real `Menu`-typed flowSequenceItemList entry
    // carries `menuChoiceList` directly and has NO `startAction` field at
    // all (unlike the synthetic fixture, which models menuChoiceList
    // hanging off a task's inline MenuAction `startAction`). Both shapes
    // are supported.
    for (const item of items) {
        const menuChoiceList = Array.isArray(item.menuChoiceList)
            ? item.menuChoiceList
            : [];
        if (menuChoiceList.length === 0) {
            continue;
        }
        const taskId = typeof item.id === "string" ? item.id : "";
        const anchorId = probeStartActionId(item) ?? `${taskId}::start`;
        const anchorNode = nodesById.get(anchorId);
        if (!anchorNode) {
            continue;
        }
        menuChoiceList.forEach((choice, index) => {
            if (!isRecord(choice) || !isRecord(choice.action)) {
                return;
            }
            const targetActionId =
                typeof choice.action.id === "string"
                    ? choice.action.id
                    : undefined;
            if (
                targetActionId === undefined ||
                !nodesById.has(targetActionId)
            ) {
                return;
            }
            const choiceKey =
                typeof choice.id === "string" ? choice.id : String(index);
            const branchId = `${anchorId}::${choiceKey}`;
            const label =
                typeof choice.name === "string"
                    ? choice.name
                    : typeof choice.digit === "string"
                      ? choice.digit
                      : typeof choice.digit === "number"
                        ? String(choice.digit)
                        : undefined;
            addBranchOutput(
                branchId,
                label ?? branchId,
                anchorNode.taskId,
                anchorNode.taskName,
            );
            addEdge(anchorId, branchId, label);
            addEdge(branchId, targetActionId);
        });
    }

    // 4. terminal for branch-output nodes: true only when it has zero
    // successors AND its (parentActionType, outcomeLabel) pair is in
    // TERMINAL_BRANCH_OUTCOMES.
    for (const n of nodesById.values()) {
        if (n.kind !== "branch-output") {
            continue;
        }
        if (n.successors.length === 0) {
            const parentEdge = n.predecessors[0];
            const parentNode = parentEdge
                ? nodesById.get(parentEdge.id)
                : undefined;
            const parentType = parentNode?.actionType;
            const outcome = n.label;
            const key =
                parentType && outcome ? `${parentType}::${outcome}` : undefined;
            n.terminal = key !== undefined && TERMINAL_BRANCH_OUTCOMES.has(key);
        } else {
            n.terminal = false;
        }
    }

    // Resolve initialSequence against known tasks (task 2.16).
    let entryTaskId: string | undefined;
    const hasDeclaredInitialSequence =
        configuration.initialSequence !== undefined &&
        configuration.initialSequence !== null &&
        configuration.initialSequence !== "";

    if (hasDeclaredInitialSequence) {
        const probedId = probeInitialSequenceId(configuration);
        const matchedTask = probedId
            ? tasks.find((t) => t.id === probedId || t.name === probedId)
            : undefined;
        if (matchedTask && matchedTask.id !== "") {
            entryTaskId = matchedTask.id;
        } else {
            warnings.push({
                code: "UNRESOLVED_INITIAL_SEQUENCE",
                message: `Declared initial sequence "${String(
                    configuration.initialSequence,
                )}" does not resolve to any known task.`,
            });
        }
    }

    // 5. DFS pass: iterative traversal per root in flowSequenceItemList declaration order (step 5 / task 2.18).
    type NodeColor = "gray" | "black";
    const colors = new Map<string, NodeColor>();
    let nextOrder = 0;

    interface DfsFrame {
        nodeId: string;
        nextEdgeIndex: number;
    }

    for (const task of tasks) {
        const rootId = `${task.id}::start`;
        const rootNode = nodesById.get(rootId);
        if (!rootNode || colors.has(rootId)) {
            continue;
        }

        colors.set(rootId, "gray");
        rootNode.order = nextOrder++;
        rootNode.reachable = true;

        const stack: DfsFrame[] = [{ nodeId: rootId, nextEdgeIndex: 0 }];

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const currNode = nodesById.get(frame.nodeId);
            if (!currNode) {
                stack.pop();
                continue;
            }

            if (frame.nextEdgeIndex < currNode.successors.length) {
                const edge = currNode.successors[frame.nextEdgeIndex];
                frame.nextEdgeIndex++;
                const targetId = edge.id;
                const targetColor = colors.get(targetId);

                if (targetColor === "gray") {
                    edge.backEdge = true;
                    const targetNode = nodesById.get(targetId);
                    if (targetNode) {
                        const predEdge =
                            targetNode.predecessors.find(
                                (p) =>
                                    p.id === currNode.id &&
                                    p.label === edge.label,
                            ) ??
                            targetNode.predecessors.find(
                                (p) => p.id === currNode.id,
                            );
                        if (predEdge) {
                            predEdge.backEdge = true;
                        }
                    }
                } else if (!targetColor) {
                    const targetNode = nodesById.get(targetId);
                    if (targetNode) {
                        colors.set(targetId, "gray");
                        targetNode.order = nextOrder++;
                        targetNode.reachable = true;
                        stack.push({ nodeId: targetId, nextEdgeIndex: 0 });
                    }
                }
            } else {
                colors.set(frame.nodeId, "black");
                stack.pop();
            }
        }
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
            ...(entryTaskId !== undefined ? { entryTaskId } : {}),
            reachabilityIsComplete,
            tasks,
            nodes: [...nodesById.values()].sort((a, b) => {
                if (a.reachable !== b.reachable) {
                    return a.reachable ? -1 : 1;
                }
                return a.order - b.order;
            }),
        },
        warnings,
    };
}
