import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { enumerateRawActions, parseFlow } from "./flow-ir-parser.ts";

const fixturesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "__fixtures__",
);

function loadFixture(relativePath: string): unknown {
    return JSON.parse(readFileSync(join(fixturesDir, relativePath), "utf8"));
}

describe("parseFlow — precondition guard", () => {
    it("returns {ok:false} for missing flowSequenceItemList", () => {
        const result = parseFlow({ name: "F", type: "inboundcall" });
        assert.equal(result.ok, false);
    });

    it("returns {ok:false} for a non-array flowSequenceItemList", () => {
        const result = parseFlow({
            name: "F",
            type: "inboundcall",
            flowSequenceItemList: "not-an-array",
        });
        assert.equal(result.ok, false);
    });

    it("returns {ok:false}, not throw, for non-object input", () => {
        assert.doesNotThrow(() => parseFlow(null));
        assert.doesNotThrow(() => parseFlow(undefined));
        assert.doesNotThrow(() => parseFlow("string"));
        assert.equal(parseFlow(null).ok, false);
    });

    it("returns {ok:true} for a well-formed, empty flowSequenceItemList", () => {
        const result = parseFlow({
            name: "F",
            type: "inboundcall",
            flowSequenceItemList: [],
        });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.ir.tasks, []);
            assert.deepEqual(result.ir.nodes, []);
            assert.equal(result.ir.flowName, "F");
            assert.equal(result.ir.flowType, "inboundcall");
        }
    });
});

describe("enumerateRawActions — tolerant primitive", () => {
    it("yields zero occurrences for a malformed/absent flowSequenceItemList", () => {
        assert.deepEqual(enumerateRawActions(null), []);
        assert.deepEqual(enumerateRawActions({}), []);
        assert.deepEqual(
            enumerateRawActions({ flowSequenceItemList: "nope" }),
            [],
        );
    });

    it("walks flowSequenceItemList[].actionList[]", () => {
        const occurrences = enumerateRawActions({
            flowSequenceItemList: [
                {
                    id: "task-1",
                    name: "Task One",
                    actionList: [
                        { id: "a1", type: "DisconnectAction", name: "A1" },
                    ],
                },
            ],
        });
        assert.equal(occurrences.length, 1);
        assert.equal(occurrences[0].actionId, "a1");
        assert.equal(occurrences[0].taskId, "task-1");
        assert.equal(occurrences[0].taskName, "Task One");
    });

    it("walks inline menuChoiceList[].action, tagging menuChoice", () => {
        const occurrences = enumerateRawActions({
            flowSequenceItemList: [
                {
                    id: "task-1",
                    name: "Task One",
                    actionList: [],
                    menuChoiceList: [
                        {
                            digit: "1",
                            name: "Sales",
                            action: {
                                id: "a-menu-1",
                                type: "TransferToUserAction",
                            },
                        },
                    ],
                },
            ],
        });
        assert.equal(occurrences.length, 1);
        assert.equal(occurrences[0].actionId, "a-menu-1");
        assert.deepEqual(occurrences[0].menuChoice, {
            digit: "1",
            name: "Sales",
        });
    });
});

describe("parseFlow — warnings/missing-duplicate-action-id fixture", () => {
    const fixture = () =>
        loadFixture("warnings/missing-duplicate-action-id.json");

    it("emits MISSING_ACTION_ID for an occurrence with no id, drops it", () => {
        const result = parseFlow(fixture());
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(result.warnings.some((w) => w.code === "MISSING_ACTION_ID"));
    });

    it("emits DUPLICATE_ACTION_ID for a second occurrence reusing an id", () => {
        const result = parseFlow(fixture());
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const dup = result.warnings.filter(
            (w) => w.code === "DUPLICATE_ACTION_ID",
        );
        assert.equal(dup.length, 1);
        assert.equal(dup[0].nodeId, "action-a");
    });

    it("builds one task-start node per task, one action node per first occurrence", () => {
        const result = parseFlow(fixture());
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const taskStart = result.ir.nodes.find((n) => n.kind === "task-start");
        assert.ok(taskStart);
        assert.equal(taskStart?.id, "task-1::start");
        const actionNodes = result.ir.nodes.filter((n) => n.kind === "action");
        assert.equal(actionNodes.length, 1);
        assert.equal(actionNodes[0].id, "action-a");
        assert.equal(actionNodes[0].actionType, "DisconnectAction");
    });
});

describe("parseFlow — task-jump probe (step 3a)", () => {
    it("wires a resolved task-jump directly to <taskId>::start, no branch-output node", () => {
        const result = parseFlow({
            name: "F",
            type: "inboundcall",
            flowSequenceItemList: [
                {
                    id: "task-1",
                    name: "Task One",
                    actionList: [
                        {
                            id: "jump-action",
                            type: "CallTaskAction",
                            name: "Jump",
                            taskId: "task-2",
                        },
                    ],
                },
                { id: "task-2", name: "Task Two", actionList: [] },
            ],
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const jumpNode = result.ir.nodes.find((n) => n.id === "jump-action");
        assert.ok(jumpNode);
        assert.deepEqual(
            jumpNode?.successors.map((e) => e.id),
            ["task-2::start"],
        );
        assert.ok(!result.ir.nodes.some((n) => n.kind === "branch-output"));
    });

    it("emits UNRESOLVED_REFERENCE for a task-jump targeting a nonexistent task", () => {
        const result = parseFlow(
            loadFixture("warnings/unresolved-reference.json"),
        );
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(
            result.warnings.some((w) => w.code === "UNRESOLVED_REFERENCE"),
        );
        const jumpNode = result.ir.nodes.find((n) => n.id === "jump-action");
        assert.deepEqual(jumpNode?.successors, []);
    });
});

describe("parseFlow — menu-choice expansion (step 3b)", () => {
    it("wires each menu choice as a branch-output child of startAction, successor = inline action", () => {
        const result = parseFlow(loadFixture("menu-choice-task.json"));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const menuNode = result.ir.nodes.find((n) => n.id === "menu-action");
        assert.ok(menuNode);
        assert.equal(menuNode?.successors.length, 1);
        const branchId = menuNode?.successors[0]?.id;
        assert.equal(branchId, "menu-action::0");
        const branchNode = result.ir.nodes.find((n) => n.id === branchId);
        assert.ok(branchNode);
        assert.equal(branchNode?.kind, "branch-output");
        assert.equal(branchNode?.label, "Sales");
        assert.deepEqual(
            branchNode?.successors.map((e) => e.id),
            ["sales-action"],
        );
    });
});

describe("parseFlow — intent-fanout exclusion (step 3c)", () => {
    it("emits UNRESOLVED_INTENT_FANOUT, sets reachabilityIsComplete false, skips wiring", () => {
        const result = parseFlow(
            loadFixture("warnings/unresolved-intent-fanout.json"),
        );
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(
            result.warnings.some((w) => w.code === "UNRESOLVED_INTENT_FANOUT"),
        );
        assert.equal(result.ir.reachabilityIsComplete, false);
        const node = result.ir.nodes.find((n) => n.id === "listen-action");
        assert.deepEqual(node?.successors, []);
    });
});

describe("parseFlow — generic outputs probe, DISABLED_BRANCH, DROPPED_EDGE (step 3d)", () => {
    it("emits DISABLED_BRANCH while keeping edges in graph", () => {
        const result = parseFlow(loadFixture("warnings/disabled-branch.json"));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const disabledWarn = result.warnings.find(
            (w) => w.code === "DISABLED_BRANCH",
        );
        assert.equal(disabledWarn?.nodeId, "decision-1::yes");
        assert.ok(
            result.ir.nodes
                .find((n) => n.id === "decision-1")
                ?.successors.some((e) => e.id === "decision-1::yes"),
        );
        const branchNode = result.ir.nodes.find(
            (n) => n.id === "decision-1::yes",
        );
        assert.equal(branchNode?.kind, "branch-output");
        assert.ok(branchNode?.successors.some((e) => e.id === "action-target"));
    });

    it("emits DROPPED_EDGE on unresolvable target and wires fall-through directly", () => {
        const droppedRes = parseFlow(loadFixture("warnings/dropped-edge.json"));
        assert.equal(droppedRes.ok, true);
        if (droppedRes.ok) {
            assert.equal(
                droppedRes.warnings.find((w) => w.code === "DROPPED_EDGE")
                    ?.nodeId,
                "action-1",
            );
            assert.deepEqual(
                droppedRes.ir.nodes.find((n) => n.id === "action-1")
                    ?.successors,
                [],
            );
        }

        const fallThroughRes = parseFlow({
            name: "F",
            type: "inboundcall",
            flowSequenceItemList: [
                {
                    id: "t1",
                    name: "T1",
                    actionList: [
                        {
                            id: "a1",
                            type: "PlayAudioAction",
                            name: "Play",
                            nextActionId: "a2",
                        },
                        { id: "a2", type: "DisconnectAction", name: "End" },
                    ],
                },
            ],
        });
        assert.equal(fallThroughRes.ok, true);
        if (fallThroughRes.ok) {
            assert.deepEqual(
                fallThroughRes.ir.nodes
                    .find((n) => n.id === "a1")
                    ?.successors.map((e) => e.id),
                ["a2"],
            );
            assert.ok(
                !fallThroughRes.ir.nodes.some(
                    (n) => n.kind === "branch-output",
                ),
            );
        }
    });
});
