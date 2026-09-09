import { createServer } from "node:http";
import platformClient from "purecloud-platform-client-v2";
import { openBrowser } from "../auth/open-browser.ts";
import {
    buildAuthorizeUrl,
    buildTokenExchangeRequest,
    codeChallengeFromVerifier,
    generateCodeVerifier,
    generateState,
    parseCallbackQuery,
    parseExpiresAt,
} from "../auth/pkce.ts";
import { setUserToken } from "../auth/user-auth-state.ts";
import { writeUserToken } from "../auth/user-token-store.ts";
import type { ToolFactory } from "./types.ts";

const LOGIN_TIMEOUT_MS = 300_000;
const DEFAULT_REDIRECT_PORT = 8917;

export interface LoginUserConfig {
    readonly region: string;
    readonly pkceClientId: string;
    readonly pkceClientSecret?: string;
    readonly tokenFilePath: string;
}

export const loginUser: ToolFactory<LoginUserConfig> = (toolConfig) => ({
    config: {
        description:
            "Logs in to Genesys Cloud as YOURSELF via a browser (PKCE OAuth), " +
            "instead of the shared Client Credentials service account used by " +
            "default. Opens your default browser to the Genesys Cloud login " +
            "page; on success the token is saved locally and " +
            "deploy_flow/update_flow/read_flow automatically use it on their " +
            "NEXT call — no server restart needed.",
        annotations: {
            title: "Login as User",
            readOnlyHint: false,
            destructiveHint: false,
        },
        inputSchema: {},
    },
    handler: async () => {
        const port =
            Number(process.env.GENESYS_PKCE_REDIRECT_PORT) ||
            DEFAULT_REDIRECT_PORT;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const codeVerifier = generateCodeVerifier();
        const codeChallenge = codeChallengeFromVerifier(codeVerifier);
        const state = generateState();

        const authorizeUrl = buildAuthorizeUrl({
            region: toolConfig.region,
            clientId: toolConfig.pkceClientId,
            redirectUri,
            codeChallenge,
            state,
        });

        return new Promise((resolve) => {
            let settled = false;

            const settle = (value: {
                isError?: boolean;
                content: Array<{ type: "text"; text: string }>;
            }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                server.close();
                resolve(value);
            };

            const timer = setTimeout(() => {
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for the browser callback.`,
                        },
                    ],
                });
            }, LOGIN_TIMEOUT_MS);

            const server = createServer((req, res) => {
                const requestUrl = new URL(
                    req.url ?? "/",
                    `http://127.0.0.1:${port}`,
                );
                if (requestUrl.pathname !== "/callback") {
                    res.writeHead(404).end();
                    return;
                }

                const parsed = parseCallbackQuery(
                    requestUrl.searchParams,
                    state,
                );
                if (!parsed.ok) {
                    res.writeHead(400, { "Content-Type": "text/plain" }).end(
                        `Login failed: ${parsed.error}`,
                    );
                    settle({
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Login failed: ${parsed.error}`,
                            },
                        ],
                    });
                    return;
                }

                const tokenRequest = buildTokenExchangeRequest({
                    region: toolConfig.region,
                    clientId: toolConfig.pkceClientId,
                    clientSecret: toolConfig.pkceClientSecret,
                    code: parsed.code,
                    redirectUri,
                    codeVerifier,
                });

                fetch(tokenRequest.url, {
                    method: tokenRequest.method,
                    headers: tokenRequest.headers,
                    body: tokenRequest.body,
                })
                    .then(async (tokenResponse) => {
                        if (!tokenResponse.ok) {
                            const body = await tokenResponse.text();
                            throw new Error(
                                `Token exchange failed (HTTP ${tokenResponse.status}): ${body}`,
                            );
                        }
                        return tokenResponse.json() as Promise<{
                            access_token: string;
                            expires_in: number;
                        }>;
                    })
                    .then(async (tokenData) => {
                        const token = {
                            accessToken: tokenData.access_token,
                            region: toolConfig.region,
                            expiresAt: parseExpiresAt(tokenData.expires_in),
                        };
                        await writeUserToken(toolConfig.tokenFilePath, token);
                        setUserToken(token);
                        platformClient.ApiClient.instance.setAccessToken(
                            token.accessToken,
                        );

                        res.writeHead(200, {
                            "Content-Type": "text/html",
                        }).end(
                            "<html><body>Login successful — you can close this tab.</body></html>",
                        );
                        settle({
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "Logged in successfully. deploy_flow, update_flow, and " +
                                        "read_flow will use this token automatically on their " +
                                        "next call — no restart needed.",
                                },
                            ],
                        });
                    })
                    .catch((err: unknown) => {
                        const message =
                            err instanceof Error ? err.message : String(err);
                        res.writeHead(500, {
                            "Content-Type": "text/plain",
                        }).end(`Login failed: ${message}`);
                        settle({
                            isError: true,
                            content: [
                                {
                                    type: "text",
                                    text: `Login failed: ${message}`,
                                },
                            ],
                        });
                    });
            });

            server.on("error", (err: NodeJS.ErrnoException) => {
                const message =
                    err.code === "EADDRINUSE"
                        ? `Port ${port} is already in use. Set GENESYS_PKCE_REDIRECT_PORT to a free port — it must also match the redirect URI registered for the PKCE client in Genesys Admin.`
                        : `Failed to start local callback server: ${err.message}`;
                settle({
                    isError: true,
                    content: [{ type: "text", text: message }],
                });
            });

            server.listen(port, "127.0.0.1", () => {
                void openBrowser(authorizeUrl);
            });
        });
    },
});
