"use strict";

// A stopped turn leaves its partial paste in the composer. The next prompt must
// replace it, not land on top of it and submit both as one fused message.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");
const { Tmux } = require("../src/tmux");
const { SessionManager } = require("../src/session-manager");
const { composerResidue } = require("../src/drivers");

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

test("leftover composer text is read as residue, an empty prompt is not", () => {
  assert.equal(composerResidue("claude", "❯ "), "");
  assert.equal(composerResidue("claude", "❯ Ok lets move on with the second"), "Ok lets move on with the second");
  assert.equal(composerResidue("codex", "› "), "");
  assert.equal(composerResidue("codex", "› half a pasted prompt"), "half a pasted prompt");
  assert.equal(composerResidue("claude", ""), "");
});

test("a prompt is never pasted on top of what a stopped turn left behind", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-residue-"));
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude-home");
  await Promise.all([workspace, claudeHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  const config = {
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime.sock"),
    tmuxSocketName: `cli-runtime-residue-${process.pid}-${Date.now()}`,
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
  const events = new EventStore(config.stateDir);
  await events.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore: events });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await sessions.workspaceState.waitForPrunes().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const created = await sessions.create({ sessionKey: "main", driver: "claude", workspace });
  assert.equal(created.status, "ready", JSON.stringify(created));

  // What an interrupted paste leaves behind: text typed into the composer, never sent.
  const paneName = sessions.rawSession("main").tmuxSessionName;
  await tmux.sendLiteral(paneName, "half of an abandoned prompt");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    composerResidue("claude", await tmux.cursorLine(paneName)),
    "half of an abandoned prompt",
    "the leftover is really sitting in the composer",
  );

  const submitted = await sessions.submit("main", { message: "the only message that should run" });
  const done = await waitFor(async () => {
    const value = await sessions.getSubmission(submitted.submissionId);
    return ["completed", "failed"].includes(value?.status) ? value : null;
  });

  assert.equal(done.status, "completed", done.error || "");
  assert.match(done.reply, /the only message that should run/);
  assert.doesNotMatch(done.reply, /abandoned/, "the leftover text never reached the driver");
});

test("a composer that refuses to clear fails the turn instead of fusing prompts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-residue-stuck-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keys = [];
  const sessions = new SessionManager({
    config: { stateDir: root },
    tmux: {
      sendKey: async (name, key) => { keys.push(key); },
      cursorLine: async () => "❯ stubborn leftover text",
    },
    eventStore: { append: () => Promise.resolve(), read: () => [], wait: async () => [] },
  });

  const cleared = await sessions.clearComposer({ driver: "claude", tmuxSessionName: "x" });
  assert.equal(cleared.ok, false);
  assert.equal(cleared.residue, "stubborn leftover text");
  assert.ok(keys.filter((key) => key === "C-u").length >= 3, "it tried more than once before giving up");
});
