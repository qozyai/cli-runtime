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
const { request } = require("../src/client");

async function waitForSubmission(socketPath, submissionId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await request(socketPath, "GET", `/v1/submissions/${encodeURIComponent(submissionId)}`);
    if (["completed", "failed", "interrupted"].includes(value.submission.status)) return value.submission;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("submission timed out");
}

test("Unix socket API exposes asynchronous sessions and durable long-poll events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-server-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-server-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 5000,
    submissionTimeoutMs: 5000,
    artifactPollMs: 25,
    drivers: {
      claude: { command: mockDriver, homeDir: home, model: "", permissionMode: "bypassPermissions", extraArgs: [] },
      codex: { command: mockDriver, homeDir: home, model: "", sandbox: "danger-full-access", approval: "never", extraArgs: [] },
    },
  };
  const events = new EventStore(config.stateDir);
  await events.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore: events });
  await sessions.init();
  const auth = { status: async () => ({ authenticated: true }), start: async () => ({}), submit: async () => ({}) };
  const server = createServer({ config, sessions, auth, eventStore: events });
  await server.start();
  t.after(async () => {
    await server.stop();
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await request(config.socketPath, "GET", "/health")).ok, true);
  const created = await request(config.socketPath, "POST", "/v1/sessions", {
    sessionKey: "api/main",
    driver: "claude",
    workspace,
  });
  assert.equal(created.session.status, "ready");
  const accepted = await request(
    config.socketPath,
    "POST",
    `/v1/sessions/${encodeURIComponent("api/main")}/submissions`,
    { message: "through api", idempotencyKey: "api-one" },
  );
  assert.equal(accepted.submission.status, "accepted");
  const completed = await waitForSubmission(config.socketPath, accepted.submission.submissionId);
  assert.match(completed.reply, /through api/);
  await assert.rejects(
    () => request(config.socketPath, "POST", "/v1/sessions", {
      sessionKey: "api/main",
      driver: "codex",
      workspace,
    }),
    (error) => error.statusCode === 409 && error.code === "SESSION_IDENTITY_MISMATCH",
  );
  const released = await request(
    config.socketPath,
    "POST",
    `/v1/sessions/${encodeURIComponent("api/main")}/release`,
    {},
  );
  assert.equal(released.session.status, "stopped");
  const resumed = await request(
    config.socketPath,
    "POST",
    `/v1/sessions/${encodeURIComponent("api/main")}/restart`,
    {},
  );
  assert.equal(resumed.session.status, "ready");

  const replay = await request(config.socketPath, "GET", `/v1/events?after=0&sessionKey=${encodeURIComponent("api/main")}`);
  assert.ok(replay.events.some((event) => event.type === "submission.completed"));
  const after = events.sequence;
  const waiting = request(config.socketPath, "GET", `/v1/events?after=${after}&waitMs=2000`);
  await events.append("test.event", { sessionKey: "api/main" });
  const awakened = await waiting;
  assert.equal(awakened.events[0].type, "test.event");
  await assert.rejects(
    () => request(config.socketPath, "POST", `/v1/sessions/${encodeURIComponent("missing")}/interrupt`, {}),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => request(config.socketPath, "GET", "/v1/events?limit=not-a-number"),
    (error) => error.statusCode === 400,
  );
});

test("a second daemon cannot take a live state directory or unlink its socket", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-singleton-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configA = { stateDir: path.join(root, "state"), socketPath: path.join(root, "a.sock") };
  const configB = { stateDir: configA.stateDir, socketPath: path.join(root, "b.sock") };
  const eventsA = new EventStore(configA.stateDir);
  const eventsB = new EventStore(configB.stateDir);
  await eventsA.init();
  await eventsB.init();
  const noopSessions = { list: async () => [] };
  const noopAuth = {};
  const first = createServer({ config: configA, sessions: noopSessions, auth: noopAuth, eventStore: eventsA });
  const second = createServer({ config: configB, sessions: noopSessions, auth: noopAuth, eventStore: eventsB });
  await first.start();
  t.after(() => first.stop());
  await assert.rejects(() => second.start(), (error) => error.code === "RUNTIME_ALREADY_RUNNING");
  assert.equal((await request(configA.socketPath, "GET", "/health")).ok, true);
  await assert.rejects(() => fs.access(configB.socketPath));
});
