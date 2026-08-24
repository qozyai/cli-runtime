"use strict";

// Real screens, captured from one live authentication event on 2026-08-24 and
// sanitized by hand (spec 0022). These prove the deterministic layer against
// what the providers actually draw, not against what we remember them drawing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isAuthRequired, isStartupAuthScreen, startupScreenAction } = require("../src/drivers/drivers");
const { AuthManager } = require("../src/drivers/auth-manager");

const manager = new AuthManager({ config: { stateDir: "/tmp" }, tmux: {}, eventStore: {} });
const frame = (name) => fs.readFileSync(path.join(__dirname, "..", "fixtures", "screens", name), "utf8");

test("claude first-run screens resolve deterministically", () => {
  assert.equal(startupScreenAction("claude", frame("claude/01-theme.txt")), "Enter");
  assert.equal(isStartupAuthScreen("claude", frame("claude/02-login-method.txt")), true);
  assert.equal(isAuthRequired("claude", frame("claude/02-login-method.txt")), true);
  assert.equal(startupScreenAction("claude", frame("claude/05-fullscreen-renderer.txt")), "2");
});

test("claude auth prompts parse from real frames", () => {
  const awaiting = manager.parseAuthPrompt("claude", frame("claude/03-oauth-url.txt"));
  assert.equal(awaiting.phase, "awaiting_code");
  assert.match(awaiting.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.match(awaiting.url, /scope=org%3Acreate_api_key/, "the wrapped URL is reassembled whole");
  assert.equal(manager.parseAuthPrompt("claude", frame("claude/04-login-successful.txt")).phase, "completed");
  // The logout frame still carries "Login successful" in its scrollback, so it
  // parses as completed. Documented, not fixed: a real auth attempt always
  // starts from a freshly created pane with no scrollback, and reading recency
  // out of one frame is not worth the complexity today.
  assert.equal(manager.parseAuthPrompt("claude", frame("claude/06-logged-out.txt")).phase, "completed");
});

test("codex auth prompts parse from real frames", () => {
  const device = manager.parseAuthPrompt("codex", frame("codex/01-device-code.txt"));
  assert.equal(device.phase, "awaiting_browser");
  assert.equal(device.url, "https://auth.openai.com/codex/device");
  assert.equal(device.code, "ABCD-EFGH");
  assert.equal(manager.parseAuthPrompt("codex", frame("codex/02-after-login.txt")).phase, "completed");
});
