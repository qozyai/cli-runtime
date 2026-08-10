"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { ProjectCatalog } = require("../src/project-catalog");
const { RouteStore } = require("../src/route-store");
const { CONTROL_COMMANDS, TelegramAdapter, topicThreadId } = require("../src/telegram");
const { readJson } = require("../src/util");

test("project catalog exposes only canonical direct ASCII-named directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-catalog-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-outside-"));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, "api"));
  await fs.mkdir(path.join(root, "web_2"));
  await fs.mkdir(path.join(root, "bad name"));
  await fs.writeFile(path.join(root, "file"), "not a project");
  await fs.symlink(outside, path.join(root, "escape"));
  const logs = [];
  const catalog = new ProjectCatalog({ root, log: (line) => logs.push(line) });
  await catalog.init();
  const listing = await catalog.list();
  assert.deepEqual(listing.projects.map((project) => project.name), ["api", "web_2"]);
  assert.equal(listing.hasInvalidNames, true);
  assert.ok(logs.some((line) => line.includes("bad name")));
  await assert.rejects(() => catalog.resolve("../api"), (error) => error.code === "PROJECT_NAME_INVALID");
  await assert.rejects(() => catalog.resolve("file"), (error) => error.code === "PROJECT_INVALID");
  await assert.rejects(() => catalog.resolve("escape"), (error) => error.code === "PROJECT_INVALID");

  await fs.rename(path.join(root, "api"), path.join(root, "renamed"));
  await assert.rejects(() => catalog.resolve("api"), (error) => error.code === "PROJECT_MISSING");
  assert.equal((await catalog.resolve("renamed")).path, path.join(root, "renamed"));
  await fs.rename(root, `${root}-gone`);
  await assert.rejects(() => catalog.resolve("api"), (error) => error.code === "PROJECTS_ROOT_UNAVAILABLE");
  await fs.rename(`${root}-gone`, root);
});

test("route store serializes field merges and quarantines only invalid entries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-routes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs = [];
  const store = new RouteStore({ stateDir: root, log: (line) => logs.push(line) });
  await store.init();
  await Promise.all([
    store.update("42:main", { driver: "claude" }),
    store.update("42:main", { project: "api" }),
    store.update("42:7", { driver: "codex", project: "web" }),
  ]);
  assert.deepEqual(store.get("42:main"), { driver: "claude", project: "api" });
  assert.deepEqual(store.get("42:7"), { driver: "codex", project: "web" });
  assert.throws(() => { store.get("42:main").driver = "codex"; }, /read only|object is not extensible/i);

  await fs.writeFile(store.filePath, JSON.stringify({
    "42:main": { driver: "claude", project: "api" },
    "old:key": { driver: "codex" },
    "42:8": { driver: "other", project: "web" },
  }));
  const recovered = new RouteStore({ stateDir: root, log: (line) => logs.push(line) });
  await recovered.init();
  assert.deepEqual(recovered.get("42:main"), { driver: "claude", project: "api" });
  assert.equal(recovered.get("old:key"), null);
  assert.ok((await fs.readdir(path.join(root, "telegram"))).some((name) => name.startsWith("routes.invalid.")));
  assert.ok(logs.some((line) => line.includes("old:key")));
});

test("malformed route JSON is moved aside and starts unbound", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-routes-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "telegram");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "routes.json"), "{broken");
  const logs = [];
  const store = new RouteStore({ stateDir: root, log: (line) => logs.push(line) });
  await store.init();
  assert.equal(store.get("42:main"), null);
  assert.ok((await fs.readdir(dir)).some((name) => name.startsWith("routes.invalid.")));
  assert.match(logs.join("\n"), /malformed.*quarantined/i);
});

test("Telegram projects-root configuration is explicit and rejects dangerous roots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-config-projects-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { CLI_RUNTIME_STATE_DIR: path.join(root, "state") };
  assert.throws(
    () => loadConfig(base, { requireTelegramProjectsRoot: true }),
    (error) => error.code === "EX_CONFIG" && error.exitCode === 78 && /CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT/.test(error.message),
  );
  assert.throws(() => loadConfig({ ...base, CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: "" }), /must not be empty/);
  assert.throws(() => loadConfig({ ...base, CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: "/" }), /filesystem root/);
  assert.throws(() => loadConfig({ ...base, CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: "$HOME" }), /home directory/);
  assert.throws(
    () => loadConfig({
      ...base,
      CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root,
      CLI_RUNTIME_TELEGRAM_OWNER_ENROLLMENT_CODE_HASH: "not-a-digest",
    }),
    /lowercase SHA-256/,
  );
  const config = loadConfig({ ...base, CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root }, { requireTelegramProjectsRoot: true });
  assert.equal(config.telegram.projectsRoot, await fs.realpath(root));
  assert.equal(Object.hasOwn(config.telegram, "workspace"), false);
  const ingress = loadConfig({
    ...base,
    CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root,
    CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS: "99,123456789",
  });
  assert.deepEqual([...ingress.telegram.systemIngressChatIds], ["99", "123456789"]);
  assert.throws(() => loadConfig({
    ...base,
    CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root,
    CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS: "*",
  }), /positive Telegram user IDs/);
  assert.throws(() => loadConfig({
    ...base,
    CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root,
    CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS: "99,99",
  }), /must not contain duplicate/);
  assert.throws(() => loadConfig({
    ...base,
    CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT: root,
    CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS: Array.from({ length: 33 }, (_, index) => index + 1).join(","),
  }), /at most 32/);
});

test("topic identity requires Telegram's topic marker on routes and outbound calls", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-topic-normalization-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  await adapter.init();
  const replyThread = { chat: { id: 42 }, message_thread_id: 9 };
  const topic = { chat: { id: 42 }, message_thread_id: 9, is_topic_message: true };
  assert.equal(topicThreadId(replyThread), null);
  assert.equal(adapter.routeKey(replyThread), "42:main");
  assert.equal(adapter.routeKey(topic), "42:9");
  await adapter.send(replyThread, "main");
  await adapter.typing(topic);
  assert.equal(Object.hasOwn(calls[0], "message_thread_id"), false);
  assert.equal(calls[1].message_thread_id, 9);
  assert.deepEqual(await readJson(path.join(root, "telegram", "routes.json"), null), null);
});

test("an unbound route neither creates a session nor downloads its attachment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-unbound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
  });
  await adapter.init();
  const sent = [];
  adapter.send = async (_message, text) => { sent.push(text); };
  adapter.ensureSession = async () => { throw new Error("must not create a session"); };
  adapter.downloadInputs = async () => { throw new Error("must not download an attachment"); };
  await adapter.handle({
    chat: { id: 42 },
    message_id: 1,
    caption: "inspect",
    document: { file_id: "file", file_name: "input.txt", file_size: 10 },
  });
  assert.deepEqual(sent, ["No project is selected. Use /project <name>."]);
});

test("project is the only project-selection command", () => {
  assert.equal(CONTROL_COMMANDS.has("project"), true);
  assert.equal(CONTROL_COMMANDS.has("projects"), false);
  assert.equal(CONTROL_COMMANDS.has("attach"), true);
});

test("rapid project barriers cancel the message between them and preserve final queue order", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-project-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "A"));
  await fs.mkdir(path.join(root, "B"));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: path.join(root, "state"),
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
  });
  await adapter.init();
  await adapter.routeStore.update("42:main", { driver: "claude", project: "A" });
  const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
  adapter.runtime = async () => { throw notFound(); };
  adapter.send = async () => {};
  let starts = 0;
  adapter.ensureSession = async () => { starts += 1; return { status: "ready" }; };
  const message = (id, text) => ({ chat: { id: 42 }, message_id: id, text });
  adapter.dispatch({ update_id: 1, message: message(1, "/project B") });
  adapter.dispatch({ update_id: 2, message: message(2, "work in B") });
  adapter.dispatch({ update_id: 3, message: message(3, "/project A") });
  const deadline = Date.now() + 2000;
  while (adapter.chains.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(adapter.routeStore.get("42:main").project, "A");
  assert.equal(starts, 0);
});

test("driver selection preserves a saved project session that already uses the requested driver", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-driver-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "project"));
  const adapter = new TelegramAdapter({
    config: {
      stateDir: path.join(root, "state"),
      telegram: { token: "token", defaultDriver: "codex", projectsRoot: root, allowedChatIds: new Set() },
    },
  });
  await adapter.init();
  await adapter.routeStore.update("42:main", { driver: "codex", project: "project" });
  let closes = 0;
  adapter.runtime = async (method) => {
    if (method === "GET") return { session: { driver: "claude", status: "stopped", activeSubmissionId: null } };
    if (method === "DELETE") closes += 1;
    return { ok: true };
  };
  adapter.send = async () => {};
  await adapter.controlDriver(
    { chat: { id: 42 }, message_id: 1 },
    { name: "driver", argument: "claude" },
  );
  assert.equal(closes, 0);
  assert.deepEqual(adapter.routeStore.get("42:main"), { driver: "claude", project: "project" });
});
