import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    deleteUserToken,
    isTokenExpired,
    readUserToken,
    resolveTokenFilePath,
    type UserToken,
    writeUserToken,
} from "./user-token-store.ts";

describe("resolveTokenFilePath", () => {
    it("joins the project dir with the fixed token file name", () => {
        assert.equal(
            resolveTokenFilePath("/some/project"),
            "/some/project/.genesys-user-token.json",
        );
    });
});

describe("isTokenExpired", () => {
    const token: UserToken = {
        accessToken: "a",
        region: "mypurecloud.com",
        expiresAt: 1_000_000,
    };

    it("is not expired well before the skew boundary", () => {
        assert.equal(isTokenExpired(token, 900_000, 60_000), false);
    });

    it("is expired exactly at the skew boundary", () => {
        assert.equal(isTokenExpired(token, 940_000, 60_000), true);
    });

    it("is expired after the skew boundary", () => {
        assert.equal(isTokenExpired(token, 999_999, 60_000), true);
    });
});

describe("readUserToken / writeUserToken / deleteUserToken", () => {
    it("round-trips a token through the filesystem", async () => {
        const dir = mkdtempSync(join(tmpdir(), "user-token-store-test-"));
        const filePath = join(dir, "token.json");
        try {
            const token: UserToken = {
                accessToken: "abc123",
                region: "mypurecloud.com",
                expiresAt: 123456,
            };
            await writeUserToken(filePath, token);
            const read = await readUserToken(filePath);
            assert.deepEqual(read, token);

            await deleteUserToken(filePath);
            assert.equal(await readUserToken(filePath), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns undefined for a missing file", async () => {
        const result = await readUserToken("/nonexistent/path/token.json");
        assert.equal(result, undefined);
    });

    it("returns undefined for corrupt JSON", async () => {
        const dir = mkdtempSync(join(tmpdir(), "user-token-store-test-"));
        const filePath = join(dir, "token.json");
        try {
            writeFileSync(filePath, "not json{{{");
            const result = await readUserToken(filePath);
            assert.equal(result, undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("deleteUserToken ignores a missing file", async () => {
        await assert.doesNotReject(() =>
            deleteUserToken("/nonexistent/path/token.json"),
        );
    });
});
