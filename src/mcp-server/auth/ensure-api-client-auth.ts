import platformClient from "purecloud-platform-client-v2";
import { getUserToken, setUserToken } from "./user-auth-state.ts";
import { isTokenExpired } from "./user-token-store.ts";

export interface ApiClientAuthConfig {
    readonly clientId: string;
    readonly clientSecret: string;
}

/**
 * Ensures platformClient.ApiClient.instance's access token is current before
 * a direct-API tool call. If a stored user token exists and is still valid,
 * (re-)applies it — cheap, covers the case a fresher token.setAccessToken
 * call from login_user happened since this tool's last invocation. If it
 * exists but has expired, clears it and falls back to Client Credentials —
 * this is the check deploy_flow/update_flow/read_flow already do per call;
 * the 7 tools that talk to the SDK's shared singleton directly never had an
 * equivalent check, so a stale PKCE token left them 401ing indefinitely with
 * no fallback. If no user token is stored at all, this is a no-op — matches
 * this project's pre-PKCE behavior exactly.
 */
export async function ensureApiClientAuth(
    config: ApiClientAuthConfig,
): Promise<void> {
    const userToken = getUserToken();
    if (!userToken) return;

    const client = platformClient.ApiClient.instance;
    if (isTokenExpired(userToken)) {
        setUserToken(undefined);
        console.warn(
            "Stored user token expired mid-session — falling back to " +
                "Client Credentials. Run the login_user tool to refresh it.",
        );
        await client.loginClientCredentialsGrant(
            config.clientId,
            config.clientSecret,
        );
    } else {
        client.setAccessToken(userToken.accessToken);
    }
}
