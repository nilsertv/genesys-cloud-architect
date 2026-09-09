import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSessionAuth } from "./session-auth.ts";

describe("resolveSessionAuth", () => {
    it("returns user-token mode when GENESYS_USER_ACCESS_TOKEN is present", () => {
        const result = resolveSessionAuth({
            GENESYS_REGION: "mypurecloud.com",
            GENESYS_USER_ACCESS_TOKEN: "user-token-abc",
        });
        assert.deepEqual(result, {
            ok: true,
            mode: "user-token",
            accessToken: "user-token-abc",
        });
    });

    it("returns client-credentials mode when client id and secret are complete", () => {
        const result = resolveSessionAuth({
            GENESYS_REGION: "mypurecloud.com",
            GENESYS_CLIENT_ID: "id",
            GENESYS_CLIENT_SECRET: "secret",
        });
        assert.deepEqual(result, {
            ok: true,
            mode: "client-credentials",
            clientId: "id",
            clientSecret: "secret",
        });
    });

    it("prefers user-token mode when both are present", () => {
        const result = resolveSessionAuth({
            GENESYS_REGION: "mypurecloud.com",
            GENESYS_CLIENT_ID: "id",
            GENESYS_CLIENT_SECRET: "secret",
            GENESYS_USER_ACCESS_TOKEN: "user-token-abc",
        });
        assert.equal(result.ok, true);
        assert.equal(result.ok && result.mode, "user-token");
    });

    it("fails when GENESYS_REGION is missing", () => {
        const result = resolveSessionAuth({
            GENESYS_CLIENT_ID: "id",
            GENESYS_CLIENT_SECRET: "secret",
        });
        assert.equal(result.ok, false);
    });

    it("fails when neither a user token nor complete client credentials are present", () => {
        const result = resolveSessionAuth({
            GENESYS_REGION: "mypurecloud.com",
            GENESYS_CLIENT_ID: "id",
        });
        assert.equal(result.ok, false);
    });
});
