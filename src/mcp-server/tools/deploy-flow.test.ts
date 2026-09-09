import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deployFlow } from "./deploy-flow.ts";

// Regression test for the child.on("error", ...) handler: previously, if
// spawn() itself failed (e.g. the "node" binary can't be located), the
// returned promise never settled and the tool hung until DEPLOY_TIMEOUT_MS
// (120s) instead of failing fast. Emptying PATH makes spawn("node", ...)
// fail deterministically with ENOENT, exercising that path without waiting
// for the real timeout.
describe("deploy_flow — spawn failure", () => {
    it("fails fast instead of hanging until the timeout when spawn errors", async () => {
        const dir = mkdtempSync(join(tmpdir(), "deploy-flow-test-"));
        const flowFile = join(dir, "flow.ts");
        writeFileSync(flowFile, "export async function buildFlow() {}");

        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
            const tool = deployFlow({
                deployScriptPath: "/fake/deploy-runner.js",
                region: "us_east_1",
                clientId: "fake-client-id",
                clientSecret: "fake-client-secret",
            });

            const result = await tool.handler({ flowFile });

            assert.equal(result.isError, true);
            const text = result.content[0]?.text ?? "";
            assert.match(text, /Failed to start deploy runner/);
        } finally {
            process.env.PATH = originalPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
