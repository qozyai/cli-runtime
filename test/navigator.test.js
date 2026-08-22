"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Navigator, normalizeDecision } = require("../src/drivers/navigator");
const { EventStore } = require("../src/core/event-store");
const { Tmux } = require("../src/drivers/tmux");
const { SessionManager } = require("../src/core/session-manager");

test("navigator exposes a bounded driver-neutral recovery contract", async () => {
  let requestBody = null;
  const navigator = new Navigator({
    config: { navigator: { url: "http://navigator.test/decide", apiKey: "secret", timeoutMs: 1000 } },
    eventStore: { append: async () => {} },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ action: "press_key", key: "Enter", reason: "confirm known prompt" }) };
    },
  });
  const decision = await navigator.decide({
    driver: "codex",
    phase: "session_start",
    goal: "reach prompt",
    screen: "unknown screen sk-secretsecretsecret",
    sessionKey: "private-route-key",
  });
  assert.deepEqual(decision, { action: "press_key", key: "Enter", reason: "confirm known prompt" });
  assert.equal(requestBody.driver, "codex");
  assert.equal("sessionKey" in requestBody, false);
  assert.doesNotMatch(requestBody.screen, /sk-secret/);
  assert.ok(requestBody.allowedActions.press_key.keys.includes("Escape"));
  assert.throws(() => normalizeDecision({ action: "press_key", key: "C-z" }), /unsupported key/);
  assert.throws(() => normalizeDecision({ action: "submit_text", text: "a\nb" }), /invalid text/);
  assert.throws(() => normalizeDecision({ action: "submit_text", text: "a\u001bb" }), /invalid text/);
});

test("navigator redacts before taking the bounded screen tail", async () => {
  let requestBody = null;
  const navigator = new Navigator({
    config: { navigator: { url: "http://navigator.test/decide", apiKey: "", timeoutMs: 1000 } },
    eventStore: { append: async () => {} },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ action: "wait", reason: "observe" }) };
    },
  });
  const token = `sk-${"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}`;
  await navigator.decide({
    driver: "claude",
    phase: "session_start",
    goal: "reach prompt",
    screen: `${token}${"x".repeat(3990)}`,
  });
  assert.doesNotMatch(requestBody.screen, /1234567890/);
});

test("navigator uses the direct OpenAI helper when no endpoint is configured", async () => {
  let payload = null;
  const navigator = new Navigator({
    config: { navigator: { url: "", apiKey: "", timeoutMs: 1000, useOpenAI: true } },
    eventStore: { append: async () => {} },
    openaiHelper: {
      enabled: true,
      navigationDecision: async (value) => {
        payload = value;
        return { action: "auth_required", key: null, text: null, reason: "login screen" };
      },
    },
  });
  const decision = await navigator.decide({ driver: "claude", phase: "auth", goal: "authenticate", screen: "Login required" });
  assert.deepEqual(decision, { action: "auth_required", reason: "login screen" });
  assert.equal(payload.driver, "claude");
  assert.equal(payload.allowedActions.submit_text.maxChars, 256);
});

test("an unwritable event log does not discard a navigation decision", async () => {
  const navigator = new Navigator({
    config: { navigator: { url: "http://navigator.test/decide", apiKey: "", timeoutMs: 1000 } },
    eventStore: { append: async () => { throw new Error("event log unwritable"); } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ action: "press_key", key: "Enter", reason: "continue" }) }),
  });
  const decision = await navigator.decide({
    driver: "claude",
    phase: "session_start",
    goal: "reach prompt",
    screen: "unknown dialog",
  });
  assert.equal(decision.action, "press_key");
});

test("an OpenAI key does not implicitly enable terminal navigation", () => {
  const navigator = new Navigator({
    config: { navigator: { url: "", apiKey: "", timeoutMs: 1000, useOpenAI: false } },
    openaiHelper: { enabled: true },
  });
  assert.equal(navigator.enabled, false);
});

test("unknown startup screens use navigator fallback and reach ready", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-navigator-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    tmuxSocketName: `cli-runtime-navigator-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 6000,
    submissionTimeoutMs: 5000,
    artifactPollMs: 25,
    navigator: { url: "http://navigator.test/decide", apiKey: "", timeoutMs: 1000 },
    drivers: {
      claude: { command: mockDriver, homeDir: home, model: "", permissionMode: "bypassPermissions", extraArgs: ["--startup-gate"] },
      codex: { command: mockDriver, homeDir: home, model: "", sandbox: "danger-full-access", approval: "never", extraArgs: [] },
    },
  };
  const eventStore = new EventStore(config.stateDir);
  await eventStore.init();
  const tmux = new Tmux(config.tmuxSocketName);
  let calls = 0;
  const navigator = new Navigator({
    config,
    eventStore,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ action: "submit_text", text: "7", reason: "continue unknown setup" }) };
    },
  });
  const sessions = new SessionManager({ config, tmux, eventStore, navigator });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  const created = await sessions.create({ sessionKey: "unknown", driver: "claude", workspace });
  assert.equal(created.status, "ready");
  assert.equal(calls, 1);
  assert.ok((await eventStore.read({ after: 0 })).some((event) => event.type === "navigation.decision"));
});
