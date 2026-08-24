"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/core/event-store");
const { Tmux } = require("../src/drivers/tmux");
const { SessionManager } = require("../src/core/session-manager");
const { createServer } = require("../src/core/server");
const { TELEGRAM_DOCUMENT_LIMIT, TelegramAdapter, chunks } = require("../src/surface/telegram");
const { readJson } = require("../src/core/util");

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
  assert.ok(sent.some((text) => /Claude Code.*will be attempted/.test(text)));
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

test("Telegram retries an auth-required session without an auth status gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-auth-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token",
        defaultDriver: "codex",
        projectsRoot: root,
        allowedChatIds: new Set(),
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  await bindRoute(adapter, root, "42:main");
  await adapter.routeStore.update("42:main", { driver: "codex", project: "project" });

  const runtimeCalls = [];
  adapter.ensureSession = async () => ({ status: "auth_required" });
  adapter.runtime = async (method, requestPath) => {
    runtimeCalls.push({ method, requestPath });
    if (method === "POST" && requestPath.endsWith("/restart")) {
      return { session: { status: "ready" } };
    }
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      return { submission: { submissionId: "sub-after-auth" } };
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({
    submissionId: "sub-after-auth",
    status: "completed",
    reply: "Codex turn completed",
    outputs: [],
  });
  adapter.sendStatus = async () => ({ message_id: 10 });
  adapter.typing = async () => {};
  adapter.send = async () => {};
  adapter.finalizeStatus = async () => {};

  await adapter.handle({ chat: { id: 42 }, message_id: 9, text: "continue after login" });

  const encodedSession = encodeURIComponent(`telegram:42:main:${path.join(root, "project")}`);
  assert.deepEqual(runtimeCalls.map(({ method, requestPath }) => `${method} ${requestPath}`), [
    `POST /v1/sessions/${encodedSession}/restart`,
    `POST /v1/sessions/${encodedSession}/submissions`,
  ]);
});

test("a broken login is repaired through the chat, not through attach", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-reauth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token", defaultDriver: "codex", projectsRoot: root, allowedChatIds: new Set(),
        reauthPollMs: 25, reauthTimeoutMs: 5000,
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  t.after(() => adapter.stop());
  await bindRoute(adapter, root, "42:main");
  await adapter.routeStore.update("42:main", { driver: "codex", project: "project" });
  let authenticated = false;
  adapter.ensureSession = async () => ({ status: authenticated ? "ready" : "auth_required" });
  const calls = [];
  let submitted = null;
  adapter.runtime = async (method, requestPath, body) => {
    calls.push(`${method} ${requestPath}`);
    if (requestPath.endsWith("/restart")) return { session: { status: authenticated ? "ready" : "auth_required" } };
    if (requestPath === "/v1/auth/codex/start") {
      return { auth: { phase: "awaiting_browser", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH", state: "interactive" } };
    }
    if (requestPath === "/v1/auth/codex/status") return { auth: { authenticated } };
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      submitted = body;
      return { submission: { submissionId: "sub-after-reauth" } };
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({ submissionId: "sub-after-reauth", status: "completed", reply: "original answered", outputs: [] });
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 10 });
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  const finalized = [];
  adapter.finalizeStatus = async (_message, _messageId, text) => { finalized.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 9, text: "run my original request" });

  assert.ok(sent.some((text) => /auth\.openai\.com\/codex\/device/.test(text) && /ABCD-EFGH/.test(text)));
  assert.equal(sent.some((text) => /attach/i.test(text)), false);
  assert.equal(adapter.pendingReauth.size, 1);

  // The codex path needs nothing sent back: the poll notices the repaired
  // login, announces it, and re-runs the original message.
  authenticated = true;
  const deadline = Date.now() + 3000;
  while (!finalized.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(finalized, ["original answered"]);
  assert.match(submitted.message, /run my original request/);
  assert.equal(submitted.idempotencyKey, "telegram:42:9");
  assert.equal(adapter.pendingReauth.size, 0);
  assert.ok(sent.some((text) => /authentication complete/i.test(text)));
});

test("a pasted code completes reauth and the original message is answered", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-reauth-code-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(),
        reauthPollMs: 60_000, reauthTimeoutMs: 60_000,
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  t.after(() => adapter.stop());
  await bindRoute(adapter, root);
  let authenticated = false;
  adapter.ensureSession = async () => ({ status: authenticated ? "ready" : "auth_required" });
  let submittedCode = null;
  let submission = null;
  adapter.runtime = async (method, requestPath, body) => {
    if (requestPath.endsWith("/restart")) return { session: { status: authenticated ? "ready" : "auth_required" } };
    if (requestPath === "/v1/auth/claude/start") {
      return { auth: { phase: "awaiting_code", url: "https://claude.com/cai/oauth/authorize?x=y", code: null, state: "interactive" } };
    }
    if (requestPath === "/v1/auth/claude/submit") {
      submittedCode = body.code;
      authenticated = true;
      return { auth: { phase: "completed", authenticated: true, state: "authenticated" } };
    }
    if (requestPath === "/v1/auth/claude/status") return { auth: { authenticated } };
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      submission = body;
      return { submission: { submissionId: "sub-resumed" } };
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({ submissionId: "sub-resumed", status: "completed", reply: "resumed reply", outputs: [] });
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 10 });
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  const finalized = [];
  adapter.finalizeStatus = async (_message, _messageId, text) => { finalized.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 21, text: "my blocked request" });
  assert.ok(sent.some((text) => /oauth\/authorize/.test(text) && /reply/i.test(text)));

  const code = `${"A".repeat(48)}#${"B".repeat(24)}`;
  await adapter.handle({ chat: { id: 42 }, message_id: 22, text: code });
  assert.equal(submittedCode, code);
  assert.deepEqual(finalized, ["resumed reply"]);
  assert.equal(submission.idempotencyKey, "telegram:42:21", "the original message resumed, not the code message");
  assert.equal(adapter.pendingReauth.size, 0);
});

test("an expired reauth attempt reports itself and clears", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-reauth-expiry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token", defaultDriver: "codex", projectsRoot: root, allowedChatIds: new Set(),
        reauthPollMs: 25, reauthTimeoutMs: 100,
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
  });
  await adapter.init();
  t.after(() => adapter.stop());
  await bindRoute(adapter, root, "42:main");
  await adapter.routeStore.update("42:main", { driver: "codex", project: "project" });
  adapter.ensureSession = async () => ({ status: "auth_required" });
  adapter.runtime = async (method, requestPath) => {
    if (requestPath.endsWith("/restart")) return { session: { status: "auth_required" } };
    if (requestPath === "/v1/auth/codex/start") return { auth: { phase: "starting", url: null, code: null } };
    if (requestPath === "/v1/auth/codex/status") return { auth: { authenticated: false } };
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 31, text: "stuck request" });
  const deadline = Date.now() + 3000;
  while (adapter.pendingReauth.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adapter.pendingReauth.size, 0);
  assert.ok(sent.some((text) => /timed out/i.test(text)));
});

test("Telegram exposes a manual terminal after an unclassified startup failure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-startup-attention-"));
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
  await bindRoute(adapter, root, "42:main");
  await adapter.routeStore.update("42:main", { driver: "claude", project: "project" });
  adapter.ensureSession = async () => ({ status: "attention_required" });
  const calls = [];
  adapter.runtime = async (method, requestPath) => {
    calls.push(`${method} ${requestPath}`);
    if (requestPath.endsWith("/restart")) {
      return { session: { status: "attention_required", lastError: "pane exited before startup" } };
    }
    if (requestPath === "/v1/auth/claude/start") return { auth: { phase: "interactive" } };
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 10, text: "retry after startup failure" });

  assert.equal(calls.some((call) => call.includes("/auth/claude/status")), false);
  assert.equal(calls.at(-1), "POST /v1/auth/claude/start");
  assert.ok(sent.some((text) => /pane exited before startup.*Use \/attach.*Claude Code authentication/s.test(text)));
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

test("one-time Telegram link binds only its private sender as owner", async (t) => {
  const crypto = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-enrollment-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const code = "owner_pairing_0123456789abcdef";
  const config = {
    stateDir: root,
    telegram: {
      token: "token",
      defaultDriver: "claude",
      projectsRoot: root,
      allowedChatIds: new Set(["*"]),
      ownerEnrollmentCodeHash: crypto.createHash("sha256").update(code).digest("hex"),
    },
  };
  const adapter = new TelegramAdapter({ config });
  await adapter.init();
  const message = {
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    message_id: 1,
    text: `/start ${code}`,
  };

  assert.equal(await adapter.acceptedMessage({ message: { ...message, text: "hello" } }), false);
  assert.equal(await adapter.acceptedMessage({ message: { ...message, text: "/start wrong_owner_pairing_012345" } }), false);
  assert.equal(await adapter.acceptedMessage({
    message: { ...message, chat: { id: -1001, type: "supergroup" } },
  }), false);
  assert.equal(await adapter.acceptedMessage({ message }), true);
  assert.equal(await adapter.acceptedMessage({
    message: { ...message, chat: { id: -1001, type: "supergroup" }, text: "group prompt" },
  }), true);
  assert.equal(await adapter.acceptedMessage({
    message: { ...message, chat: { id: 43, type: "private" }, from: { id: 43 }, text: `/start ${code}` },
  }), false);
});

test("configured system ingress runs on the owner's route with visible provenance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-system-ingress-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "main"));
  const telegramCalls = [];
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    telegram: {
      token: "token",
      defaultDriver: "codex",
      projectsRoot: root,
      allowedChatIds: new Set(),
      systemIngressChatIds: new Set(["99"]),
      burstDebounceMs: 0,
    },
  };
  const adapter = new TelegramAdapter({
    config,
    fetchImpl: async (url, options = {}) => {
      telegramCalls.push({ method: url.split("/").pop(), body: JSON.parse(options.body || "{}") });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramCalls.length } }) };
    },
  });
  await adapter.init();

  const adminUpdate = {
    update_id: 7,
    message: {
      chat: { id: 99, type: "private" },
      from: { id: 99, is_bot: false },
      message_id: 70,
      text: "Reply with the current state.",
    },
  };
  assert.equal(await adapter.admitUpdate(adminUpdate), null, "an admin cannot claim an unbound agent");
  assert.equal(await adapter.ownerStore.authorize({
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
  }), true);
  await adapter.routeStore.update("42:main", { driver: "codex", project: "main" });

  const admitted = await adapter.admitUpdate(adminUpdate);
  assert.ok(admitted);
  assert.equal(admitted.message.chat.id, "42");
  assert.equal(admitted.message.chat.type, "private");
  assert.equal(admitted.message.from.id, 99, "the operator is not rewritten as the owner");
  assert.equal(Object.hasOwn(admitted.message, "message_thread_id"), false);
  assert.equal(await adapter.admitUpdate({
    ...adminUpdate,
    message: { ...adminUpdate.message, chat: { id: -99, type: "group" } },
  }), null);
  assert.equal(await adapter.admitUpdate({
    ...adminUpdate,
    message: { ...adminUpdate.message, from: { id: 99, is_bot: true } },
  }), null);
  assert.equal(await adapter.admitUpdate({
    ...adminUpdate,
    message: { ...adminUpdate.message, chat: { id: 100, type: "private" }, from: { id: 100, is_bot: false } },
  }), null);

  let dispatched = null;
  adapter.dispatch = (update, queuePath) => { dispatched = { update, queuePath }; };
  const queuedUpdate = {
    ...adminUpdate,
    update_id: 8,
    message: { ...adminUpdate.message, message_id: 71 },
  };
  await adapter.acceptUpdate(queuedUpdate);
  assert.equal(dispatched.update.message.chat.id, "42");
  assert.equal(dispatched.update.message.from.id, 99);
  const persisted = await readJson(dispatched.queuePath);
  assert.equal(persisted.message.chat.id, 99, "the original update remains available for crash replay");
  assert.equal(persisted.message.from.id, 99);

  const sent = [];
  adapter.send = async (message, text) => { sent.push({ chatId: String(message.chat.id), text }); };
  adapter.typing = async () => {};
  adapter.sendStatus = async (message) => {
    sent.push({ chatId: String(message.chat.id), text: "Working." });
    return { message_id: 500 };
  };
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.downloadInputs = async () => [];
  let submission = null;
  adapter.runtime = async (method, requestPath, body) => {
    assert.equal(method, "POST");
    assert.match(requestPath, /\/submissions$/);
    submission = body;
    return { submission: { submissionId: "sub-system" } };
  };
  adapter.waitSubmission = async () => ({
    submissionId: "sub-system",
    status: "completed",
    reply: "System request completed.",
    outputs: [],
  });
  adapter.finalizeStatus = async (message, _messageId, text) => {
    sent.push({ chatId: String(message.chat.id), text });
  };

  await adapter.handle(admitted.message);
  assert.deepEqual(sent.map(({ chatId }) => chatId), ["42", "42", "42"]);
  assert.equal(sent[0].text, "⚙️ System intervention received\n\nReply with the current state.");
  assert.match(submission.message, /^<system-intervention source="telegram-admin" sender-user-id="99">/);
  assert.match(submission.message, /not by the Telegram owner/);
  assert.match(submission.message, /Reply with the current state\./);
  assert.equal(submission.idempotencyKey, "telegram:system:99:70:owner:42");
  assert.equal(sent.at(-1).text, "System request completed.");
});

test("Telegram /attach exposes only global and current-route terminals through the external service", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-attach-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "main"));
  const calls = [];
  const serviceUrl = "http://127.0.0.1:17871/v1/terminals";
  const adapter = new TelegramAdapter({
    config: {
      stateDir: path.join(root, "state"),
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token",
        defaultDriver: "codex",
        projectsRoot: root,
        allowedChatIds: new Set(),
        attachServiceUrl: serviceUrl,
      },
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url === serviceUrl) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            terminals: [
              { label: "Codex · main", url: "https://session.trycloudflare.com" },
              { label: "Codex authentication", url: "https://auth.trycloudflare.com" },
              { label: "discarded", url: "javascript:alert(1)" },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    },
  });
  await adapter.init();
  await adapter.routeStore.update("42:7", { driver: "codex", project: "main" });
  const expectedSessionKey = `telegram:42:7:${path.join(root, "main")}`;
  adapter.runtime = async (method, requestPath) => {
    assert.equal(method, "GET");
    assert.equal(requestPath, `/v1/sessions/${encodeURIComponent(expectedSessionKey)}/attach`);
    return { command: "tmux -L 'qozyai-cli-runtime' attach-session -t 'cli-current'" };
  };

  await adapter.handle({
    chat: { id: 42 },
    message_id: 1,
    is_topic_message: true,
    message_thread_id: 7,
    text: "/attach",
  });

  assert.deepEqual(calls[0], {
    url: serviceUrl,
    body: {
      current: {
        label: "Codex · main",
        attachCommand: "tmux -L 'qozyai-cli-runtime' attach-session -t 'cli-current'",
      },
    },
  });
  assert.equal(calls[1].url.endsWith("/sendMessage"), true);
  assert.equal(calls[1].body.message_thread_id, 7);
  assert.deepEqual(calls[1].body.reply_markup.inline_keyboard, [
    [{ text: "Codex · main", url: "https://session.trycloudflare.com" }],
    [{ text: "Codex authentication", url: "https://auth.trycloudflare.com" }],
  ]);
});

test("Telegram /attach degrades cleanly when external attachment is not configured", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-no-attach-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sent = [];
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
  });
  await adapter.init();
  adapter.send = async (_message, text) => { sent.push(text); };
  adapter.runtime = async () => { throw new Error("runtime must not be queried"); };

  await adapter.handle({ chat: { id: 42 }, message_id: 1, text: "/attach" });

  assert.deepEqual(sent, ["Terminal attachment is not configured for this agent."]);
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

test("Telegram rejoins its own in-flight submission instead of reporting attention", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-rejoin-"));
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
  // The daemon is mid-turn on this very update: a crashed adapter replaying its
  // queue, or a retry after a failed status send. The daemon checks idempotency
  // before the busy refusal, so the POST returns the running submission.
  adapter.ensureSession = async () => ({ status: "running", activeSubmissionId: "sub-mine" });
  const runtimeCalls = [];
  let submittedIdempotencyKey = null;
  adapter.runtime = async (method, requestPath, body) => {
    runtimeCalls.push(`${method} ${requestPath}`);
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      submittedIdempotencyKey = body.idempotencyKey;
      return { submission: { submissionId: "sub-mine" } };
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.waitSubmission = async () => ({
    submissionId: "sub-mine",
    status: "completed",
    reply: "recovered reply",
    outputs: [],
  });
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 10 });
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  const finalized = [];
  adapter.finalizeStatus = async (_message, _messageId, text) => { finalized.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 9, text: "replayed message" });

  assert.equal(runtimeCalls.some((call) => call.includes("/auth/")), false);
  assert.equal(sent.some((text) => /needs attention/.test(text)), false);
  assert.equal(submittedIdempotencyKey, "telegram:42:9");
  assert.deepEqual(finalized, ["recovered reply"]);
});

test("Telegram reports a genuine busy conflict as busy, not as attention", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-busy-conflict-"));
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
  adapter.ensureSession = async () => ({ status: "running", activeSubmissionId: "sub-other" });
  const runtimeCalls = [];
  adapter.runtime = async (method, requestPath) => {
    runtimeCalls.push(`${method} ${requestPath}`);
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      throw Object.assign(new Error("session already has an active submission"), {
        code: "SESSION_BUSY",
        statusCode: 409,
      });
    }
    throw new Error(`unexpected runtime call: ${method} ${requestPath}`);
  };
  adapter.typing = async () => {};
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 12, text: "second message" });

  assert.equal(runtimeCalls.some((call) => call.includes("/auth/")), false);
  assert.equal(sent.some((text) => /needs attention/.test(text)), false);
  assert.ok(sent.some((text) => /still working/i.test(text)));
});

test("Telegram delivers the reply even when the status bubble cannot be sent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-no-bubble-"));
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
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.runtime = async (method, requestPath) => {
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      return { submission: { submissionId: "sub-quiet" } };
    }
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.typing = async () => {};
  adapter.sendStatus = async () => { throw new Error("Too Many Requests: retry after 30"); };
  let waitedWithMessageId;
  adapter.waitSubmission = async (_message, submissionId, statusMessageId) => {
    waitedWithMessageId = statusMessageId;
    return { submissionId, status: "completed", reply: "quiet reply", outputs: [] };
  };
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  const finalized = [];
  adapter.finalizeStatus = async (_message, _messageId, text) => { finalized.push(text); };

  await adapter.handle({ chat: { id: 42 }, message_id: 13, text: "quiet turn" });

  assert.equal(waitedWithMessageId, undefined);
  assert.deepEqual(finalized, ["quiet reply"]);
  assert.equal(sent.some((text) => /Runtime error/.test(text)), false);
});

test("Telegram honours retry_after instead of failing the send", async () => {
  const calls = [];
  const adapter = new TelegramAdapter({
    config: {
      stateDir: "/tmp",
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: "/tmp", allowedChatIds: new Set() },
    },
    fetchImpl: async (url) => {
      calls.push(url.split("/").pop());
      if (calls.length === 1) {
        return {
          ok: false,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 0.05 },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });
  const result = await adapter.api("sendMessage", { chat_id: 42, text: "paced" });
  assert.equal(result.message_id, 7);
  assert.deepEqual(calls, ["sendMessage", "sendMessage"]);

  // Anything without retry_after keeps failing loudly.
  calls.length = 0;
  adapter.fetch = async () => ({
    ok: false,
    json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
  });
  await assert.rejects(() => adapter.api("sendMessage", { chat_id: 42, text: "x" }), /chat not found/);
});

test("a preempted turn finalizes its bubble instead of leaving it Working", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-preempt-bubble-"));
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
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.runtime = async (method, requestPath) => {
    if (method === "POST" && requestPath.endsWith("/submissions")) {
      return { submission: { submissionId: "sub-preempted" } };
    }
    if (method === "POST" && requestPath.endsWith("/interrupt")) return { interrupted: true };
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  adapter.typing = async () => {};
  adapter.sendStatus = async () => ({ message_id: 55 });
  adapter.waitSubmission = async () => {
    // A barrier lands while the turn is running: the operation is cancelled
    // before the wait returns, which used to strand the bubble on "Working.".
    const operation = adapter.activeOperationByRoute.get("42:main");
    operation.cancelled = true;
    operation.controller.abort();
    return { submissionId: "sub-preempted", status: "interrupted", outputs: [] };
  };
  adapter.send = async () => {};
  const finalized = [];
  adapter.finalizeStatus = async (_message, messageId, text) => { finalized.push({ messageId, text }); };

  await adapter.handle({ chat: { id: 42 }, message_id: 21, text: "long running work" });

  assert.deepEqual(finalized, [{ messageId: 55, text: "Interrupted." }]);
});

test("a message cancelled before starting is reported, not swallowed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-set-aside-"));
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
  const runtimeCalls = [];
  adapter.runtime = async (method, requestPath) => {
    runtimeCalls.push(`${method} ${requestPath}`);
    throw new Error(`unexpected ${method} ${requestPath}`);
  };
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  // A later /reset barrier is already pending when this message's turn starts.
  adapter.pendingBarriers.set("42:main", [{ ordinal: 5, command: { name: "reset", argument: "" } }]);

  await adapter.handle({ chat: { id: 42 }, message_id: 22, text: "queued behind a barrier" }, { ordinal: 1 });

  assert.equal(runtimeCalls.some((call) => call.endsWith("/submissions")), false);
  assert.ok(sent.some((text) => /Set aside|not run/i.test(text)));
});

test("a failed offset write does not strand an already-queued update", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-offset-"));
  const telegramDir = path.join(root, "telegram");
  t.after(async () => {
    await fs.chmod(telegramDir, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(["42"]) },
    },
    fetchImpl: async () => { throw new Error("unused"); },
  });
  await adapter.init();
  const owner = { chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, message_id: 1, text: "claim" };
  assert.equal(await adapter.ownerStore.authorize(owner), true);
  const dispatched = [];
  adapter.dispatch = (_update, queuePath) => { dispatched.push(queuePath); };
  await fs.chmod(telegramDir, 0o500);
  await adapter.acceptUpdate({
    update_id: 9,
    message: { ...owner, message_id: 2, text: "queued despite the disk" },
  });
  assert.equal(dispatched.length, 1);
});

test("a message whose only content is a rich body is admitted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-telegram-rich-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    stateDir: root,
    telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set(["42"]) },
  };
  const adapter = new TelegramAdapter({ config });
  await adapter.init();
  const owner = { chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, message_id: 1, text: "claim" };
  assert.equal(await adapter.ownerStore.authorize(owner), true);
  assert.equal(await adapter.acceptedMessage({
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      message_id: 2,
      rich_message: { blocks: [{ type: "paragraph", text: "forwarded rich content" }] },
    },
  }), true);
  // Truly empty stays refused.
  assert.equal(await adapter.acceptedMessage({
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      message_id: 3,
      rich_message: { blocks: [] },
    },
  }), false);
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
