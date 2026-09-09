// Opens a URL in the user's default browser via a hand-rolled per-platform
// shell command — deliberately not the `open` npm package, per the
// no-new-dependency constraint on this feature.

import { exec } from "node:child_process";

/**
 * Builds the shell command to open `url` in the default browser. Quotes the
 * URL for the target platform's shell and escapes any embedded double quote
 * so the URL can never break out of that quoting.
 */
export function buildOpenCommand(
    url: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform === "win32") {
        // cmd.exe: a literal `"` inside a quoted argument is escaped by
        // doubling it. The empty `""` first argument to `start` is the
        // window title — required so a URL isn't mistaken for one.
        return `start "" "${url.replace(/"/g, '""')}"`;
    }

    // POSIX shells (`/bin/sh`, used by child_process.exec): escape `"` with
    // a backslash inside a double-quoted string.
    const escaped = url.replace(/"/g, '\\"');
    return platform === "darwin"
        ? `open "${escaped}"`
        : `xdg-open "${escaped}"`;
}

/**
 * Opens `url` in the user's default browser. Never rejects — failing to
 * auto-open (e.g. a headless environment) isn't fatal to login; the user
 * can still open the URL manually.
 */
export function openBrowser(url: string): Promise<void> {
    return new Promise((resolve) => {
        exec(buildOpenCommand(url), (error) => {
            if (error) {
                console.warn(
                    `Could not open browser automatically (${error.message}). Open this URL manually:\n${url}`,
                );
            }
            resolve();
        });
    });
}
