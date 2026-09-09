// Pure PKCE/OAuth helpers for the opt-in user-login flow (login-user.ts).
// No side effects — every function here is independently unit-testable
// without a real Genesys Cloud org, a browser, or a loopback HTTP server.

import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 code verifier — 32 random bytes, base64url-encoded (43 chars). */
export function generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
}

/** Random CSRF-protection state value for the authorize request. */
export function generateState(): string {
    return randomBytes(16).toString("base64url");
}

/** RFC 7636 S256 code challenge: SHA-256 of the verifier, base64url-encoded. */
export function codeChallengeFromVerifier(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Builds the `/oauth/authorize` URL to open in the user's browser.
 * Login host is `login.<region>` — `region` is the same full API domain
 * string (e.g. "mypurecloud.com") used elsewhere in this project, not just
 * a short code.
 */
export function buildAuthorizeUrl(params: {
    region: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
}): string {
    const url = new URL(`https://login.${params.region}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", params.state);
    return url.toString();
}

export interface TokenExchangeRequest {
    url: string;
    method: "POST";
    headers: Record<string, string>;
    body: string;
}

/**
 * Builds a `fetch`-ready `authorization_code` token exchange request.
 *
 * `clientSecret` is optional: a PKCE OAuth client in Genesys Cloud may or
 * may not require one. When given, it's sent as HTTP Basic auth; when
 * absent, the `Authorization` header is omitted entirely rather than
 * guessing.
 */
export function buildTokenExchangeRequest(params: {
    region: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
}): TokenExchangeRequest {
    const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
    };
    if (params.clientSecret) {
        const basic = Buffer.from(
            `${params.clientId}:${params.clientSecret}`,
        ).toString("base64");
        headers.Authorization = `Basic ${basic}`;
    }

    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: params.clientId,
        code_verifier: params.codeVerifier,
    }).toString();

    return {
        url: `https://login.${params.region}/oauth/token`,
        method: "POST",
        headers,
        body,
    };
}

/** Converts an OAuth `expires_in` (seconds) into an absolute epoch-ms expiry. */
export function parseExpiresAt(
    expiresIn: number,
    now: number = Date.now(),
): number {
    return now + expiresIn * 1000;
}

export type CallbackQueryResult =
    | { ok: true; code: string }
    | { ok: false; error: string };

/**
 * Parses and validates the PKCE redirect callback's query string: rejects a
 * provider-reported `error`, a `state` that doesn't match what we generated
 * (CSRF protection), and a missing `code`.
 */
export function parseCallbackQuery(
    searchParams: URLSearchParams,
    expectedState: string,
): CallbackQueryResult {
    const error = searchParams.get("error");
    if (error) {
        return {
            ok: false,
            error: `Authorization server returned an error: ${error}`,
        };
    }

    const state = searchParams.get("state");
    if (state !== expectedState) {
        return {
            ok: false,
            error: "State mismatch on callback — possible CSRF, aborting login.",
        };
    }

    const code = searchParams.get("code");
    if (!code) {
        return {
            ok: false,
            error: "Callback is missing the authorization code.",
        };
    }

    return { ok: true, code };
}
