"use strict";

// Fault injection for the project invariant: a failure in observability, history,
// enrichment, or announcement must never fail the work a user asked for.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Tmux } = require("../src/tmux");
const { SessionManager } = require("../src/session-manager");
const { TelegramAdapter } = require("../src/telegram");
const { installRejectionBackstop } = require("../src/main");

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

// Every write this store is asked to make fails, the way a full disk would.
function brokenEventStore() {
  const attempts = [];
  return {
    attempts,
    append(type) {
      attempts.push(type);
      return Promise.reject(new Error("event log unavailable"));
    },
    read: () => [],
    wait: async () => [],
  };
}

async function runtimeWith(t, label, { eventStore, workspaceState = null }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cli-runtime-${label}-`));
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude-home");
  await Promise.all([workspace, claudeHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-${label}-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 5000,
    submissionTimeoutMs: 0,
    submissionInactivityMs: 0,
    artifactPollMs: 25,
    drivers: {
      claude: {
        command: path.join(__dirname, "..", "fixtures", "mock-driver.js"),
        homeDir: claudeHome,
        model: "",
        permissionMode: "bypassPermissions",
        extraArgs: [],
      },
    },
  };
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore, workspaceState });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await sessions.workspaceState.waitForPrunes().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { sessions, workspace, config };
}

test("a turn completes and replies while every event write fails", async (t) => {
  const eventStore = brokenEventStore();
  const { sessions, workspace } = await runtimeWith(t, "events-broken", { eventStore });

  const created = await sessions.create({ sessionKey: "main", driver: "claude", workspace });
  assert.equal(created.status, "ready", JSON.stringify(created));

  const submitted = await sessions.submit("main", { message: "TOOL work despite the event log" });
  const done = await waitFor(async () => {
    const value = await sessions.getSubmission(submitted.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.match(done.reply, /MOCK_CLAUDE: TOOL work despite the event log/);
  assert.ok(eventStore.attempts.includes("submission.progress"), "progress events were still attempted");
  assert.equal((await sessions.get("main")).status, "ready");
});

test("a failing driver is still finalized while every event write fails", async (t) => {
  const eventStore = brokenEventStore();
  const { sessions, workspace } = await runtimeWith(t, "events-broken-fail", { eventStore });
  await sessions.create({ sessionKey: "main", driver: "claude", workspace });

  const submitted = await sessions.submit("main", { message: "EXIT" });
  const done = await waitFor(async () => {
    const value = await sessions.getSubmission(submitted.submissionId);
    return value?.status === "failed" ? value : null;
  });
  assert.match(done.error, /driver exited/);
  // The pane is gone, so the session reports stopped rather than a lost turn.
  await waitFor(async () => (await sessions.get("main")).status === "stopped");
});

test("a turn survives a history layer that fails every turn-state write", async (t) => {
  const eventStore = brokenEventStore();
  const { sessions, workspace } = await runtimeWith(t, "history-broken", { eventStore });
  // The workspace itself is core and must still be prepared; the per-turn history
  // writes on top of it are bookkeeping and are made to fail.
  sessions.workspaceState.updateTurn = async () => { throw new Error("history unavailable"); };
  sessions.workspaceState.finishTurn = async () => { throw new Error("history unavailable"); };

  const created = await sessions.create({ sessionKey: "main", driver: "claude", workspace });
  assert.equal(created.status, "ready", JSON.stringify(created));

  const submitted = await sessions.submit("main", { message: "history is broken" });
  const done = await waitFor(async () => {
    const value = await sessions.getSubmission(submitted.submissionId);
    return ["completed", "failed"].includes(value?.status) ? value : null;
  });
  assert.equal(done.status, "completed", done.error || "");
  assert.match(done.reply, /MOCK_CLAUDE: history is broken/);
  assert.equal((await sessions.get("main")).status, "ready");
});

test("a probe that throws leaves the timeout described, not replaced", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-probe-throw-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = new SessionManager({
    config: { stateDir: root, timeoutSettleMs: 300 },
    tmux: {
      interrupt: async () => {},
      driverState: async () => ({ paneDead: false }),
      capture: async () => "❯ ",
      sendKey: async () => { throw new Error("tmux server gone"); },
      sendLiteral: async () => {},
    },
    eventStore: brokenEventStore(),
  });

  const settle = await sessions.settleTimedOutDriver({ driver: "claude", tmuxSessionName: "x", sessionKey: "main" });
  assert.equal(settle.settled, false);
  assert.match(settle.reason, /tmux server gone/);
});

test("the adapter starts even when the notice spool cannot be created", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-spool-broken-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logged = [];
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => { throw new Error("no network in this test"); },
    log: (line) => logged.push(line),
  });
  adapter.notices = {
    init: async () => { throw new Error("mkdir denied"); },
    drain: async () => { throw new Error("mkdir denied"); },
  };
  adapter.runMarker = { start: async () => { throw new Error("marker unavailable"); }, markCleanStop: async () => {} };

  await adapter.init();
  assert.ok(logged.some((line) => /restart announcements unavailable/.test(line)));
  assert.equal(adapter.offset, 0, "ingress state is still initialized");
});

test("the service installs a backstop so one stray rejection cannot end it", () => {
  const before = process.listenerCount("unhandledRejection");
  installRejectionBackstop("test");
  const added = process.listeners("unhandledRejection").at(-1);
  assert.equal(process.listenerCount("unhandledRejection"), before + 1);
  process.off("unhandledRejection", added);
});
