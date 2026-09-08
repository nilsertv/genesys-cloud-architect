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
