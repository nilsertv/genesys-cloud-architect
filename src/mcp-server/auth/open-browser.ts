// Opens a URL in the user's default browser via a hand-rolled per-platform
// binary invocation — deliberately not the `open` npm package, per the
// no-new-dependency constraint on this feature.

import { execFile } from "node:child_process";

/**
 * Resolves the binary + argv to open `url` in the default browser.
 * Uses `execFile` (no shell), so the URL is passed to the OS as a single
 * argv entry — no quoting/escaping needed, and no shell-injection surface
 * regardless of what characters `url` contains.
 */
export function buildOpenInvocation(
    url: string,
    platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
    if (platform === "win32") {
        // rundll32's FileProtocolHandler opens a URL without going through
        // cmd.exe's own argument parser at all, unlike `cmd /c start`,
        // whose parser re-interprets &/|/^ in its arguments independently
        // of how execFile passed them.
        return {
            command: "rundll32",
            args: ["url.dll,FileProtocolHandler", url],
        };
    }
    return {
        command: platform === "darwin" ? "open" : "xdg-open",
        args: [url],
    };
}

/**
 * Opens `url` in the user's default browser. Never rejects — failing to
 * auto-open (e.g. a headless environment) isn't fatal to login; the user
 * can still open the URL manually.
 */
export function openBrowser(url: string): Promise<void> {
    return new Promise((resolve) => {
        const { command, args } = buildOpenInvocation(url);
        execFile(command, args, (error) => {
            if (error) {
                console.warn(
                    `Could not open browser automatically (${error.message}). Open this URL manually:\n${url}`,
                );
            }
            resolve();
        });
    });
}
