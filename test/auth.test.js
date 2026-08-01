"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthManager, terminalUrls } = require("../src/auth-manager");

test("auth navigation recognizes wrapped current provider URLs", () => {
  const claude = [
    "Browser did not open. Use the url below:",
    "https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.co",
    "m%2Foauth%2Fcode%2Fcallback&state=xyz",
    "",
    "Paste code here >",
  ].join("\n");
  const codex = "Open https://auth.openai.com/codex/device and enter ABCD-EFGH";
  const manager = new AuthManager({ config: { stateDir: "/tmp" }, tmux: {}, eventStore: {} });

  assert.equal(terminalUrls(claude)[0], "https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz");
  assert.equal(manager.parseAuthPrompt("claude", claude).phase, "awaiting_code");
  assert.equal(manager.parseAuthPrompt("codex", codex).phase, "awaiting_browser");
  assert.equal(manager.parseAuthPrompt("codex", codex).code, "ABCD-EFGH");
});
