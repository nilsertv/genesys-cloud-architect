import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildAuthorizeUrl,
    buildTokenExchangeRequest,
    codeChallengeFromVerifier,
    parseCallbackQuery,
    parseExpiresAt,
} from "./pkce.ts";

describe("codeChallengeFromVerifier", () => {
    it("matches the published RFC 7636 test vector", () => {
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert.equal(codeChallengeFromVerifier(verifier), expected);
    });
});

describe("buildAuthorizeUrl", () => {
    it("includes all required query params against the login host", () => {
        const url = new URL(
            buildAuthorizeUrl({
                region: "mypurecloud.com",
                clientId: "client-1",
                redirectUri: "http://127.0.0.1:8917/callback",
                codeChallenge: "challenge-1",
                state: "state-1",
            }),
        );
        assert.equal(url.hostname, "login.mypurecloud.com");
        assert.equal(url.pathname, "/oauth/authorize");
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(url.searchParams.get("client_id"), "client-1");
        assert.equal(
            url.searchParams.get("redirect_uri"),
            "http://127.0.0.1:8917/callback",
        );
        assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("state"), "state-1");
    });
});

describe("buildTokenExchangeRequest", () => {
    const baseParams = {
        region: "mypurecloud.com",
        clientId: "client-1",
        code: "auth-code",
        redirectUri: "http://127.0.0.1:8917/callback",
        codeVerifier: "verifier-1",
    };

    it("omits the Authorization header when clientSecret is absent", () => {
        const req = buildTokenExchangeRequest(baseParams);
        assert.equal(req.url, "https://login.mypurecloud.com/oauth/token");
        assert.equal(req.method, "POST");
        assert.equal(req.headers.Authorization, undefined);

        const body = new URLSearchParams(req.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "auth-code");
        assert.equal(body.get("redirect_uri"), baseParams.redirectUri);
        assert.equal(body.get("client_id"), "client-1");
        assert.equal(body.get("code_verifier"), "verifier-1");
    });

    it("sets a Basic Authorization header when clientSecret is given", () => {
        const req = buildTokenExchangeRequest({
            ...baseParams,
            clientSecret: "shh",
        });
        assert.equal(
            req.headers.Authorization,
            `Basic ${Buffer.from("client-1:shh").toString("base64")}`,
        );
    });
});

describe("parseExpiresAt", () => {
    it("adds expiresIn seconds (as ms) to now", () => {
        assert.equal(parseExpiresAt(3600, 1_000_000), 1_000_000 + 3_600_000);
    });

    it("throws for NaN", () => {
        assert.throws(() => parseExpiresAt(NaN, 1_000_000));
    });

    it("throws for Infinity", () => {
        assert.throws(() => parseExpiresAt(Infinity, 1_000_000));
    });

    it("throws for zero", () => {
        assert.throws(() => parseExpiresAt(0, 1_000_000));
    });

    it("throws for a negative number", () => {
        assert.throws(() => parseExpiresAt(-60, 1_000_000));
    });
});

describe("parseCallbackQuery", () => {
    const state = "expected-state";

    it("returns the code on a valid callback", () => {
        const params = new URLSearchParams({ code: "abc", state });
        assert.deepEqual(parseCallbackQuery(params, state), {
            ok: true,
            code: "abc",
        });
    });

    it("fails on state mismatch", () => {
        const params = new URLSearchParams({ code: "abc", state: "wrong" });
        const result = parseCallbackQuery(params, state);
        assert.equal(result.ok, false);
    });

    it("fails when the provider returns an error param", () => {
        const params = new URLSearchParams({ error: "access_denied", state });
        const result = parseCallbackQuery(params, state);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /access_denied/);
    });

    it("fails when the code is missing", () => {
        const params = new URLSearchParams({ state });
        const result = parseCallbackQuery(params, state);
        assert.equal(result.ok, false);
    });
});
