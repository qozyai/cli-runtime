"use strict";

// Spec 0018. What is left of retention inside the runtime: the one decision that needs
// a record rather than an mtime. The workspace age floors and the maintenance clock are
// gone — `plugins/retention-sweep` owns age now.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../src/config");
const { SessionManager } = require("../src/core/session-manager");

function events() {
  const seen = [];
  return { seen, append: async (type, details) => { seen.push({ type, details }); } };
}

async function stateDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retention-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSubmission(dir, id, atMs, status = "completed") {
  const file = path.join(dir, "submissions", `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1, submissionId: id, sessionKey: "main", status,
    acceptedAt: new Date(atMs).toISOString(),
    completedAt: status === "accepted" ? null : new Date(atMs + 1000).toISOString(),
  }));
}

test("the runtime no longer carries a retention policy for files", () => {
  const config = loadConfig({});
  assert.equal(config.workspaceMediaMaxAgeMs, undefined, "the 30-day media floor left with 0018");
  assert.equal(config.workspaceFileMaxAgeMs, undefined, "and so did the 90-day file floor");
  assert.equal(config.maintenanceIntervalMs, undefined, "and the clock they needed");
});

test("what it does still carry is the record it is asked for by id", () => {
  const base = loadConfig({});
  assert.equal(base.operationalRecordKeep, 1000);
  assert.equal(base.operationalRecordGraceMs, 10 * 60_000);

  const tuned = loadConfig({
    CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "5000",
    CLI_RUNTIME_OPERATIONAL_RECORD_GRACE_MS: "0",
  });
  assert.equal(tuned.operationalRecordKeep, 5000);
  assert.equal(tuned.operationalRecordGraceMs, 0);
});

// A terminal record is how a caller collects its reply, so a small keep count is a race
// with the reply path rather than an aggressive cleanup setting. Out of range falls back
// rather than clamping: a number the runtime will not honour should produce documented
// behaviour, not a silently different one.
test("a keep count below the floor falls back rather than being honoured", () => {
  assert.equal(loadConfig({ CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "0" }).operationalRecordKeep, 1000,
    "zero would let a finished turn 404 before its caller polled");
  assert.equal(loadConfig({ CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "50" }).operationalRecordKeep, 1000);
  assert.equal(loadConfig({ CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "-1" }).operationalRecordKeep, 1000);
  assert.equal(loadConfig({ CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "2.5" }).operationalRecordKeep, 1000);
  assert.equal(loadConfig({ CLI_RUNTIME_OPERATIONAL_RECORD_KEEP: "100" }).operationalRecordKeep, 100,
    "the floor itself is honoured");
});

test("there is no maintenance clock to start", () => {
  const manager = new SessionManager({ config: loadConfig({}), tmux: {}, eventStore: events() });
  assert.equal(typeof manager.startMaintenance, "undefined");
  assert.equal(typeof manager.runMaintenance, "undefined");
  assert.equal(typeof manager.maintenanceWorkspaces, "undefined");
});

test("the operational prune honours the configured keep count", async (t) => {
  const dir = await stateDir(t);
  const base = Date.parse("2026-08-01T00:00:00Z");
  for (let i = 0; i < 6; i += 1) await writeSubmission(dir, `sub_${i}`, base + i * 60_000);
  await writeSubmission(dir, "sub_open", base + 10 * 60_000, "accepted");

  const manager = new SessionManager({
    config: { ...loadConfig({}), stateDir: dir, operationalRecordKeep: 2 },
    tmux: {},
    eventStore: events(),
  });
  await manager.pruneOperationalState();

  const left = (await fs.readdir(path.join(dir, "submissions"))).sort();
  assert.equal(left.length, 3, "two terminal records plus the open one");
  assert.ok(left.includes("sub_open.json"), "an open submission is never a candidate");
  assert.ok(left.includes("sub_5.json") && left.includes("sub_4.json"), "the newest two survive");
});

test("a record inside the grace window is never pruned, however far down the list", async (t) => {
  const dir = await stateDir(t);
  const now = Date.now();
  for (let i = 0; i < 12; i += 1) await writeSubmission(dir, `sub_now_${i}`, now - i * 1000);

  const manager = new SessionManager({
    config: { ...loadConfig({}), stateDir: dir, operationalRecordKeep: 2, operationalRecordGraceMs: 10 * 60_000 },
    tmux: {},
    eventStore: events(),
  });
  await manager.pruneOperationalState();
  assert.equal((await fs.readdir(path.join(dir, "submissions"))).length, 12,
    "ten records are over the keep count and none may go, because all finished seconds ago");

  const impatient = new SessionManager({
    config: { ...loadConfig({}), stateDir: dir, operationalRecordKeep: 2, operationalRecordGraceMs: 0 },
    tmux: {},
    eventStore: events(),
  });
  await impatient.pruneOperationalState();
  assert.equal((await fs.readdir(path.join(dir, "submissions"))).length, 2, "with no grace, the count decides");
});
