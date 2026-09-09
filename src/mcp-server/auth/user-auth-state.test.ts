import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getUserToken, setUserToken } from "./user-auth-state.ts";
import type { UserToken } from "./user-token-store.ts";

describe("user-auth-state", () => {
    it("returns undefined before any token is set", () => {
        setUserToken(undefined);
        assert.equal(getUserToken(), undefined);
    });

    it("round-trips a set token", () => {
        const token: UserToken = {
            accessToken: "abc",
            region: "mypurecloud.com",
            expiresAt: 123,
        };
        setUserToken(token);
        assert.deepEqual(getUserToken(), token);
    });

    it("clears back to undefined", () => {
        setUserToken(undefined);
        assert.equal(getUserToken(), undefined);
    });
});
