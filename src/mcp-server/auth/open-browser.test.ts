import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCommand } from "./open-browser.ts";

describe("buildOpenCommand", () => {
    it("builds the win32 start command", () => {
        assert.equal(
            buildOpenCommand("http://127.0.0.1:8917/callback", "win32"),
            'start "" "http://127.0.0.1:8917/callback"',
        );
    });

    it("builds the darwin open command", () => {
        assert.equal(
            buildOpenCommand("http://127.0.0.1:8917/callback", "darwin"),
            'open "http://127.0.0.1:8917/callback"',
        );
    });

    it("builds the xdg-open command for other platforms", () => {
        assert.equal(
            buildOpenCommand("http://127.0.0.1:8917/callback", "linux"),
            'xdg-open "http://127.0.0.1:8917/callback"',
        );
    });

    it("safely quotes a URL containing spaces and &", () => {
        const url = "http://127.0.0.1:8917/callback?a=1&b=two words";
        assert.equal(buildOpenCommand(url, "linux"), `xdg-open "${url}"`);
    });

    it("escapes embedded double quotes for POSIX shells", () => {
        const url = 'http://example.com/?x="injected"';
        assert.equal(
            buildOpenCommand(url, "darwin"),
            'open "http://example.com/?x=\\"injected\\""',
        );
    });

    it("escapes embedded double quotes for cmd.exe", () => {
        const url = 'http://example.com/?x="injected"';
        assert.equal(
            buildOpenCommand(url, "win32"),
            'start "" "http://example.com/?x=""injected"""',
        );
    });
});
