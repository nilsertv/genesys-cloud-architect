import platformClient from "purecloud-platform-client-v2";
import { getUserToken, setUserToken } from "./user-auth-state.ts";
import { isTokenExpired } from "./user-token-store.ts";

export interface ApiClientAuthConfig {
    readonly clientId?: string;
    readonly clientSecret?: string;
}

/**
 * Ensures platformClient.ApiClient.instance's access token is current before
 * a direct-API tool call. If a stored user token exists and is still valid,
 * (re-)applies it. If it exists but has expired, clears it and falls back to
 * Client Credentials when available, or throws an error directing the user
 * to run login_user. If no user token exists and Client Credentials are not
 * configured, throws an error directing the user to run login_user.
 */
export async function ensureApiClientAuth(
    config: ApiClientAuthConfig = {},
): Promise<void> {
    const userToken = getUserToken();
    const client = platformClient.ApiClient.instance;

    if (userToken) {
        if (isTokenExpired(userToken)) {
            setUserToken(undefined);
            if (config.clientId && config.clientSecret) {
                console.warn(
                    "Stored user token expired mid-session — falling back to " +
                        "Client Credentials. Run the login_user tool to refresh it.",
                );
                await client.loginClientCredentialsGrant(
                    config.clientId,
                    config.clientSecret,
                );
            } else {
                throw new Error(
                    "User session expired. Please run the login_user tool to log in again.",
                );
            }
        } else {
            client.setAccessToken(userToken.accessToken);
        }
        return;
    }

    if (config.clientId && config.clientSecret) {
        return;
    }

    throw new Error(
        "Not authenticated. Please run the login_user tool first to authenticate via browser.",
    );
}
