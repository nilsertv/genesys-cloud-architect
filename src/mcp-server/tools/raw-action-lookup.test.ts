import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { findRawActions } from "./raw-action-lookup.ts";

function _loadFixture(relPath: string): unknown {
    const full = path.join(__dirname, "__fixtures__", relPath);
    return JSON.parse(fs.readFileSync(full, "utf8"));
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
