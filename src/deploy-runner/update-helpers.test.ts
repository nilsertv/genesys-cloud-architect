import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import {
    applyUpdateAndSave,
    type BaselineEnvelope,
    baselineFilePath,
    deleteBaselineFile,
    diffFlowYaml,
    type ExportableFlow,
    evaluateFlowDiffGate,
    exportFlowContent,
    type FlowDiffResult,
    KNOWN_VOLATILE_FLOW_PATHS,
    readBaselineFile,
    resolveFlowIdentifier,
    truncateContent,
    type UpdatableFlow,
    writeBaselineFile,
} from "./update-helpers.ts";

describe("resolveFlowIdentifier", () => {
    it("resolves by flowId", () => {
        const result = resolveFlowIdentifier({ flowId: "1" });
        assert.deepEqual(result, { kind: "byId", flowId: "1" });
    });

    it("resolves by flowName and flowType", () => {
        const result = resolveFlowIdentifier({
            flowName: "n",
            flowType: "inboundcall",
        });
        assert.deepEqual(result, {
            kind: "byName",
            flowName: "n",
            flowType: "inboundcall",
        });
    });

    it("prefers flowId when flowId, flowName, and flowType are all given", () => {
        const result = resolveFlowIdentifier({
            flowId: "1",
            flowName: "n",
            flowType: "t",
        });
        assert.deepEqual(result, { kind: "byId", flowId: "1" });
    });

    it("throws when flowName is given without flowType", () => {
        assert.throws(() => resolveFlowIdentifier({ flowName: "n" }));
    });

    it("throws when flowType is given without flowName", () => {
        assert.throws(() => resolveFlowIdentifier({ flowType: "t" }));
    });

    it("throws when neither flowId nor flowName/flowType are given", () => {
        assert.throws(() => resolveFlowIdentifier({}));
    });
});

function createFakeFlow(overrides: Partial<UpdatableFlow> = {}): UpdatableFlow {
    return {
        checkInAsync: mock.fn(() => Promise.resolve()),
        publishAsync: mock.fn(() => Promise.resolve()),
        unlockAsync: mock.fn(() => Promise.resolve()),
        ...overrides,
    };
}

function callCount(fn: unknown): number {
    return (fn as { mock: { callCount(): number } }).mock.callCount();
}

describe("applyUpdateAndSave", () => {
    it("unlocks and rethrows when mutate fails", async () => {
        const flow = createFakeFlow();
        const error = new Error("mutate failed");
        const mutate = mock.fn(() => Promise.reject(error));

        await assert.rejects(
            () => applyUpdateAndSave(flow, mutate, false),
            error,
        );
        assert.equal(callCount(flow.checkInAsync), 0);
        assert.equal(callCount(flow.publishAsync), 0);
        assert.equal(callCount(flow.unlockAsync), 1);
    });

    it("unlocks and rethrows the checkIn error, not a mutate error, when checkIn fails", async () => {
        const checkInError = new Error("checkIn failed");
        const flow = createFakeFlow({
            checkInAsync: mock.fn(() => Promise.reject(checkInError)),
        });
        const mutate = mock.fn(() => Promise.resolve());

        await assert.rejects(
            () => applyUpdateAndSave(flow, mutate, false),
            checkInError,
        );
        assert.equal(callCount(flow.unlockAsync), 1);
    });

    it("calls publishAsync, not checkInAsync, and unlocks and rethrows when publish fails", async () => {
        const publishError = new Error("publish failed");
        const flow = createFakeFlow({
            publishAsync: mock.fn(() => Promise.reject(publishError)),
        });
        const mutate = mock.fn(() => Promise.resolve());

        await assert.rejects(
            () => applyUpdateAndSave(flow, mutate, true),
            publishError,
        );
        assert.equal(callCount(flow.publishAsync), 1);
        assert.equal(callCount(flow.checkInAsync), 0);
        assert.equal(callCount(flow.unlockAsync), 1);
    });

    it("swallows a second failure from unlockAsync and still rethrows the original mutate error", async () => {
        const mutateError = new Error("mutate failed");
        const unlockError = new Error("unlock also failed");
        const flow = createFakeFlow({
            unlockAsync: mock.fn(() => Promise.reject(unlockError)),
        });
        const mutate = mock.fn(() => Promise.reject(mutateError));

        await assert.rejects(
            () => applyUpdateAndSave(flow, mutate, false),
            mutateError,
        );
        assert.equal(callCount(flow.unlockAsync), 1);
        assert.equal(
            (mutateError as Error & { unlocked?: boolean }).unlocked,
            false,
        );
    });

    it("normalizes a non-object rejection (e.g. a thrown string) into an Error carrying the unlocked signal", async () => {
        const flow = createFakeFlow();
        const mutate = mock.fn(() => Promise.reject("boom"));

        await assert.rejects(
            () => applyUpdateAndSave(flow, mutate, false),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal(err.message, "boom");
                assert.equal(
                    (err as Error & { unlocked?: boolean }).unlocked,
                    true,
                );
                return true;
            },
        );
        assert.equal(callCount(flow.unlockAsync), 1);
    });

    it("checks in on the happy path without publishing or unlocking", async () => {
        const flow = createFakeFlow();
        const mutate = mock.fn(() => Promise.resolve());

        const result = await applyUpdateAndSave(flow, mutate, false);

        assert.deepEqual(result, { unlocked: false });
        assert.equal(callCount(flow.checkInAsync), 1);
        assert.equal(callCount(flow.publishAsync), 0);
        assert.equal(callCount(flow.unlockAsync), 0);
    });

    it("publishes on the happy path without checking in or unlocking", async () => {
        const flow = createFakeFlow();
        const mutate = mock.fn(() => Promise.resolve());

        const result = await applyUpdateAndSave(flow, mutate, true);

        assert.deepEqual(result, { unlocked: false });
        assert.equal(callCount(flow.publishAsync), 1);
        assert.equal(callCount(flow.checkInAsync), 0);
        assert.equal(callCount(flow.unlockAsync), 0);
    });
});

describe("truncateContent", () => {
    it("returns the content unchanged when under the limit", () => {
        const result = truncateContent("hello", 10);
        assert.deepEqual(result, { content: "hello", truncated: false });
    });

    it("returns the content unchanged when exactly at the limit", () => {
        const result = truncateContent("hello", 5);
        assert.deepEqual(result, { content: "hello", truncated: false });
    });

    it("truncates and appends a marker when over the limit", () => {
        const content = "0123456789";
        const result = truncateContent(content, 5);

        assert.equal(result.truncated, true);
        assert.ok(result.content.startsWith("01234"));
        assert.match(
            result.content,
            /\[TRUNCATED — original size 10 chars, showing first 5\./,
        );
    });

    it("returns empty content for a non-positive maxChars, marked truncated", () => {
        assert.deepEqual(truncateContent("hello", 0), {
            content: "",
            truncated: true,
        });
        assert.deepEqual(truncateContent("hello", -5), {
            content: "",
            truncated: true,
        });
    });

    it("is not truncated when both content and maxChars are empty/zero", () => {
        assert.deepEqual(truncateContent("", 0), {
            content: "",
            truncated: false,
        });
    });
});

describe("exportFlowContent", () => {
    it("resolves with the callback's payload, not the awaited return value", async () => {
        const fakeFlow: ExportableFlow = {
            exportToObjectAsync: mock.fn(async (cb) => {
                cb({ content: "flow: yaml", fileName: "flow.yaml" });
                return undefined; // mirrors the real SDK's confirmed quirk
            }),
        };

        const result = await exportFlowContent(fakeFlow, "yaml");

        assert.deepEqual(result, {
            content: "flow: yaml",
            fileName: "flow.yaml",
        });
    });

    it("throws if the callback is never invoked", async () => {
        const fakeFlow: ExportableFlow = {
            exportToObjectAsync: mock.fn(async () => undefined),
        };

        await assert.rejects(
            () => exportFlowContent(fakeFlow, "yaml"),
            /completed without invoking its callback/,
        );
    });
});

describe("baselineFilePath", () => {
    it("builds the expected exports/<flowId>.baseline.yaml path for a safe flowId", () => {
        const result = baselineFilePath("/project/exports", "abc-123");
        assert.equal(result, join("/project/exports", "abc-123.baseline.yaml"));
    });

    it("throws when flowId contains a forward slash", () => {
        assert.throws(
            () => baselineFilePath("/project/exports", "abc/123"),
            /unsafe/i,
        );
    });

    it("throws when flowId contains a backslash", () => {
        assert.throws(
            () => baselineFilePath("/project/exports", "abc\\123"),
            /unsafe/i,
        );
    });

    it("throws when flowId contains a path-traversal segment", () => {
        assert.throws(
            () => baselineFilePath("/project/exports", "../abc123"),
            /unsafe/i,
        );
    });
});

describe("baseline envelope: writeBaselineFile / readBaselineFile / deleteBaselineFile", () => {
    async function withTempDir(
        fn: (dir: string) => Promise<void>,
    ): Promise<void> {
        const dir = await mkdtemp(join(tmpdir(), "update-helpers-test-"));
        try {
            await fn(dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    it("round-trips a BaselineEnvelope through write then read", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "flow-1.baseline.yaml");
            const envelope: BaselineEnvelope = {
                flowId: "flow-1",
                capturedAt: "2026-07-31T00:00:00.000Z",
                originalContent: "flow:\n  name: Original\n",
                requestedContent: "flow:\n  name: Requested\n",
            };

            await writeBaselineFile(filePath, envelope);
            const result = await readBaselineFile(filePath);

            assert.deepEqual(result, envelope);
        });
    });

    it("round-trips a BaselineEnvelope without requestedContent", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "flow-2.baseline.yaml");
            const envelope: BaselineEnvelope = {
                flowId: "flow-2",
                capturedAt: "2026-07-31T00:00:00.000Z",
                originalContent: "flow:\n  name: Original\n",
            };

            await writeBaselineFile(filePath, envelope);
            const result = await readBaselineFile(filePath);

            assert.deepEqual(result, envelope);
        });
    });

    it("overwrites an existing baseline file on a second write", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "flow-3.baseline.yaml");
            await writeBaselineFile(filePath, {
                flowId: "flow-3",
                capturedAt: "2026-07-31T00:00:00.000Z",
                originalContent: "flow:\n  name: First\n",
            });
            const second: BaselineEnvelope = {
                flowId: "flow-3",
                capturedAt: "2026-07-31T00:10:00.000Z",
                originalContent: "flow:\n  name: Second\n",
            };

            await writeBaselineFile(filePath, second);
            const result = await readBaselineFile(filePath);
            const raw = await readFile(filePath, "utf8");

            assert.deepEqual(result, second);
            assert.doesNotMatch(raw, /First/);
        });
    });

    it("returns undefined from readBaselineFile when the file does not exist", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "does-not-exist.baseline.yaml");
            const result = await readBaselineFile(filePath);
            assert.equal(result, undefined);
        });
    });

    it("deletes an existing baseline file", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "flow-4.baseline.yaml");
            await writeBaselineFile(filePath, {
                flowId: "flow-4",
                capturedAt: "2026-07-31T00:00:00.000Z",
                originalContent: "flow:\n  name: ToDelete\n",
            });

            await deleteBaselineFile(filePath);

            assert.equal(await readBaselineFile(filePath), undefined);
        });
    });

    it("ignores ENOENT when deleting a baseline file that does not exist", async () => {
        await withTempDir(async (dir) => {
            const filePath = join(dir, "never-existed.baseline.yaml");
            await assert.doesNotReject(() => deleteBaselineFile(filePath));
        });
    });
});

describe("diffFlowYaml", () => {
    it("returns an empty result for identical YAML", () => {
        const yaml = "flow:\n  name: Same\n  states:\n    - name: State1\n";
        const result = diffFlowYaml(yaml, yaml);
        assert.deepEqual(result, { changed: [], added: [], removed: [] });
    });

    it("detects a changed leaf value", () => {
        const baseline = "flow:\n  name: Original\n";
        const candidate = "flow:\n  name: Renamed\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.deepEqual(result.added, []);
        assert.deepEqual(result.removed, []);
        assert.equal(result.changed.length, 1);
        assert.deepEqual(result.changed[0], {
            path: "flow.name",
            oldValue: "Original",
            newValue: "Renamed",
        });
    });

    it("detects an added leaf", () => {
        const baseline = "flow:\n  name: Original\n";
        const candidate = "flow:\n  name: Original\n  description: New\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.deepEqual(result.changed, []);
        assert.deepEqual(result.removed, []);
        assert.equal(result.added.length, 1);
        assert.deepEqual(result.added[0], {
            path: "flow.description",
            newValue: "New",
        });
    });

    it("detects a removed leaf", () => {
        const baseline = "flow:\n  name: Original\n  description: Old\n";
        const candidate = "flow:\n  name: Original\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.deepEqual(result.changed, []);
        assert.deepEqual(result.added, []);
        assert.equal(result.removed.length, 1);
        assert.deepEqual(result.removed[0], {
            path: "flow.description",
            oldValue: "Old",
        });
    });

    it("detects a changed leaf inside a nested structure", () => {
        const baseline = "flow:\n  states:\n    start:\n      timeout: 10\n";
        const candidate = "flow:\n  states:\n    start:\n      timeout: 20\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.equal(result.changed.length, 1);
        assert.deepEqual(result.changed[0], {
            path: "flow.states.start.timeout",
            oldValue: 10,
            newValue: 20,
        });
    });

    it("tolerates array reordering when elements carry a stable name key", () => {
        const baseline =
            "states:\n" +
            "  - name: StateA\n    timeout: 1\n" +
            "  - name: StateB\n    timeout: 2\n";
        const candidate =
            "states:\n" +
            "  - name: StateB\n    timeout: 2\n" +
            "  - name: StateA\n    timeout: 1\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.deepEqual(result, { changed: [], added: [], removed: [] });
    });

    it("tolerates array reordering when elements carry a stable id key", () => {
        const baseline =
            "items:\n" +
            "  - id: a1\n    value: 1\n" +
            "  - id: a2\n    value: 2\n";
        const candidate =
            "items:\n" +
            "  - id: a2\n    value: 2\n" +
            "  - id: a1\n    value: 1\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.deepEqual(result, { changed: [], added: [], removed: [] });
    });

    it("falls back to index-based comparison for arrays without name/id keys, so reordering shows as a diff", () => {
        const baseline = "tags:\n  - alpha\n  - beta\n";
        const candidate = "tags:\n  - beta\n  - alpha\n";
        const result = diffFlowYaml(baseline, candidate);

        assert.equal(result.changed.length, 2);
        const paths = result.changed.map((entry) => entry.path).sort();
        assert.deepEqual(paths, ["tags[0]", "tags[1]"]);
    });
});

describe("evaluateFlowDiffGate", () => {
    it("allows publish when the confirm-time diff is clean", () => {
        const requestedDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [],
            added: [],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff);

        assert.deepEqual(result, { blocked: false, unrequestedPaths: [] });
    });

    it("allows publish when the confirm-time diff exactly matches the requested diff", () => {
        const requestedDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff);

        assert.deepEqual(result, { blocked: false, unrequestedPaths: [] });
    });

    it("blocks publish when the confirm-time diff touches a path the edit never requested", () => {
        const requestedDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
                {
                    path: "flow.description",
                    oldValue: "Old",
                    newValue: "Tampered",
                },
            ],
            added: [],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff);

        assert.equal(result.blocked, true);
        assert.deepEqual(result.unrequestedPaths, ["flow.description"]);
    });

    it("blocks publish when the requested path resolved to a different value than the edit produced", () => {
        const requestedDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "SomethingElse",
                },
            ],
            added: [],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff);

        assert.equal(result.blocked, true);
        assert.deepEqual(result.unrequestedPaths, ["flow.name"]);
    });

    it("always allows a path listed in the volatile-paths allowlist, even if untouched by the edit", () => {
        const requestedDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
            ],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [
                {
                    path: "flow.name",
                    oldValue: "Original",
                    newValue: "Renamed",
                },
                {
                    path: "flow.regeneratedStamp",
                    oldValue: "1",
                    newValue: "2",
                },
            ],
            added: [],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff, [
            "flow.regeneratedStamp",
        ]);

        assert.deepEqual(result, { blocked: false, unrequestedPaths: [] });
    });

    it("defaults volatilePaths to KNOWN_VOLATILE_FLOW_PATHS (ships empty), so nothing is silently allowed today", () => {
        assert.deepEqual(KNOWN_VOLATILE_FLOW_PATHS, []);

        const requestedDiff: FlowDiffResult = {
            changed: [],
            added: [],
            removed: [],
        };
        const confirmDiff: FlowDiffResult = {
            changed: [],
            added: [{ path: "flow.unexpected", newValue: "x" }],
            removed: [],
        };

        const result = evaluateFlowDiffGate(requestedDiff, confirmDiff);

        assert.equal(result.blocked, true);
        assert.deepEqual(result.unrequestedPaths, ["flow.unexpected"]);
    });
});
