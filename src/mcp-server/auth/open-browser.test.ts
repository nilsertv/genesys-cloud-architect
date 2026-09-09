import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenInvocation } from "./open-browser.ts";

describe("buildOpenInvocation", () => {
    it("builds the win32 rundll32 invocation", () => {
        assert.deepEqual(
            buildOpenInvocation("http://127.0.0.1:8917/callback", "win32"),
            {
                command: "rundll32",
                args: [
                    "url.dll,FileProtocolHandler",
                    "http://127.0.0.1:8917/callback",
                ],
            },
        );
    });

    it("builds the darwin open invocation", () => {
        assert.deepEqual(
            buildOpenInvocation("http://127.0.0.1:8917/callback", "darwin"),
            {
                command: "open",
                args: ["http://127.0.0.1:8917/callback"],
            },
        );
    });

    it("builds the xdg-open invocation for other platforms", () => {
        assert.deepEqual(
            buildOpenInvocation("http://127.0.0.1:8917/callback", "linux"),
            {
                command: "xdg-open",
                args: ["http://127.0.0.1:8917/callback"],
            },
        );
    });

    it("passes URLs with spaces and & verbatim without shell quoting", () => {
        const url = "http://127.0.0.1:8917/callback?a=1&b=two words";
        assert.deepEqual(buildOpenInvocation(url, "linux"), {
            command: "xdg-open",
            args: [url],
        });
    });

    it("passes URLs with embedded double quotes verbatim without escaping", () => {
        const url = 'http://example.com/?x="injected"';
        assert.deepEqual(buildOpenInvocation(url, "darwin"), {
            command: "open",
            args: [url],
        });
        assert.deepEqual(buildOpenInvocation(url, "win32"), {
            command: "rundll32",
            args: ["url.dll,FileProtocolHandler", url],
        });
    });
});
