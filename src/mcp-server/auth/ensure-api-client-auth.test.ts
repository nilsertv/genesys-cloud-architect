import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import platformClient from "purecloud-platform-client-v2";
import { ensureApiClientAuth } from "./ensure-api-client-auth.ts";
import { getUserToken, setUserToken } from "./user-auth-state.ts";
import type { UserToken } from "./user-token-store.ts";

afterEach(() => {
    setUserToken(undefined);
    mock.reset();
});

describe("ensureApiClientAuth", () => {
    it("is a no-op when no user token is stored", async () => {
        setUserToken(undefined);
        const client = platformClient.ApiClient.instance;
        const setAccessToken = mock.method(client, "setAccessToken", () => {});
        const loginClientCredentialsGrant = mock.method(
            client,
            "loginClientCredentialsGrant",
            async () => {},
        );

        await ensureApiClientAuth({
            clientId: "id",
            clientSecret: "secret",
        });

        assert.equal(setAccessToken.mock.calls.length, 0);
        assert.equal(loginClientCredentialsGrant.mock.calls.length, 0);
    });

    it("applies a valid stored token via setAccessToken", async () => {
        const token: UserToken = {
            accessToken: "valid-token",
            region: "mypurecloud.com",
            expiresAt: Date.now() + 3_600_000,
        };
        setUserToken(token);
        const client = platformClient.ApiClient.instance;
        const setAccessToken = mock.method(client, "setAccessToken", () => {});
        const loginClientCredentialsGrant = mock.method(
            client,
            "loginClientCredentialsGrant",
            async () => {},
        );

        await ensureApiClientAuth({
            clientId: "id",
            clientSecret: "secret",
        });

        assert.equal(setAccessToken.mock.calls.length, 1);
        assert.equal(setAccessToken.mock.calls[0]?.arguments[0], "valid-token");
        assert.equal(loginClientCredentialsGrant.mock.calls.length, 0);
    });

    it("falls back to Client Credentials and clears an expired token", async () => {
        const token: UserToken = {
            accessToken: "expired-token",
            region: "mypurecloud.com",
            expiresAt: Date.now() - 3_600_000,
        };
        setUserToken(token);
        const client = platformClient.ApiClient.instance;
        const setAccessToken = mock.method(client, "setAccessToken", () => {});
        const loginClientCredentialsGrant = mock.method(
            client,
            "loginClientCredentialsGrant",
            async () => {},
        );

        await ensureApiClientAuth({
            clientId: "test-client-id",
            clientSecret: "test-client-secret",
        });

        assert.equal(getUserToken(), undefined);
        assert.equal(loginClientCredentialsGrant.mock.calls.length, 1);
        assert.deepEqual(loginClientCredentialsGrant.mock.calls[0]?.arguments, [
            "test-client-id",
            "test-client-secret",
        ]);
        assert.equal(setAccessToken.mock.calls.length, 0);
    });
});
