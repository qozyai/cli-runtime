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

async function bindRoute(adapter, root, routeKey = "42:main", project = "project") {
  await fs.mkdir(path.join(root, project), { recursive: true });
  await adapter.routeStore.update(routeKey, { driver: "claude", project });
}

test("Telegram remains a thin adapter over the runtime API", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-"));
  const projectsRoot = path.join(root, "projects");
  const workspace = path.join(projectsRoot, "workspace");
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
      projectsRoot,
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
  await adapter.handle(message(0, "/project workspace"));
  await adapter.handle(message(1, "/start"));
  await adapter.handle(message(2, "hello from Telegram"));
  await adapter.handle(message(3, "/driver codex"));
  await adapter.handle(message(4, "hello from Codex"));

  const sent = telegramCalls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  assert.ok(sent.some((text) => /Claude Code is authenticated/.test(text)));
  assert.ok(sent.includes("Codex selected. The next message starts or resumes its own conversation lazily; Claude Code chat context is not transferred."));
  assert.ok(telegramCalls.some((call) => call.method === "sendChatAction"));
  const edits = telegramCalls.filter((call) => call.method === "editMessageText");
  assert.ok(edits.some((call) => call.body.message_id
    && /MOCK_CLAUDE: hello from Telegram/.test(call.body.rich_message?.markdown)));
  assert.ok(edits.some((call) => call.body.message_id
    && /MOCK_CODEX: hello from Codex/.test(call.body.rich_message?.markdown)));
  assert.equal(chunks("x".repeat(8001)).length, 3);
});

test("Telegram sends replied text and media through the runtime to the driver", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-replies-"));
  const projectsRoot = path.join(root, "projects");
  const workspace = path.join(projectsRoot, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-telegram-replies-${process.pid}-${Date.now()}`,
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
      projectsRoot,
      allowedChatIds: new Set(),
      maxFileBytes: 1024,
    },
  };
  const eventStore = new EventStore(config.stateDir);
  await eventStore.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore });
  await sessions.init();
  const server = createServer({ config, sessions, auth: { status: async () => ({ authenticated: true }) }, eventStore });
  await server.start();

  const media = new Map([
    ["current-document", { filePath: "current/request.txt", bytes: Buffer.from("current document") }],
    ["replied-document", { filePath: "reply/report.pdf", bytes: Buffer.from("replied document") }],
    ["replied-photo-large", { filePath: "reply/photo-large.jpg", bytes: Buffer.from("large photo") }],
    ["replied-audio", { filePath: "reply/voice.ogg", bytes: Buffer.from("replied audio") }],
  ]);
  const telegramCalls = [];
  const transcriptions = [];
  const adapter = new TelegramAdapter({
    config,
    openaiHelper: {
      enabled: true,
      transcribe: async ({ sourcePath, name }) => {
        transcriptions.push({ name, bytes: await fs.readFile(sourcePath, "utf8") });
        return "Quoted audio transcript.";
      },
    },
    fetchImpl: async (url, options = {}) => {
      if (url.includes("/file/bot")) {
        const item = [...media.values()].find(({ filePath }) => url.endsWith(`/${filePath}`));
        assert.ok(item, `unexpected Telegram file URL: ${url}`);
        return { ok: true, arrayBuffer: async () => item.bytes };
      }
      const method = url.split("/").pop();
      const body = JSON.parse(options.body || "{}");
      telegramCalls.push({ method, body });
      if (method === "getFile") {
        const item = media.get(body.file_id);
        assert.ok(item, `unexpected Telegram file id: ${body.file_id}`);
        return { ok: true, json: async () => ({ ok: true, result: { file_path: item.filePath } }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 900 + telegramCalls.length } }) };
    },
  });
  await adapter.init();
  t.after(async () => {
    await server.stop();
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  const submissionIds = [];
  const runtime = adapter.runtime.bind(adapter);
  adapter.runtime = async (method, requestPath, body) => {
    const result = await runtime(method, requestPath, body);
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      submissionIds.push(result.submission.submissionId);
    }
    return result;
  };

  const chat = { id: 42 };
  await adapter.handle({ chat, message_id: 1, text: "/project workspace" });
  await adapter.handle({
    chat,
    message_id: 11,
    text: "Answer the quoted question.",
    reply_to_message: { chat, message_id: 10, text: "What changed in this release?" },
  });
  await adapter.handle({
    chat,
    message_id: 21,
    caption: "Compare my file with the replied report.",
    document: { file_id: "current-document", file_name: "request.txt", file_size: 16, mime_type: "text/plain" },
    reply_to_message: {
      chat,
      message_id: 20,
      caption: "Original quarterly report.",
      document: { file_id: "replied-document", file_name: "report.pdf", file_size: 16, mime_type: "application/pdf" },
    },
  });
  await adapter.handle({
    chat,
    message_id: 31,
    text: "Describe this photo.",
    reply_to_message: {
      chat,
      message_id: 30,
      photo: [
        { file_id: "replied-photo-small", file_size: 3 },
        { file_id: "replied-photo-large", file_size: 11 },
      ],
    },
  });
  await adapter.handle({
    chat,
    message_id: 41,
    text: "Follow the spoken instructions.",
    reply_to_message: {
      chat,
      message_id: 40,
      voice: { file_id: "replied-audio", file_size: 13, mime_type: "audio/ogg" },
    },
  });
  await adapter.handle({
    chat,
    message_id: 51,
    text: "Summarize your previous answer.",
    reply_to_message: {
      chat,
      message_id: 50,
      from: { id: 1000, is_bot: true, first_name: "QozyAI" },
      rich_message: {
        blocks: [
          { type: "heading", text: "Deployment result", size: 2 },
          {
            type: "paragraph",
            text: ["The ", { type: "bold", text: "release" }, " is ", { type: "code", text: "live" }, "."],
          },
          {
            type: "list",
            items: [
              { label: "•", blocks: [{ type: "paragraph", text: ["Runtime: ", { type: "bold", text: "active" }] }] },
              { label: "•", blocks: [{ type: "paragraph", text: { type: "url", text: "Documentation", url: "https://example.test" } }] },
            ],
          },
          { type: "pre", text: "npm test\n97 passed", language: "text" },
          {
            type: "table",
            caption: "Services",
            cells: [
              [{ text: "Runtime", is_header: true }, { text: "Status", is_header: true }],
              [{ text: "Telegram" }, { text: "active" }],
            ],
          },
          { type: "details", summary: "More", blocks: [{ type: "paragraph", text: "No rollback needed." }] },
          {
            type: "blockquote",
            blocks: [{ type: "paragraph", text: "Everything is healthy." }],
            credit: "QozyAI",
          },
          { type: "photo", photo: [], caption: { text: "Health chart", credit: "Monitor" } },
        ],
      },
    },
  });
  await adapter.handle({
    chat,
    message_id: 61,
    text: "Ignore the implicit topic root.",
    reply_to_message: {
      chat,
      message_id: 5,
      forum_topic_created: { name: "Test", icon_color: 7_322_096 },
    },
  });

  assert.equal(submissionIds.length, 6);
  const completed = [];
  for (const submissionId of submissionIds) {
    completed.push((await runtime("GET", `/v1/submissions/${encodeURIComponent(submissionId)}`)).submission);
  }
  assert.ok(completed.every((submission) => submission.status === "completed"));
  assert.ok(completed.slice(0, 5).every((submission) => /^MOCK_CLAUDE_FILE:/.test(submission.reply)));
  assert.match(completed[5].reply, /^MOCK_CLAUDE: Ignore the implicit topic root\./);

  const sessionKey = adapter.sessionKey({ chat }, workspace);
  const prompts = [];
  for (const submissionId of submissionIds) {
    prompts.push(await fs.readFile(sessions.promptPath(sessionKey, submissionId), "utf8"));
  }
  assert.match(prompts[0], /<telegram-reply-context>[\s\S]*What changed in this release\?[\s\S]*Current message:\nAnswer the quoted question\./);
  assert.match(prompts[1], /Original quarterly report\.[\s\S]*replied-20-report\.pdf[\s\S]*Compare my file with the replied report\./);
  assert.match(prompts[2], /replied-30-photo-30\.jpg[\s\S]*Current message:\nDescribe this photo\./);
  assert.match(prompts[3], /replied-40-voice-40\.ogg[\s\S]*Current message:\nFollow the spoken instructions\./);
  assert.match(prompts[4], /Deployment result[\s\S]*The release is live\.[\s\S]*• Runtime: active[\s\S]*Documentation/);
  assert.match(prompts[4], /npm test\n97 passed[\s\S]*Services\nRuntime \| Status\nTelegram \| active/);
  assert.match(prompts[4], /More\nNo rollback needed\.[\s\S]*Everything is healthy\.\nQozyAI[\s\S]*Health chart\nMonitor/);
  assert.match(prompts[4], /Current message:\nSummarize your previous answer\./);
  assert.doesNotMatch(prompts[5], /telegram-reply-context/);

  assert.deepEqual(completed[1].inputs.map((input) => input.originalName), ["request.txt", "replied-20-report.pdf"]);
  assert.equal(await fs.readFile(completed[1].inputs[0].archivePath, "utf8"), "current document");
  assert.equal(await fs.readFile(completed[1].inputs[1].archivePath, "utf8"), "replied document");
  assert.deepEqual(completed[2].inputs.map((input) => input.originalName), ["replied-30-photo-30.jpg"]);
  assert.equal(await fs.readFile(completed[2].inputs[0].archivePath, "utf8"), "large photo");
  assert.deepEqual(completed[3].inputs.map((input) => input.originalName), ["replied-40-voice-40.ogg"]);
  assert.equal(await fs.readFile(completed[3].inputs[0].archivePath, "utf8"), "replied audio");
  assert.equal(await fs.readFile(completed[3].inputs[0].transcriptArchivePath, "utf8"), "Quoted audio transcript.");
  assert.deepEqual(transcriptions, [{ name: "voice-40.ogg", bytes: "replied audio" }]);
  assert.equal(telegramCalls.some((call) => call.method === "getFile" && call.body.file_id === "replied-photo-small"), false);
  assert.ok(telegramCalls.some((call) => call.method === "sendMessage"
    && call.body.text === "Replied-to audio transcript:\nQuoted audio transcript."));
  assert.deepEqual(await fs.readdir(path.join(config.stateDir, "telegram", "inputs")), []);
});

test("Telegram runs the turn without an oversized replied attachment and says so", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-reply-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token",
        defaultDriver: "claude",
        projectsRoot: root,
        allowedChatIds: new Set(),
        maxFileBytes: 10,
      },
    },
    fetchImpl: async () => { throw new Error("oversized media must not be downloaded"); },
  });
  await adapter.init();
  await bindRoute(adapter, root);
  adapter.ensureSession = async () => ({ status: "ready" });
  const sent = [];
  adapter.api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  let submittedMessage = null;
  adapter.runtime = async (method, urlPath, body) => {
    if (method === "POST" && urlPath.endsWith("/submissions")) {
      submittedMessage = body.message;
      return { submission: { submissionId: "sub-reply-limit" } };
    }
    return { submission: { submissionId: "sub-reply-limit", status: "completed", reply: "done", outputs: [] } };
  };
  adapter.waitSubmission = async () => ({ submissionId: "sub-reply-limit", status: "completed", reply: "done", outputs: [] });

  const chat = { id: 42 };
  await adapter.handle({
    chat,
    message_id: 2,
    text: "Inspect the replied file.",
    reply_to_message: {
      chat,
      message_id: 1,
      document: { file_id: "large", file_name: "large.pdf", file_size: 11, mime_type: "application/pdf" },
    },
  });

  // The enrichment failed; the user's own message is still the work that matters.
  assert.match(submittedMessage, /Inspect the replied file\./);
  assert.match(submittedMessage, /Replied-to attachment unavailable: .*exceeds 10 bytes/);
  assert.ok(sent.some((call) => call.method === "sendMessage"
    && /Continuing without the replied-to attachment: .*exceeds 10 bytes/.test(String(call.body.text || ""))));
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
      projectsRoot: root,
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

test("Telegram replaces progress with rich Markdown and safely falls back", async () => {
  const adapter = new TelegramAdapter({
    config: {
      stateDir: "/tmp",
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: "/tmp", allowedChatIds: new Set() },
    },
  });
  const richEdits = [];
  const plainEdits = [];
  const sent = [];
  adapter.editRichStatus = async (_message, messageId, text) => {
    richEdits.push({ messageId, text });
    return { message_id: messageId };
  };
  adapter.editStatus = async (_message, messageId, text) => {
    plainEdits.push({ messageId, text });
    return { message_id: messageId };
  };
  adapter.send = async (_message, text) => { sent.push(text); };

  const markdown = "# Result\n\n**Done.**\n\n```js\nconsole.log('ok');\n```";
  await adapter.finalizeStatus({ chat: { id: 42 } }, 777, markdown);
  assert.deepEqual(richEdits, [{ messageId: 777, text: markdown }]);
  assert.deepEqual(plainEdits, []);
  assert.deepEqual(sent, []);

  richEdits.length = 0;
  plainEdits.length = 0;
  sent.length = 0;
  adapter.editRichStatus = async () => null;
  await adapter.finalizeStatus({ chat: { id: 42 } }, 777, "fallback reply");
  assert.deepEqual(plainEdits, [{ messageId: 777, text: "fallback reply" }]);

  plainEdits.length = 0;
  await adapter.finalizeStatus({ chat: { id: 42 } }, 777, "x".repeat(32_769));
  assert.deepEqual(plainEdits, [{ messageId: 777, text: "x".repeat(4000) }]);
  assert.deepEqual(sent.map((text) => text.length), [4000, 4000, 4000, 4000, 4000, 4000, 4000, 769]);
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
        projectsRoot: root,
        allowedChatIds: new Set(),
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
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
    telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(["42"]) },
  };
  const first = new TelegramAdapter({ config, fetchImpl: async () => { throw new Error("unused"); } });
  await first.init();
  first.dispatch = () => {};
  const update = {
    update_id: 77,
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      message_id: 9,
      text: "durable",
    },
  };
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
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
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
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
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
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
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

test("Telegram sends a successful voice transcript separately before submission", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-transcript-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "voice.ogg");
  await fs.writeFile(sourcePath, "voice");
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
  const events = [];
  let submittedInputs = null;
  adapter.send = async (_message, text) => { events.push({ type: "message", text }); };
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 1 });
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.downloadInputs = async () => [{
    sourcePath,
    name: "voice.ogg",
    mimeType: "audio/ogg",
    transcript: "Please publish the café site tomorrow. ✅",
    transcriptionError: null,
    temporary: true,
  }];
  adapter.runtime = async (method, requestPath, body) => {
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      events.push({ type: "submission" });
      submittedInputs = body.inputs;
      return { submission: { submissionId: "sub-voice" } };
    }
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({
    submissionId: "sub-voice",
    status: "completed",
    reply: "Here is how I understood your prompt: publish the café site tomorrow.\n\nI will do that.",
    outputs: [],
  });
  adapter.finalizeStatus = async (_message, _messageId, text) => { events.push({ type: "final", text }); };

  await adapter.handle({ chat: { id: 42 }, message_id: 8, voice: { file_id: "voice", file_size: 5, mime_type: "audio/ogg" } });
  assert.deepEqual(events[0], {
    type: "message",
    text: "Your voice transcript:\nPlease publish the café site tomorrow. ✅",
  });
  assert.equal(events[1].type, "submission");
  assert.equal(submittedInputs[0].transcript, "Please publish the café site tomorrow. ✅");
  assert.match(events.at(-1).text, /^Here is how I understood your prompt:/);
  await assert.rejects(() => fs.access(sourcePath));
});

test("Telegram does not report a user interruption as a model error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-interrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
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

test("Telegram allowlist bootstraps one durable owner who can use any group", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-allowlist-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    stateDir: root,
    telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
  };
  const adapter = new TelegramAdapter({ config });
  await adapter.init();
  const update = {
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      message_id: 1,
      text: "hello",
    },
  };
  assert.equal(await adapter.acceptedMessage(update), false);
  assert.equal(await adapter.acceptedMessage({
    message: { ...update.message, chat: { id: -1001, type: "supergroup" }, message_id: 2 },
  }), false);
  config.telegram.allowedChatIds.add("42");
  assert.equal(await adapter.acceptedMessage(update), true);
  config.telegram.allowedChatIds.clear();
  assert.equal(await adapter.acceptedMessage({
    message: { ...update.message, chat: { id: -1001, type: "supergroup" }, message_id: 2 },
  }), true);
  assert.equal(await adapter.acceptedMessage({
    message: { ...update.message, chat: { id: -2002, type: "group" }, message_id: 3 },
  }), true);
  const restarted = new TelegramAdapter({ config });
  await restarted.init();
  assert.equal(await restarted.acceptedMessage({
    message: { ...update.message, chat: { id: -3003, type: "supergroup" }, message_id: 4 },
  }), true);
  assert.equal(await adapter.acceptedMessage({
    message: {
      ...update.message,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 43, is_bot: false },
      message_id: 5,
    },
  }), false);
  assert.equal(await adapter.acceptedMessage({
    message: { ...update.message, chat: { id: -1001, type: "channel" }, message_id: 6 },
  }), false);
  config.telegram.allowedChatIds = new Set(["*"]);
  assert.equal(await adapter.acceptedMessage({
    message: { ...update.message, chat: { id: 43, type: "private" }, from: { id: 43, is_bot: false } },
  }), false);

  let dispatched = 0;
  adapter.dispatch = () => { dispatched += 1; };
  await adapter.acceptUpdate({
    update_id: 88,
    message: {
      ...update.message,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 43, is_bot: false },
      message_id: 7,
      document: { file_id: "must-not-download" },
      text: undefined,
    },
  });
  assert.equal(dispatched, 0);
  await assert.rejects(() => fs.access(path.join(root, "telegram", "queue", "88.json")));
  assert.deepEqual(await readJson(path.join(root, "telegram", "offset.json")), { version: 1, offset: 89 });
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
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(["42"]) },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  adapter.handle = async (message) => {
    if (message.text === "slow") {
      await gate;
      order.push("slow");
      return;
    }
    if (message.text === "after") order.push("after");
    else return TelegramAdapter.prototype.handle.call(adapter, message);
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
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(["42"]) },
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
