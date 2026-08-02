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
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 900 + telegramCalls.length } }) };
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
  const edits = telegramCalls.filter((call) => call.method === "editMessageText");
  assert.ok(edits.some((call) => call.body.message_id && call.body.text === "Completed."));
  assert.equal(chunks("x".repeat(8001)).length, 3);
});

test("Telegram stages audio and edits one explicit progress message", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const config = {
    stateDir: root,
    socketPath: path.join(root, "runtime.sock"),
    telegram: {
      token: "token",
      defaultDriver: "claude",
      workspace: root,
      allowedChatIds: new Set(),
      maxFileBytes: 1024,
      statusEditIntervalMs: 1,
    },
  };
  const adapter = new TelegramAdapter({
    config,
    fetchImpl: async (url, options = {}) => {
      const method = url.split("/").pop();
      calls.push({ method, body: options.body });
      if (url.includes("/file/bot")) {
        return { ok: true, arrayBuffer: async () => Buffer.from("voice-bytes") };
      }
      if (method === "getFile") {
        return { ok: true, json: async () => ({ ok: true, result: { file_path: "voice/file.ogg" } }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 321 } }) };
    },
  });
  await adapter.init();
  const message = {
    chat: { id: 42 },
    message_id: 7,
    voice: { file_id: "voice-id", file_size: 11, mime_type: "audio/ogg" },
  };
  const inputs = await adapter.downloadInputs(message);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].name, "voice-7.ogg");
  assert.equal(await fs.readFile(inputs[0].sourcePath, "utf8"), "voice-bytes");

  let reads = 0;
  adapter.runtime = async () => {
    reads += 1;
    if (reads === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { submission: { status: "running", progress: { summary: "Inspecting the audio.\nRecent tools: Read (ok)" } } };
    }
    return { submission: { submissionId: "sub-one", status: "completed", progress: {}, outputs: [] } };
  };
  await adapter.waitSubmission(message, "sub-one", 777);
  const edits = calls.filter((call) => call.method === "editMessageText").map((call) => JSON.parse(call.body));
  assert.ok(edits.some((edit) => edit.message_id === 777 && /Inspecting the audio/.test(edit.text)));
  assert.ok(edits.some((edit) => edit.message_id === 777 && edit.text === "Completed."));
});

test("Telegram does not redeliver outputs that were already acknowledged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-delivery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token",
        defaultDriver: "claude",
        workspace: root,
        allowedChatIds: new Set(),
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  const runtimeCalls = [];
  adapter.runtime = async (method, requestPath) => {
    runtimeCalls.push({ method, requestPath });
    if (requestPath.includes("/auth/")) return { auth: { authenticated: true } };
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      return { submission: { submissionId: "sub-delivered" } };
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.waitSubmission = async () => ({
    submissionId: "sub-delivered",
    status: "completed",
    reply: "already delivered",
    outputs: [{ originalName: "report.txt", deliveryStatus: "delivered" }],
  });
  adapter.sendStatus = async () => ({ message_id: 10 });
  adapter.typing = async () => {};
  adapter.send = async () => {};
  let fileDeliveries = 0;
  adapter.sendFile = async () => { fileDeliveries += 1; };

  await adapter.handle({ chat: { id: 42 }, message_id: 9, text: "retry" });
  assert.equal(fileDeliveries, 0);
  assert.equal(runtimeCalls.some((call) => call.requestPath.includes("/outputs/ack")), false);
});
