// Persistence for the opt-in PKCE user login token — a single JSON file
// inside the project (gitignored), not under ~/.config or similar. Every
// function here is pure I/O with no dependency on the rest of the server, so
// it's independently testable via mkdtempSync/rmSync round-trips.

import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface UserToken {
    accessToken: string;
    region: string;
    expiresAt: number;
}

const TOKEN_FILE_NAME = ".genesys-user-token.json";

/** `<projectDir>/.genesys-user-token.json` — never `~/.config` or similar. */
export function resolveTokenFilePath(projectDir: string): string {
    return path.join(projectDir, TOKEN_FILE_NAME);
}

/**
 * Reads and parses the user token file at `filePath`. Never throws —
 * returns `undefined` for a missing file, corrupt JSON, or any other read
 * failure, since an unreadable token file must never prevent the MCP server
 * from starting; it just falls back to Client Credentials for the session.
 */
export async function readUserToken(
    filePath: string,
): Promise<UserToken | undefined> {
    try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw) as UserToken;
    } catch {
        return undefined;
    }
}

/**
 * Writes `token` to `filePath` as JSON, restricted to owner read/write
 * (mode 0o600). Passing `mode` to `writeFile` sets it atomically at
 * creation time, closing the brief window a write-then-chmod would leave
 * where a freshly created file carries the process umask's default
 * permissions instead. `writeFile`'s `mode` is ignored when the file
 * already exists, so the follow-up `chmod` still guarantees 0o600 when
 * overwriting a token file that predates this fix or was created by
 * something else.
 */
export async function writeUserToken(
    filePath: string,
    token: UserToken,
): Promise<void> {
    await writeFile(filePath, JSON.stringify(token, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(filePath, 0o600);
}

/** Deletes the user token file at `filePath`. Ignores ENOENT. */
export async function deleteUserToken(filePath: string): Promise<void> {
    try {
        await rm(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
}

/**
 * True when `token` is already expired, or within `skewMs` of expiring
 * (default 60s) — treated as expired slightly early so a near-expiry token
 * is never handed to a call that's about to start.
 */
export function isTokenExpired(
    token: UserToken,
    now: number = Date.now(),
    skewMs = 60_000,
): boolean {
    return now >= token.expiresAt - skewMs;
}
