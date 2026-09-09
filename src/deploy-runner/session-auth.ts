// Pure resolver for which auth mode a deploy-runner session should use.
// Kept separate from index.ts (which has module-scope side effects —
// https/console monkey-patches — that make it awkward to unit test
// directly), the same way update-helpers.ts is split out from index.ts
// there today.

export type SessionAuth =
    | { ok: true; mode: "user-token"; accessToken: string }
    | {
          ok: true;
          mode: "client-credentials";
          clientId: string;
          clientSecret: string;
      }
    | { ok: false; error: string };

/**
 * Resolves session auth from the deploy-runner subprocess's env vars.
 * `GENESYS_REGION` is always required. `GENESYS_USER_ACCESS_TOKEN` (set by
 * the MCP server's tool wrappers when a valid, non-expired user token
 * exists) wins when present; otherwise both `GENESYS_CLIENT_ID` and
 * `GENESYS_CLIENT_SECRET` are required, matching today's Client Credentials
 * behavior.
 */
export function resolveSessionAuth(env: {
    GENESYS_REGION?: string;
    GENESYS_CLIENT_ID?: string;
    GENESYS_CLIENT_SECRET?: string;
    GENESYS_USER_ACCESS_TOKEN?: string;
}): SessionAuth {
    if (!env.GENESYS_REGION) {
        return {
            ok: false,
            error: "Missing required environment variable: GENESYS_REGION",
        };
    }

    if (env.GENESYS_USER_ACCESS_TOKEN) {
        return {
            ok: true,
            mode: "user-token",
            accessToken: env.GENESYS_USER_ACCESS_TOKEN,
        };
    }

    if (env.GENESYS_CLIENT_ID && env.GENESYS_CLIENT_SECRET) {
        return {
            ok: true,
            mode: "client-credentials",
            clientId: env.GENESYS_CLIENT_ID,
            clientSecret: env.GENESYS_CLIENT_SECRET,
        };
    }

    return {
        ok: false,
        error:
            "Missing required environment variables: GENESYS_CLIENT_ID, " +
            "GENESYS_CLIENT_SECRET (or GENESYS_USER_ACCESS_TOKEN)",
    };
}
