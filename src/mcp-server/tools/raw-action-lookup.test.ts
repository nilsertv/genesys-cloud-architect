import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findRawActions, searchRawActions } from "./raw-action-lookup.ts";

const fixturesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "__fixtures__",
);

function loadFixture(relPath: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, relPath), "utf8"));
}

describe("findRawActions — lookup, notFound, and synthetic suffix handling (tasks 3.1-3.4)", () => {
    const sampleFlow = {
        name: "LookupTestFlow",
        type: "inboundcall",
        flowSequenceItemList: [
            {
                id: "task-1",
                name: "Main Task",
                actionList: [
                    {
                        id: "act-1",
                        type: "PlayAudioAction",
                        name: "Greeting",
                    },
                    {
                        id: "act-2",
                        type: "DisconnectAction",
                        name: "Hangup",
                    },
                ],
            },
        ],
    };

    it("returns found and notFound covering every requested id exactly once", () => {
        const res = findRawActions(sampleFlow, [
            "act-1",
            "missing-1",
            "act-2",
            "missing-2",
        ]);
        assert.equal(res.found.length, 2);
        assert.equal(res.notFound.length, 2);

        const foundIds = res.found.map((f) => f.actionId);
        assert.ok(foundIds.includes("act-1"));
        assert.ok(foundIds.includes("act-2"));

        assert.deepEqual(res.notFound.sort(), ["missing-1", "missing-2"]);

        const act1 = res.found.find((f) => f.actionId === "act-1");
        assert.equal(act1?.taskId, "task-1");
        assert.equal(act1?.taskName, "Main Task");
        assert.deepEqual(act1?.action, {
            id: "act-1",
            type: "PlayAudioAction",
            name: "Greeting",
        });
    });

    it("never throws on malformed or absent configuration, returning all ids in notFound", () => {
        assert.doesNotThrow(() => {
            const res = findRawActions(null, ["act-1", "act-2"]);
            assert.deepEqual(res.found, []);
            assert.deepEqual(res.notFound, ["act-1", "act-2"]);
        });

        assert.doesNotThrow(() => {
            const res = findRawActions({}, ["act-1"]);
            assert.deepEqual(res.found, []);
            assert.deepEqual(res.notFound, ["act-1"]);
        });
    });

    it("strips synthetic <actionId>::<outputId> suffix to resolve underlying action", () => {
        const res = findRawActions(sampleFlow, ["act-1::__FAILURE__"]);
        assert.equal(res.found.length, 1);
        assert.equal(res.found[0].actionId, "act-1");
        assert.deepEqual(res.notFound, []);
    });

    it("accounts for every distinct requested GUID exactly once in a mixed batch", () => {
        const res = findRawActions(sampleFlow, [
            "act-1",
            "act-1::out-1",
            "act-1::out-2",
            "missing-1",
            "missing-1::out-x",
        ]);
        assert.equal(res.found.length, 1);
        assert.equal(res.found[0].actionId, "act-1");
        assert.deepEqual(res.notFound, ["missing-1"]);
    });
});

describe("searchRawActions — content search, regex, case-sensitivity, truncation, and unsearchable config (tasks 3.5-3.9)", () => {
    const searchFlow = {
        name: "SearchTestFlow",
        type: "inboundcall",
        flowSequenceItemList: [
            {
                id: "task-1",
                name: "Billing Task",
                actionList: [
                    {
                        id: "act-prompt",
                        type: "PlayAudioAction",
                        name: "Welcome Audio",
                        audio: {
                            text: "Please enter your Account Number now.",
                        },
                        tags: ["billing", "vip", "primary"],
                    },
                    {
                        id: "act-disconnect",
                        type: "DisconnectAction",
                        name: "Goodbye",
                    },
                ],
            },
        ],
    };

    it("matches literal substring in string leaf values", () => {
        const res = searchRawActions(searchFlow, "Account Number", {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(res.hasMatches, true);
        assert.equal(res.matches.length, 1);
        const match = res.matches[0];
        assert.equal(match.actionId, "act-prompt");
        assert.equal(match.name, "Welcome Audio");
        assert.equal(match.actionType, "PlayAudioAction");
        assert.equal(match.matchedPaths.length, 1);
        assert.equal(match.matchedPaths[0].path, "audio.text");
        assert.equal(
            match.matchedPaths[0].value,
            "Please enter your Account Number now.",
        );
    });

    it("matches regex pattern across string leaf values", () => {
        const res = searchRawActions(searchFlow, /enter your [a-z]+ number/i, {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(res.hasMatches, true);
        assert.equal(res.matches.length, 1);
        assert.equal(res.matches[0].actionId, "act-prompt");
    });

    it("honors case sensitivity: sensitive miss vs insensitive hit", () => {
        const sensitiveRes = searchRawActions(searchFlow, "account number", {
            caseSensitive: true,
            maxMatchesPerAction: 10,
        });
        assert.equal(sensitiveRes.hasMatches, false);
        assert.deepEqual(sensitiveRes.matches, []);

        const insensitiveRes = searchRawActions(searchFlow, "account number", {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(insensitiveRes.hasMatches, true);
        assert.equal(insensitiveRes.matches.length, 1);
    });

    it("never matches object key names, only leaf string values", () => {
        const res = searchRawActions(searchFlow, "actionList", {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(res.hasMatches, false);
        assert.deepEqual(res.matches, []);
    });

    it("caps matched paths at maxMatchesPerAction and marks truncated: true", () => {
        // "act-prompt" matches "i" in name "Welcome Audio" (no 'i'), audio.text ('in' in enter? no, in Please/Account/Number/now? no 'i'),
        // tags[0] ("billing" - 2 'i's), tags[1] ("vip" - 1 'i'), tags[2] ("primary" - 1 'i') -> 3 matching paths
        const res = searchRawActions(searchFlow, "i", {
            caseSensitive: false,
            maxMatchesPerAction: 2,
        });
        assert.equal(res.hasMatches, true);
        const actPrompt = res.matches.find((m) => m.actionId === "act-prompt");
        assert.ok(actPrompt);
        assert.equal(actPrompt.matchedPaths.length, 2);
        assert.equal(actPrompt.truncated, true);
    });

    it("distinguishes zero matches (hasMatches: false) from unsearchable configuration (throws)", () => {
        const zeroMatch = searchRawActions(
            searchFlow,
            "nonexistent-query-string",
            {
                caseSensitive: false,
                maxMatchesPerAction: 10,
            },
        );
        assert.equal(zeroMatch.hasMatches, false);
        assert.deepEqual(zeroMatch.matches, []);

        assert.throws(() => {
            searchRawActions(null, "query", {
                caseSensitive: false,
                maxMatchesPerAction: 10,
            });
        }, /flowSequenceItemList/);

        assert.throws(() => {
            searchRawActions({}, "query", {
                caseSensitive: false,
                maxMatchesPerAction: 10,
            });
        }, /flowSequenceItemList/);
    });

    it("runs empirical verification against synthetic-menu-decision-flow.json fixture (task 3.9)", () => {
        const realFixture = loadFixture("synthetic-menu-decision-flow.json");

        // Fake ids/terms still correctly report nothing found.
        const lookupRes = findRawActions(realFixture, [
            "any-guid-1",
            "any-guid-2",
        ]);
        assert.deepEqual(lookupRes.found, []);
        assert.deepEqual(lookupRes.notFound, ["any-guid-1", "any-guid-2"]);

        const searchRes = searchRawActions(realFixture, "any-search-term", {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(searchRes.hasMatches, false);
        assert.deepEqual(searchRes.matches, []);

        // A real action id (the Decision task's DecisionAction) resolves,
        // including its menu-choice tagging for the inline TaskAction that
        // targets it via `taskReference`.
        const found = findRawActions(realFixture, [
            "78f0b06e-0d2a-47ee-85ec-79dcacd8f084",
        ]);
        assert.equal(found.found.length, 1);
        assert.equal(
            (found.found[0].action as Record<string, unknown>).__type,
            "DecisionAction",
        );

        // The menu choice's inline TaskAction carries menuChoice tagging
        // with a numeric `digit` (1) converted to string.
        const menuActionLookup = findRawActions(realFixture, [
            "45de7e51-fc38-49b5-82e4-47a1ff93416b",
        ]);
        assert.deepEqual(menuActionLookup.found[0].menuChoice, {
            digit: "1",
            name: "Continue",
        });

        // A real name search finds the two Disconnect actions in the
        // Decision task by their distinct labels.
        const nameSearch = searchRawActions(realFixture, "Disconnect Yes", {
            caseSensitive: false,
            maxMatchesPerAction: 10,
        });
        assert.equal(nameSearch.hasMatches, true);
        assert.equal(
            nameSearch.matches[0].actionId,
            "5d856052-9aab-4924-97d7-b7faf8a9dd7f",
        );
    });
});
