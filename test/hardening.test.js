"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/core/event-store");
const { redactText } = require("../src/core/progress");
const { acquireRuntimeLock } = require("../src/core/runtime-lock");
const { Tmux } = require("../src/drivers/tmux");
const { isReady } = require("../src/drivers/drivers");
const { parseSendArguments } = require("../src/main");

test("redaction removes opaque bearer and quoted secret values", () => {
  const value = redactText('Authorization: Bearer opaque-token-value-123456 password="hunter2hunter2" token=plain-token');
  assert.doesNotMatch(value, /opaque-token|hunter2|plain-token/);
  assert.match(value, /Authorization: .*\[redacted\]/);
});

test("tmux driver state cannot be forged through a pane option", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-tmux-state-"));
  const socket = `cli-runtime-state-${process.pid}-${Date.now()}`;
  const tmux = new Tmux(socket);
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  await tmux.createShell("driver", root);
  await tmux.startCommand("driver", "sh", ["-c", "tmux set-option -p @cli_runtime_driver_state exited:9; sleep 1; exit 7"], {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await tmux.driverState("driver"), { paneDead: false, state: "running", exitCode: null });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(await tmux.driverState("driver"), { paneDead: true, state: "exited", exitCode: 7 });
});

test("driver panes do not inherit runtime credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-tmux-env-"));
  const socket = `cli-runtime-env-${process.pid}-${Date.now()}`;
  const tmux = new Tmux(socket);
  const secretKeys = ["OPENAI_API_KEY", "GH_PAT", "DATABASE_URL", "STRIPE_SK", "SLACK_WEBHOOK"];
  const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
  for (const key of secretKeys) process.env[key] = "must-not-reach-driver";
  t.after(async () => {
    for (const key of secretKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  await tmux.createShell("driver", root);
  await tmux.startCommand("driver", "sh", ["-c", [
    "test -n \"$PATH\"",
    `test \"$HOME\" = \"${root}\"`,
    ...secretKeys.map((key) => `test -z \"$${key}\"`),
  ].join(" && ")], { HOME: root });
  const deadline = Date.now() + 2000;
  let state = await tmux.driverState("driver");
  while (!state.paneDead && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = await tmux.driverState("driver");
  }
  assert.equal(state.exitCode, 0);
});

test("driver state waits for tmux to publish a dead pane exit status", async () => {
  const tmux = new Tmux("unused");
  let reads = 0;
  tmux.run = async () => {
    reads += 1;
    return reads < 8 ? "1\t\n" : "1\t7\n";
  };
  assert.deepEqual(await tmux.driverState("driver"), { paneDead: true, state: "exited", exitCode: 7 });
  assert.equal(reads, 8);
});

test("event compaction is amortized after the in-memory ring fills", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-event-amortized-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root, { maxBytes: 1024 * 1024, maxEvents: 3 });
  await store.init();
  let compactions = 0;
  const compact = store.compact.bind(store);
  store.compact = async () => { compactions += 1; return compact(); };
  for (let index = 0; index < 7; index += 1) await store.append("probe", { index });
  assert.equal(compactions, 1);
  assert.equal(store.read({ after: 4 }).length, 3);
});

test("concurrent stale-lock recovery has exactly one winner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-lock-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "runtime.lock"), JSON.stringify({ pid: 2147483647, token: "stale" }));
  const results = await Promise.allSettled([acquireRuntimeLock(root), acquireRuntimeLock(root)]);
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  await winners[0].value.release();
});

test("startup dialogs are not mistaken for an editable prompt", () => {
  assert.equal(isReady("claude", "Security notes\n❯ 1. Continue"), false);
  assert.equal(isReady("codex", "Do you trust the contents of this directory?\n› 1. Yes"), false);
  assert.equal(isReady("claude", "Unknown startup choice\n❯ 2. Continue"), false);
  assert.equal(isReady("codex", "Unknown startup choice\n› 3) Continue"), false);
  assert.equal(isReady("claude", "Claude Code\n❯ "), true);
  assert.equal(isReady("codex", "Codex\n› "), true);
  assert.equal(isReady("codex", "Codex\n› Explain this codebase"), true);
  assert.equal(isReady("codex", [
    "Do you trust the contents of this directory?",
    "› 1. Yes, continue",
    "Update available!",
    "OpenAI Codex",
    "› ",
  ].join("\n")), true);
  assert.equal(isReady("codex", [
    "OpenAI Codex",
    "› ",
    "still working",
  ].join("\n")), false);
});

test("explicit CLI option separator preserves option-like message text", () => {
  const parsed = parseSendArguments(["main", "--wait", "--idempotency", "one", "--", "explain", "--wait", "literally"]);
  assert.equal(parsed.sessionKey, "main");
  assert.equal(parsed.wait, true);
  assert.equal(parsed.idempotencyKey, "one");
  assert.equal(parsed.message, "explain --wait literally");
});
