"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");
const { Tmux } = require("../src/tmux");
const { SessionManager } = require("../src/session-manager");
const { createServer } = require("../src/server");
const { TelegramAdapter, chunks } = require("../src/telegram");

test("Telegram remains a thin adapter over the runtime API", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-telegram-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 5000,
    submissionTimeoutMs: 5000,
    artifactPollMs: 25,
    drivers: {
      claude: { command: mockDriver, homeDir: home, model: "", permissionMode: "bypassPermissions", extraArgs: [] },
      codex: { command: mockDriver, homeDir: home, model: "", sandbox: "danger-full-access", approval: "never", extraArgs: [] },
    },
    telegram: {
      token: "test-token",
      defaultDriver: "claude",
      workspace,
      allowedChatIds: new Set(),
    },
  };
  const eventStore = new EventStore(config.stateDir);
  await eventStore.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore });
  await sessions.init();
  const auth = { status: async () => ({ authenticated: true }) };
  const server = createServer({ config, sessions, auth, eventStore });
  await server.start();
  const telegramCalls = [];
  const adapter = new TelegramAdapter({
    config,
    fetchImpl: async (url, options) => {
      telegramCalls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    },
  });
  await adapter.init();
  t.after(async () => {
    await server.stop();
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  const message = (messageId, text) => ({ chat: { id: 42 }, message_id: messageId, text });
  await adapter.handle(message(1, "/start"));
  await adapter.handle(message(2, "hello from Telegram"));
  await adapter.handle(message(3, "/driver codex"));
  await adapter.handle(message(4, "hello from Codex"));

  const sent = telegramCalls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.ok(sent.some((text) => text === "Claude Code is ready."));
  assert.ok(sent.some((text) => /MOCK_CLAUDE: hello from Telegram/.test(text)));
  assert.ok(sent.some((text) => text === "Codex selected."));
  assert.ok(sent.some((text) => /MOCK_CODEX: hello from Codex/.test(text)));
  assert.ok(telegramCalls.some((call) => call.method === "sendChatAction"));
  assert.equal(chunks("x".repeat(8001)).length, 3);
});
