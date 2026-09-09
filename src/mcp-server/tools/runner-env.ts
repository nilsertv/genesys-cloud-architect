import { isTokenExpired, type UserToken } from "../auth/user-token-store.ts";

export interface RunnerAuthConfig {
    readonly region: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly getUserToken: () => UserToken | undefined;
}

/**
 * Validates that either a valid user token exists, or Client Credentials are provided.
 */
export function checkRunnerAuth(
    config: RunnerAuthConfig,
): { ok: true } | { ok: false; error: string } {
    const userToken = config.getUserToken();
    if (userToken) {
        if (isTokenExpired(userToken)) {
            if (config.clientId && config.clientSecret) {
                return { ok: true };
            }
            return {
                ok: false,
                error: "User session expired. Please run the login_user tool to log in again.",
            };
        }
        return { ok: true };
    }

    if (config.clientId && config.clientSecret) {
        return { ok: true };
    }

    return {
        ok: false,
        error: "Not authenticated. Please run the login_user tool first to authenticate via browser.",
    };
}

/**
 * Builds the environment variables passed to the deploy-runner child process.
 *
 * Forwards the user's OAuth access token if present and non-expired; otherwise
 * leaves GENESYS_USER_ACCESS_TOKEN undefined so the child process falls back to
 * Client Credentials. Inherits process.env so Node and system configuration
 * (e.g. PATH, HTTP proxy, NODE_EXTRA_CA_CERTS) propagate cleanly.
 */
export function buildRunnerEnv(
    config: RunnerAuthConfig,
    baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const userToken = config.getUserToken();
    const userAccessToken =
        userToken && !isTokenExpired(userToken)
            ? userToken.accessToken
            : undefined;

    return {
        ...baseEnv,
        GENESYS_REGION: config.region,
        ...(config.clientId ? { GENESYS_CLIENT_ID: config.clientId } : {}),
        ...(config.clientSecret
            ? { GENESYS_CLIENT_SECRET: config.clientSecret }
            : {}),
        GENESYS_USER_ACCESS_TOKEN: userAccessToken,
    };
}
