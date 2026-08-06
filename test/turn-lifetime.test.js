"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { watchArtifacts } = require("../src/artifacts");
const { loadConfig } = require("../src/config");
const { EventStore } = require("../src/event-store");
const { Tmux } = require("../src/tmux");
const { SessionManager } = require("../src/session-manager");

function claudeUser(marker) {
  return { type: "user", sessionId: "claude-session", message: { content: marker } };
}

function claudeThinking(text) {
  return { type: "assistant", message: { content: [{ type: "thinking", thinking: text }], stop_reason: "tool_use" } };
}

function claudeAssistant(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } };
}

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

test("turn limits default to no wall clock and thirty minutes of silence", () => {
  const config = loadConfig({});
  assert.equal(config.submissionTimeoutMs, 0);
  assert.equal(config.submissionInactivityMs, 30 * 60_000);
  assert.equal(config.timeoutSettleMs, 5000);

  const configured = loadConfig({
    CLI_RUNTIME_SUBMISSION_TIMEOUT_MS: "900000",
    CLI_RUNTIME_SUBMISSION_INACTIVITY_MS: "0",
  });
  assert.equal(configured.submissionTimeoutMs, 900_000);
  assert.equal(configured.submissionInactivityMs, 0, "zero must disable stall detection, not fall back");
});

test("artifact activity resets the inactivity clock and silence expires it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-inactivity-"));
  const artifact = path.join(root, "session.jsonl");
  const marker = "<marker-inactivity/>";
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(artifact, `${JSON.stringify(claudeUser(marker))}\n`);

  const activity = [];
  const watching = watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 0,
    inactivityMs: 300,
    pollMs: 5,
    onActivity: (at) => activity.push(at),
  });
  watching.catch(() => {});

  // Five records at 100ms outlive a 300ms window only if each one resets it.
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.appendFile(artifact, `${JSON.stringify(claudeThinking(`step ${index}`))}\n`);
  }
  assert.ok(activity.length >= 5, `expected activity per record, saw ${activity.length}`);

  const err = await watching.then(() => null, (error) => error);
  assert.equal(err?.code, "SUBMISSION_INACTIVITY_TIMEOUT");
  assert.equal(err.reason, "inactivity_timeout");
  assert.match(err.message, /no artifact activity for 300ms/);
});

test("neither polling nor another session's artifact keeps a stalled turn alive", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-inactivity-other-"));
  const artifact = path.join(root, "session.jsonl");
  const neighbour = path.join(root, "neighbour.jsonl");
  const marker = "<marker-neighbour/>";
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(artifact, `${JSON.stringify(claudeUser(marker))}\n`);
  await fs.writeFile(neighbour, "");

  const watching = watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 0,
    inactivityMs: 300,
    pollMs: 5,
  });
  watching.catch(() => {});
  const busy = setInterval(() => {
    fs.appendFile(neighbour, `${JSON.stringify(claudeThinking("other session"))}\n`).catch(() => {});
  }, 30);
  t.after(() => clearInterval(busy));

  const err = await watching.then(() => null, (error) => error);
  assert.equal(err?.code, "SUBMISSION_INACTIVITY_TIMEOUT");
});

test("a bound turn without limits is not ended by elapsed time", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-no-deadline-"));
  const artifact = path.join(root, "session.jsonl");
  const marker = "<marker-unbounded/>";
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(artifact, `${JSON.stringify(claudeUser(marker))}\n`);

  const watching = watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 0,
    inactivityMs: 0,
    pollMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await fs.appendFile(artifact, `${JSON.stringify(claudeAssistant("late but complete"))}\n`);
  const result = await watching;
  assert.equal(result.terminal, true);
  assert.equal(result.reply, "late but complete");
});

test("a driver that never comes back is reported unsettled, not warm", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-unsettled-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { stateDir: path.join(root, "state"), timeoutSettleMs: 300 };
  const session = { driver: "claude", tmuxSessionName: "stuck", sessionKey: "main" };

  const wedged = new SessionManager({
    config,
    tmux: {
      interrupt: async () => {},
      driverState: async () => ({ paneDead: false }),
      capture: async () => "Thinking… (esc to interrupt)",
    },
    eventStore: new EventStore(config.stateDir),
  });
  const stuck = await wedged.settleTimedOutDriver(session);
  assert.equal(stuck.settled, false);
  assert.match(stuck.reason, /did not return to its prompt/);

  const dead = new SessionManager({
    config,
    tmux: {
      interrupt: async () => {},
      driverState: async () => ({ paneDead: true, exitCode: 7 }),
      capture: async () => "",
    },
    eventStore: new EventStore(config.stateDir),
  });
  const exited = await dead.settleTimedOutDriver(session);
  assert.equal(exited.settled, false);
  assert.match(exited.reason, /driver exited \(7\)/);
});

test("a stalled turn is stopped, reported, and leaves the session warm", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-stall-"));
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude-home");
  await Promise.all([workspace, claudeHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-stall-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 5000,
    submissionTimeoutMs: 0,
    submissionInactivityMs: 400,
    timeoutSettleMs: 4000,
    artifactPollMs: 25,
    drivers: {
      claude: { command: mockDriver, homeDir: claudeHome, model: "", permissionMode: "bypassPermissions", extraArgs: [] },
    },
  };
  const events = new EventStore(config.stateDir);
  await events.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore: events });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await sessions.workspaceState.waitForPrunes();
    await fs.rm(root, { recursive: true, force: true });
  });

  const created = await sessions.create({ sessionKey: "main", driver: "claude", workspace });
  assert.equal(created.status, "ready", JSON.stringify(created));

  const stalled = await sessions.submit("main", { message: "STALL and never finish" });
  const stalledDone = await waitFor(async () => {
    const value = await sessions.getSubmission(stalled.submissionId);
    return value?.status === "failed" ? value : null;
  }, 15_000);
  assert.match(stalledDone.error, /no artifact activity for 400ms/);
  assert.match(stalledDone.error, /back at its prompt/);
  assert.ok(stalledDone.lastProgressAt, "the stalled turn records when the driver last produced a record");
  assert.ok(Date.parse(stalledDone.lastProgressAt) >= Date.parse(stalledDone.startedAt));

  // The pane survived, so the conversation continues in the same session.
  const session = await waitFor(async () => {
    const value = await sessions.get("main");
    return value?.status === "ready" ? value : null;
  }, 15_000);
  assert.equal(session.status, "ready");

  const timedOut = events.read({ limit: 500 }).filter((event) => event.type === "submission.timed_out");
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].reason, "inactivity_timeout");
  assert.equal(timedOut[0].settled, true);

  const next = await sessions.submit("main", { message: "continue normally" });
  const nextDone = await waitFor(async () => {
    const value = await sessions.getSubmission(next.submissionId);
    return value?.status === "completed" ? value : null;
  }, 15_000);
  assert.match(nextDone.reply, /MOCK_CLAUDE: continue normally/);
});
