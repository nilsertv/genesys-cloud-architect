import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserToken } from "../auth/user-token-store.ts";
import { buildRunnerEnv } from "./runner-env.ts";

describe("buildRunnerEnv", () => {
    const baseConfig = {
        region: "sae1.pure.cloud",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
    };

    it("includes GENESYS_USER_ACCESS_TOKEN when user token is valid and unexpired", () => {
        const validToken: UserToken = {
            accessToken: "valid-bearer-token",
            region: "sae1.pure.cloud",
            expiresAt: Date.now() + 3600_000,
        };

        const env = buildRunnerEnv(
            {
                ...baseConfig,
                getUserToken: () => validToken,
            },
            { PATH: "/bin:/usr/bin" },
        );

        assert.equal(env.GENESYS_REGION, "sae1.pure.cloud");
        assert.equal(env.GENESYS_CLIENT_ID, "test-client-id");
        assert.equal(env.GENESYS_CLIENT_SECRET, "test-client-secret");
        assert.equal(env.GENESYS_USER_ACCESS_TOKEN, "valid-bearer-token");
        assert.equal(env.PATH, "/bin:/usr/bin");
    });

    it("leaves GENESYS_USER_ACCESS_TOKEN undefined when getUserToken returns undefined", () => {
        const env = buildRunnerEnv(
            {
                ...baseConfig,
                getUserToken: () => undefined,
            },
            { PATH: "/bin" },
        );

        assert.equal(env.GENESYS_REGION, "sae1.pure.cloud");
        assert.equal(env.GENESYS_CLIENT_ID, "test-client-id");
        assert.equal(env.GENESYS_CLIENT_SECRET, "test-client-secret");
        assert.equal(env.GENESYS_USER_ACCESS_TOKEN, undefined);
    });

    it("leaves GENESYS_USER_ACCESS_TOKEN undefined when token is expired", () => {
        const expiredToken: UserToken = {
            accessToken: "expired-bearer-token",
            region: "sae1.pure.cloud",
            expiresAt: Date.now() - 1000,
        };

        const env = buildRunnerEnv(
            {
                ...baseConfig,
                getUserToken: () => expiredToken,
            },
            { PATH: "/bin" },
        );

        assert.equal(env.GENESYS_USER_ACCESS_TOKEN, undefined);
    });

    it("defaults baseEnv to process.env when omitted", () => {
        const env = buildRunnerEnv({
            ...baseConfig,
            getUserToken: () => undefined,
        });

        assert.equal(env.PATH, process.env.PATH);
        assert.equal(env.GENESYS_CLIENT_ID, "test-client-id");
    });

    it("omits GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET when not provided", () => {
        const env = buildRunnerEnv(
            {
                region: "sae1.pure.cloud",
                getUserToken: () => undefined,
            },
            {},
        );

        assert.equal(env.GENESYS_REGION, "sae1.pure.cloud");
        assert.equal(env.GENESYS_CLIENT_ID, undefined);
        assert.equal(env.GENESYS_CLIENT_SECRET, undefined);
    });
});

describe("checkRunnerAuth", () => {
    it("returns ok when valid user token exists", async () => {
        const { checkRunnerAuth } = await import("./runner-env.ts");
        const validToken: UserToken = {
            accessToken: "valid-bearer-token",
            region: "sae1.pure.cloud",
            expiresAt: Date.now() + 3600_000,
        };

        const result = checkRunnerAuth({
            region: "sae1.pure.cloud",
            getUserToken: () => validToken,
        });

        assert.deepEqual(result, { ok: true });
    });

    it("returns ok when client credentials exist without user token", async () => {
        const { checkRunnerAuth } = await import("./runner-env.ts");
        const result = checkRunnerAuth({
            region: "sae1.pure.cloud",
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
            getUserToken: () => undefined,
        });

        assert.deepEqual(result, { ok: true });
    });

    it("returns ok when user token is expired but client credentials exist", async () => {
        const { checkRunnerAuth } = await import("./runner-env.ts");
        const expiredToken: UserToken = {
            accessToken: "expired-bearer-token",
            region: "sae1.pure.cloud",
            expiresAt: Date.now() - 1000,
        };

        const result = checkRunnerAuth({
            region: "sae1.pure.cloud",
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
            getUserToken: () => expiredToken,
        });

        assert.deepEqual(result, { ok: true });
    });

    it("returns error when user token is expired and no client credentials exist", async () => {
        const { checkRunnerAuth } = await import("./runner-env.ts");
        const expiredToken: UserToken = {
            accessToken: "expired-bearer-token",
            region: "sae1.pure.cloud",
            expiresAt: Date.now() - 1000,
        };

        const result = checkRunnerAuth({
            region: "sae1.pure.cloud",
            getUserToken: () => expiredToken,
        });

        assert.equal(result.ok, false);
        assert.match((result as { error: string }).error, /expired/);
    });

    it("returns error when neither user token nor client credentials exist", async () => {
        const { checkRunnerAuth } = await import("./runner-env.ts");
        const result = checkRunnerAuth({
            region: "sae1.pure.cloud",
            getUserToken: () => undefined,
        });

        assert.equal(result.ok, false);
        assert.match((result as { error: string }).error, /Not authenticated/);
    });
});
