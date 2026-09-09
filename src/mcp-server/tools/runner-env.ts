import { isTokenExpired, type UserToken } from "../auth/user-token-store.ts";

export interface RunnerAuthConfig {
    readonly region: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly getUserToken: () => UserToken | undefined;
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
        GENESYS_CLIENT_ID: config.clientId,
        GENESYS_CLIENT_SECRET: config.clientSecret,
        GENESYS_USER_ACCESS_TOKEN: userAccessToken,
    };
}
