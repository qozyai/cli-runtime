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
const { TELEGRAM_DOCUMENT_LIMIT, TelegramAdapter, chunks } = require("../src/telegram");
const { readJson } = require("../src/util");

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
  assert.ok(sent.some((text) => text === "Codex selected."));
  assert.ok(telegramCalls.some((call) => call.method === "sendChatAction"));
  const edits = telegramCalls.filter((call) => call.method === "editMessageText");
  assert.ok(edits.some((call) => call.body.message_id && /MOCK_CLAUDE: hello from Telegram/.test(call.body.text)));
  assert.ok(edits.some((call) => call.body.message_id && /MOCK_CODEX: hello from Codex/.test(call.body.text)));
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
    openaiHelper: {
      enabled: true,
      transcribe: async () => "Voice sample transcript.",
    },
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
  assert.equal(inputs[0].transcript, "Voice sample transcript.");
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
  assert.equal(edits.some((edit) => edit.text === "Completed."), false);
});

test("Telegram replaces progress with the final response and safely handles overflow", async () => {
  const adapter = new TelegramAdapter({
    config: {
      stateDir: "/tmp",
      telegram: { token: "token", defaultDriver: "claude", workspace: "/tmp", allowedChatIds: new Set() },
    },
  });
  const edits = [];
  const sent = [];
  adapter.editStatus = async (_message, messageId, text) => {
    edits.push({ messageId, text });
    return { message_id: messageId };
  };
  adapter.send = async (_message, text) => { sent.push(text); };

  await adapter.finalizeStatus({ chat: { id: 42 } }, 777, "x".repeat(8001));
  assert.deepEqual(edits, [{ messageId: 777, text: "x".repeat(4000) }]);
  assert.deepEqual(sent.map((text) => text.length), [4000, 1]);

  edits.length = 0;
  sent.length = 0;
  adapter.editStatus = async () => null;
  await adapter.finalizeStatus({ chat: { id: 42 } }, 777, "fallback reply");
  assert.deepEqual(sent, ["fallback reply"]);
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

test("Telegram persists accepted updates before advancing offset and replays queued work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-queue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    stateDir: root,
    socketPath: path.join(root, "runtime.sock"),
    telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set(["42"]) },
  };
  const first = new TelegramAdapter({ config, fetchImpl: async () => { throw new Error("unused"); } });
  await first.init();
  first.dispatch = () => {};
  const update = { update_id: 77, message: { chat: { id: 42 }, message_id: 9, text: "durable" } };
  await first.acceptUpdate(update);
  assert.deepEqual(await readJson(path.join(root, "telegram", "offset.json"), null), { version: 1, offset: 78 });
  assert.equal((await readJson(path.join(root, "telegram", "queue", "77.json"), null)).message.text, "durable");

  const handled = [];
  const second = new TelegramAdapter({ config, fetchImpl: async () => { throw new Error("unused"); } });
  second.handle = async (message) => { handled.push(message.message_id); };
  await second.init();
  const deadline = Date.now() + 1000;
  while (handled.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(handled, [9]);
  while (await fs.access(path.join(root, "telegram", "queue", "77.json")).then(() => true, () => false)) {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(() => fs.access(path.join(root, "telegram", "queue", "77.json")));
});

test("Telegram stop bypasses a blocked ordinary route", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  adapter.handle = async (message) => {
    if (message.text === "slow") await gate;
    else return TelegramAdapter.prototype.handle.call(adapter, message);
  };
  adapter.runtime = async (method, requestPath) => {
    calls.push({ method, requestPath });
    if (method === "GET") return { session: { status: "running", activeSubmissionId: "sub-active" } };
    return { interrupted: true };
  };
  adapter.send = async () => {};
  adapter.dispatch({ update_id: 1, message: { chat: { id: 42 }, message_id: 1, text: "slow" } });
  adapter.dispatch({ update_id: 2, message: { chat: { id: 42 }, message_id: 2, text: "/status" } });
  adapter.dispatch({ update_id: 3, message: { chat: { id: 42 }, message_id: 3, text: "/stop" } });
  const deadline = Date.now() + 500;
  while (calls.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.some((call) => call.method === "GET"));
  assert.ok(calls.some((call) => call.requestPath.endsWith("/interrupt")));
  release();
});

test("Telegram rejects oversized output before reading it and acknowledges successful siblings only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-size-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => { throw new Error("network should not be reached"); },
  });
  await adapter.init();
  await assert.rejects(() => adapter.sendFile({ chat: { id: 1 } }, {
    originalName: "huge.zip",
    size: TELEGRAM_DOCUMENT_LIMIT + 1,
    archivePath: path.join(root, "missing.zip"),
  }), /50 MB/);
});

test("Telegram visibly reports transcription failure while submitting original audio", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-transcribe-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "voice.ogg");
  await fs.writeFile(sourcePath, "voice");
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  const sent = [];
  let submittedInputs = null;
  adapter.send = async (_message, text) => { sent.push(text); };
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 1 });
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.downloadInputs = async () => [{
    sourcePath,
    name: "voice.ogg",
    mimeType: "audio/ogg",
    transcript: null,
    transcriptionError: "Audio transcription failed: upstream timeout",
    temporary: true,
  }];
  adapter.runtime = async (method, requestPath, body) => {
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      submittedInputs = body.inputs;
      return { submission: { submissionId: "sub-audio" } };
    }
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({ submissionId: "sub-audio", status: "completed", reply: "heard", outputs: [] });
  adapter.finalizeStatus = async (_message, _messageId, text) => { sent.push(text); };
  await adapter.handle({ chat: { id: 42 }, message_id: 4, voice: { file_id: "voice", file_size: 5, mime_type: "audio/ogg" } });
  assert.ok(sent.some((text) => /transcription failed/i.test(text)));
  assert.equal(submittedInputs[0].name, "voice.ogg");
  assert.equal(sent.at(-1), "heard");
});

test("Telegram does not report a user interruption as a model error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-interrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 1 });
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.downloadInputs = async () => [];
  adapter.runtime = async (method, requestPath) => {
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      return { submission: { submissionId: "sub-interrupted" } };
    }
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({
    submissionId: "sub-interrupted",
    status: "interrupted",
    error: "submission interrupted",
    outputs: [],
  });
  const finalized = [];
  adapter.finalizeStatus = async (_message, _messageId, text) => { finalized.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 5, text: "long task" });
  assert.deepEqual(sent, []);
  assert.deepEqual(finalized, ["Interrupted."]);
});

test("Telegram chat admission fails closed unless explicitly allowlisted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-allowlist-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    stateDir: root,
    telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set() },
  };
  const adapter = new TelegramAdapter({ config });
  const update = { message: { chat: { id: 42 }, message_id: 1, text: "hello" } };
  assert.equal(adapter.acceptedMessage(update), false);
  config.telegram.allowedChatIds.add("42");
  assert.equal(adapter.acceptedMessage(update), true);
  config.telegram.allowedChatIds = new Set(["*"]);
  assert.equal(adapter.acceptedMessage(update), true);
});

test("Telegram chunks do not split Unicode surrogate pairs", () => {
  const parts = chunks(`abc${"✅".repeat(10)}`, 4);
  assert.equal(parts.join(""), `abc${"✅".repeat(10)}`);
  assert.ok(parts.every((part) => !/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(part)));
});

test("Telegram reset is an ordered route barrier after immediate interruption", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-reset-barrier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set(["42"]) },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  adapter.handle = async (message) => {
    if (message.text === "slow") {
      await gate;
      order.push("slow");
      return;
    }
    order.push(message.text);
  };
  adapter.runtime = async (method, requestPath) => {
    if (requestPath.endsWith("/interrupt")) {
      order.push("interrupt");
      return { interrupted: true };
    }
    if (method === "GET") return { session: { activeSubmissionId: null } };
    if (method === "DELETE") {
      order.push("reset");
      return { ok: true };
    }
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.send = async () => {};
  adapter.dispatch({ update_id: 1, message: { chat: { id: 42 }, message_id: 1, text: "slow" } });
  adapter.dispatch({ update_id: 2, message: { chat: { id: 42 }, message_id: 2, text: "/reset" } });
  adapter.dispatch({ update_id: 3, message: { chat: { id: 42 }, message_id: 3, text: "after" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ["interrupt"]);
  release();
  const deadline = Date.now() + 1000;
  while (!order.includes("after") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["interrupt", "slow", "reset", "after"]);
});

test("Telegram reports a terminal handler error and retires its queue record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-visible-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", workspace: root, allowedChatIds: new Set(["42"]) },
    },
  });
  await adapter.init();
  const queuePath = path.join(root, "telegram", "queue", "10.json");
  await fs.writeFile(queuePath, "{}");
  const sent = [];
  adapter.handle = async () => { throw new Error("runtime unavailable"); };
  adapter.send = async (_message, text) => { sent.push(text); };
  adapter.dispatch({ update_id: 10, message: { chat: { id: 42 }, message_id: 1, text: "hello" } }, queuePath);
  const deadline = Date.now() + 1000;
  while (await fs.access(queuePath).then(() => true, () => false)) {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(sent, ["Runtime error: runtime unavailable"]);
  await assert.rejects(() => fs.access(queuePath));
});
