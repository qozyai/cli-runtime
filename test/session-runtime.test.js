"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");
const { Tmux } = require("../src/tmux");
const { SessionManager } = require("../src/session-manager");

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

test("independent Claude and Codex sessions serialize their own submissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-test-"));
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude-home");
  const codexHome = path.join(root, "codex-home");
  await Promise.all([workspace, claudeHome, codexHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  const mockDriver = path.join(__dirname, "..", "fixtures", "mock-driver.js");
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-test-${process.pid}-${Date.now()}`,
    startupTimeoutMs: 5000,
    submissionTimeoutMs: 5000,
    artifactPollMs: 25,
    drivers: {
      claude: { command: mockDriver, homeDir: claudeHome, model: "", permissionMode: "bypassPermissions", extraArgs: [] },
      codex: { command: mockDriver, homeDir: codexHome, model: "", sandbox: "danger-full-access", approval: "never", extraArgs: [] },
    },
  };
  const events = new EventStore(config.stateDir);
  await events.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore: events });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  const claude = await sessions.create({ sessionKey: "main", driver: "claude", workspace });
  const codex = await sessions.create({ sessionKey: "delegate:one", driver: "codex", workspace });
  assert.equal(claude.status, "ready", JSON.stringify(claude));
  assert.equal(codex.status, "ready", JSON.stringify(codex));

  const slow = await sessions.submit("main", { message: "SLOW first", idempotencyKey: "one" });
  await assert.rejects(() => sessions.submit("main", { message: "must reject" }), /active submission/);
  const parallel = await sessions.submit("delegate:one", { message: "parallel" });

  const [slowDone, parallelDone] = await Promise.all([
    waitFor(async () => {
      const value = await sessions.getSubmission(slow.submissionId);
      return value?.status === "completed" ? value : null;
    }),
    waitFor(async () => {
      const value = await sessions.getSubmission(parallel.submissionId);
      return value?.status === "completed" ? value : null;
    }),
  ]);
  assert.match(slowDone.reply, /MOCK_CLAUDE: SLOW first/);
  assert.match(parallelDone.reply, /MOCK_CODEX: parallel/);
  assert.doesNotMatch(slowDone.reply, /cli-runtime-submission/);
  assert.doesNotMatch(parallelDone.reply, /cli-runtime-submission/);

  const same = await sessions.submit("main", { message: "ignored", idempotencyKey: "one" });
  assert.equal(same.submissionId, slow.submissionId);
  assert.ok(sessions.rawSession("main").providerSessionId);
  assert.ok(sessions.rawSession("delegate:one").providerSessionId);

  const fork = await sessions.create({
    sessionKey: "delegate:fork",
    driver: "claude",
    workspace,
    forkFromSessionKey: "main",
  });
  assert.equal(fork.status, "ready");
  const forked = await sessions.submit("delegate:fork", { message: "forked work" });
  const forkedDone = await waitFor(async () => {
    const value = await sessions.getSubmission(forked.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.match(forkedDone.reply, /forked work/);

  const restarted = await sessions.restart("main");
  assert.equal(restarted.status, "ready");
  const afterRestart = await sessions.submit("main", { message: "after restart" });
  const restartDone = await waitFor(async () => {
    const value = await sessions.getSubmission(afterRestart.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.match(restartDone.reply, /after restart/);

  const claudeTool = await sessions.submit("main", { message: "TOOL success" });
  const claudeToolDone = await waitFor(async () => {
    const value = await sessions.getSubmission(claudeTool.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.deepEqual(claudeToolDone.progress.toolUses[0], {
    tool: "Bash",
    arguments: { command: "true" },
    success: true,
    error: null,
  });

  const codexTool = await sessions.submit("delegate:one", { message: "TOOL success" });
  const codexToolDone = await waitFor(async () => {
    const value = await sessions.getSubmission(codexTool.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.deepEqual(codexToolDone.progress.toolUses[0], {
    tool: "exec",
    arguments: "true",
    success: true,
    error: null,
  });

  const output = await sessions.output("main");
  assert.match(output.terminal, /MOCK_CLAUDE/);
  assert.match((await sessions.attachInfo("main")).command, /tmux -L/);
  const replay = await events.read({ after: 0, sessionKey: "main" });
  assert.ok(replay.some((event) => event.type === "submission.completed"));

  const interrupted = await sessions.submit("main", { message: "SLOW interrupt me" });
  await waitFor(async () => (await sessions.getSubmission(interrupted.submissionId))?.status === "running");
  assert.equal((await sessions.interrupt("main")).interrupted, true);
  const interruptedDone = await waitFor(async () => {
    const value = await sessions.getSubmission(interrupted.submissionId);
    return value?.status === "interrupted" ? value : null;
  });
  assert.match(interruptedDone.error, /interrupted/);

  await sessions.restart("main");
  const hanging = await sessions.submit("main", { message: "HANG", timeoutMs: 300 });
  const hangingDone = await waitFor(async () => {
    const value = await sessions.getSubmission(hanging.submissionId);
    return value?.status === "failed" ? value : null;
  });
  assert.match(hangingDone.error, /did not complete/);
  assert.equal((await sessions.get("main")).status, "attention_required");

  await sessions.restart("main");
  const exiting = await sessions.submit("main", { message: "EXIT" });
  const exitingDone = await waitFor(async () => {
    const value = await sessions.getSubmission(exiting.submissionId);
    return value?.status === "failed" ? value : null;
  });
  assert.match(exitingDone.error, /driver exited \(7\)/);
});
