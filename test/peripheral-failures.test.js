"use strict";

// Fault injection for the project invariant: a failure in observability, history,
// enrichment, or announcement must never fail the work a user asked for.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Tmux } = require("../src/drivers/tmux");
const { SessionManager } = require("../src/core/session-manager");
const { TelegramAdapter } = require("../src/surface/telegram");
const { EventStore } = require("../src/core/event-store");
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
  let drained = 0;
  adapter.notices = {
    init: async () => { throw new Error("mkdir denied"); },
    drain: async () => { drained += 1; return []; },
  };
  adapter.runMarker = { start: async () => { throw new Error("marker unavailable"); }, markCleanStop: async () => {} };

  await adapter.init();
  assert.ok(logged.some((line) => /notice spool unavailable/.test(line)));
  // Each startup courtesy degrades on its own: a failed spool or announcement must
  // not skip the ones after it.
  assert.equal(drained, 1, "notice delivery still ran after the spool failed");
  assert.equal(adapter.offset, 0, "ingress state is still initialized");
});

test("appending never throws into its caller, even through a bad listener", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-append-throw-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root);
  await store.init();

  store.events.on("event", () => { throw new Error("listener exploded"); });
  // note() attaches .catch() after the call returns, so a synchronous throw would
  // escape it entirely and fail whatever the runtime was doing.
  assert.doesNotThrow(() => store.append("t.listener", { sessionKey: "main" }));
  await store.append("t.listener.again", { sessionKey: "main" });
  assert.equal(store.read({ after: 0 }).length, 2, "both events are still recorded");

  const circular = { sessionKey: "main" };
  circular.self = circular;
  await assert.rejects(() => store.append("t.circular", circular), /circular|convert/i);
});

test("a listener that appends re-entrantly cannot reorder or lose the file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-append-reentrant-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root, { maxBytes: 600, maxEvents: 4 });
  await store.init();

  let reentered = false;
  store.events.on("event", (event) => {
    if (reentered || event.type !== "t.outer") return;
    reentered = true;
    store.append("t.inner", { sessionKey: "main" }).catch(() => {});
  });
  for (let index = 0; index < 12; index += 1) await store.append("t.outer", { index, sessionKey: "main" });
  await store.writeChain;

  const lines = (await fs.readFile(path.join(root, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  const sequences = lines.map((line) => JSON.parse(line).sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "the file stays ordered by sequence");
  assert.equal(new Set(sequences).size, sequences.length, "no record is written twice");
  assert.ok(reentered, "the re-entrant append actually ran");
});

test("a hung filesystem sheds durable writes instead of growing without bound", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-write-shed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root, { maxPendingWrites: 20 });
  await store.init();

  // A disk that accepts writes and never completes them: the failure mode that has
  // no error to catch.
  const realAppendFile = fs.appendFile;
  let held = [];
  fs.appendFile = (...args) => new Promise((resolve) => { held.push(() => resolve(realAppendFile(...args))); });
  t.after(() => { fs.appendFile = realAppendFile; });

  for (let index = 0; index < 500; index += 1) store.append("t.flood", { index, sessionKey: "main" });
  assert.ok(store.pendingWrites <= 20, `pending writes stayed bounded, saw ${store.pendingWrites}`);
  assert.ok(store.droppedWrites > 400, `most writes were shed, saw ${store.droppedWrites}`);
  assert.equal(store.read({ after: store.sequence - 3 }).length, 3, "events remain readable while the disk is stuck");

  // The disk recovers: the backlog drains and the loss is recorded as an event.
  fs.appendFile = realAppendFile;
  for (const release of held) release();
  held = [];
  await store.writeChain;
  await new Promise((resolve) => setImmediate(resolve));
  const reported = store.read({ after: 0, limit: 5000 }).filter((event) => event.type === "runtime.events_dropped");
  assert.equal(reported.length, 1);
  assert.ok(reported[0].dropped > 400);
  assert.equal(store.droppedWrites, 0, "the counter resets once reported");
});

test("the last net settles a submission even when the rejection carries no error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-nullish-reject-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = new SessionManager({
    config: { stateDir: root },
    tmux: {},
    eventStore: brokenEventStore(),
  });
  await sessions.init();

  const session = { sessionKey: "main", driver: "claude", workspace: root, status: "running", activeSubmissionId: "sub-1" };
  const submission = { submissionId: "sub-1", sessionKey: "main", status: "running", workspace: root };
  const activeRuntime = { submission, interrupted: false };
  sessions.sessions.set("main", session);
  sessions.active.set("main", activeRuntime);

  await sessions.failUnexpectedExecution(session, submission, activeRuntime, undefined);

  assert.equal(submission.status, "failed");
  assert.match(submission.error, /unexpected execution failure: undefined/);
  assert.equal(session.status, "attention_required");
  assert.equal(session.activeSubmissionId, null);
  assert.equal(sessions.active.has("main"), false, "the session is released, not left busy forever");
});

test("the service installs a backstop so one stray rejection cannot end it", () => {
  const before = process.listenerCount("unhandledRejection");
  installRejectionBackstop("test");
  const added = process.listeners("unhandledRejection").at(-1);
  assert.equal(process.listenerCount("unhandledRejection"), before + 1);
  process.off("unhandledRejection", added);
});
