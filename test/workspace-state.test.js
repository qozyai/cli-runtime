"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceState, readJsonlLossless, selectRecentTurns } = require("../src/workspace-state");
const { normalizeProgress, summarizeProgress } = require("../src/progress");

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace, state: new WorkspaceState({ config }) };
}

function submission(id, status = "completed") {
  return {
    submissionId: id,
    status,
    message: "make a file",
    inputs: [],
    reply: status === "completed" ? "done" : null,
    error: status === "completed" ? null : "failed",
    acceptedAt: "2026-08-01T00:00:00.000Z",
    startedAt: "2026-08-01T00:00:01.000Z",
    completedAt: "2026-08-01T00:00:02.000Z",
  };
}

async function begin(state, workspace, id, inputs = []) {
  return state.startTurn({
    workspace,
    sessionKey: "main",
    submissionId: id,
    driver: "codex",
    message: "make a file",
    inputs,
    acceptedAt: "2026-08-01T00:00:00.000Z",
  });
}

test("each submission owns exact inbox and outbox directories with individual delivery ack", async (t) => {
  const { root, workspace, state } = await fixture(t);
  const source = path.join(root, "voice.ogg");
  await fs.writeFile(source, "audio");
  const started = await begin(state, workspace, "sub_one", [{
    sourcePath: source,
    name: "voice.ogg",
    mimeType: "audio/ogg",
    transcript: "hello",
  }]);
  assert.match(started.inputs[0].path, /\.qozyai\/io\/inbox\/sub_one\/001_voice\.ogg$/);
  assert.match(started.promptContext, /outbox\/sub_one/);
  assert.match(started.promptContext, /transcript is automated and may contain recognition errors/);
  assert.match(started.promptContext, /Here is how I understood your prompt:/);
  assert.doesNotMatch(started.promptContext, /begin your response with `Voice transcript:`/i);
  const outbox = state.turnPaths(workspace, "sub_one").turnOutbox;
  await fs.writeFile(path.join(outbox, "answer.txt"), "answer");
  await fs.writeFile(path.join(outbox, "second.txt"), "second");
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: submission("sub_one"),
    progress: { toolUses: [{ id: "call-1", tool: "Bash", arguments: { password: "secret" }, success: true }] },
  });
  assert.deepEqual(finished.outputs.map((item) => item.originalName), ["answer.txt", "second.txt"]);
  assert.ok(finished.outputs.every((item) => item.deliveryStatus === "pending"));
  const acknowledged = await state.acknowledgeOutputs({
    workspace,
    sessionKey: "main",
    submissionId: "sub_one",
    outputs: finished.outputs,
    outputIds: [finished.outputs[0].outputId],
  });
  assert.equal(acknowledged[0].deliveryStatus, "delivered");
  assert.equal(acknowledged[1].deliveryStatus, "pending");
});

test("same-size and same-mtime output rewrites cannot be missed", async (t) => {
  const { workspace, state } = await fixture(t);
  await begin(state, workspace, "sub_rewrite");
  const filePath = path.join(state.turnPaths(workspace, "sub_rewrite").turnOutbox, "report.txt");
  await fs.writeFile(filePath, "AAAAAAAAAA");
  const timestamp = new Date("2026-08-01T00:00:00.000Z");
  await fs.utimes(filePath, timestamp, timestamp);
  await fs.writeFile(filePath, "BBBBBBBBBB");
  await fs.utimes(filePath, timestamp, timestamp);
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "claude",
    submission: submission("sub_rewrite"),
    progress: null,
  });
  assert.equal(await fs.readFile(finished.outputs[0].archivePath, "utf8"), "BBBBBBBBBB");
});

test("invalid output entries are reported without hiding valid siblings or later turns", async (t) => {
  const { workspace, state } = await fixture(t);
  await begin(state, workspace, "sub_invalid");
  const firstOutbox = state.turnPaths(workspace, "sub_invalid").turnOutbox;
  await fs.mkdir(path.join(firstOutbox, "directory"));
  await fs.writeFile(path.join(firstOutbox, "valid.txt"), "valid");
  const first = await state.finishTurn({
    workspace, sessionKey: "main", driver: "claude", submission: submission("sub_invalid"), progress: null,
  });
  assert.deepEqual(first.outputs.map((item) => item.originalName), ["valid.txt"]);
  assert.match(first.outputError, /not a direct regular file/);
  assert.equal((await fs.stat(path.join(state.turnPaths(workspace, "sub_invalid").turnHistoryOutbox, "directory"))).isDirectory(), true);

  await begin(state, workspace, "sub_later");
  await fs.writeFile(path.join(state.turnPaths(workspace, "sub_later").turnOutbox, "later.txt"), "later");
  const later = await state.finishTurn({
    workspace, sessionKey: "main", driver: "claude", submission: submission("sub_later"), progress: null,
  });
  assert.deepEqual(later.outputs.map((item) => item.originalName), ["later.txt"]);
  assert.equal(later.outputError, null);
});

test("output names are preserved without normalization collisions", async (t) => {
  const { workspace, state } = await fixture(t);
  await begin(state, workspace, "sub_names");
  const outbox = state.turnPaths(workspace, "sub_names").turnOutbox;
  await fs.writeFile(path.join(outbox, "final report.md"), "spaced");
  await fs.writeFile(path.join(outbox, "final-report.md"), "hyphenated");
  const finished = await state.finishTurn({
    workspace, sessionKey: "main", driver: "claude", submission: submission("sub_names"), progress: null,
  });
  assert.deepEqual(finished.outputs.map((item) => item.originalName), ["final report.md", "final-report.md"]);
  assert.equal(await fs.readFile(finished.outputs[0].archivePath, "utf8"), "spaced");
  assert.equal(await fs.readFile(finished.outputs[1].archivePath, "utf8"), "hyphenated");
});

test("failed finalization is discarded and repeated finalization is idempotent", async (t) => {
  const { workspace, state } = await fixture(t);
  await begin(state, workspace, "sub_failed");
  await fs.writeFile(path.join(state.turnPaths(workspace, "sub_failed").turnOutbox, "debug.txt"), "debug");
  const failed = submission("sub_failed", "failed");
  const first = await state.finishTurn({ workspace, sessionKey: "main", driver: "codex", submission: failed, progress: null });
  const second = await state.finishTurn({ workspace, sessionKey: "main", driver: "codex", submission: failed, progress: null });
  assert.equal(first.outputs[0].deliveryStatus, "discarded");
  assert.equal(second.reused, true);
  assert.equal(second.outputs[0].outputId, first.outputs[0].outputId);
});

test("input staging is transactional and abort-aware", async (t) => {
  const { root, workspace, state } = await fixture(t);
  const good = path.join(root, "good.txt");
  const link = path.join(root, "link.txt");
  await fs.writeFile(good, "good");
  await fs.symlink(good, link);
  await assert.rejects(() => begin(state, workspace, "sub_bad", [
    { sourcePath: good, name: "good.txt" },
    { sourcePath: link, name: "link.txt" },
  ]), /direct regular file/);
  await assert.rejects(() => fs.access(state.turnPaths(workspace, "sub_bad").turnInbox));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => state.startTurn({
    workspace,
    sessionKey: "main",
    submissionId: "sub_abort",
    driver: "claude",
    message: "stop",
    inputs: [{ sourcePath: good, name: "good.txt" }],
    acceptedAt: new Date().toISOString(),
    signal: controller.signal,
  }), /interrupted/);
});

test("history pruning quarantines malformed lines and keeps unclassifiable records", async (t) => {
  const { workspace, state } = await fixture(t);
  await state.ensure(workspace);
  const historyPath = state.historyPath(workspace, "main");
  const valid = { version: 1, submissionId: "valid", inboundAt: "2026-08-01T00:00:00Z", completedAt: "2026-08-01T00:01:00Z" };
  const unknown = { version: 99, submissionId: "unknown", inboundAt: "not-a-time", completedAt: null };
  await fs.writeFile(historyPath, `${JSON.stringify(valid)}\n{malformed}\n${JSON.stringify(unknown)}\n`);
  await state.prune(workspace);
  const text = await fs.readFile(historyPath, "utf8");
  assert.match(text, /"version":99/);
  const parsed = await readJsonlLossless(historyPath);
  assert.equal(parsed.errors.length, 0);
  const quarantine = (await fs.readdir(path.dirname(historyPath))).find((name) => name.startsWith(`${path.basename(historyPath)}.corrupt-`));
  assert.ok(quarantine);
  assert.match(await fs.readFile(path.join(path.dirname(historyPath), quarantine), "utf8"), /\{malformed\}/);
});

test("normalized progress omits tool arguments and preserves one tool identity shape", () => {
  const normalized = normalizeProgress({
    toolCounts: { successful: 10, failed: 3 },
    toolUses: [
      { id: "call-old", tool: "Read", detail: "/tmp/old", success: true },
      { id: "call-1", tool: "exec", arguments: { api_key: "secret" }, detail: "Deploy with token=hidden", success: false, error: "token=hidden" },
    ],
  });
  assert.equal(normalized.tools.length, 1);
  assert.deepEqual(Object.keys(normalized.tools[0]).sort(), ["detail", "error", "id", "success", "tool"]);
  assert.equal(normalized.tools[0].id, "call-1");
  assert.deepEqual(normalized.toolCounts, { successful: 10, failed: 3 });
  assert.doesNotMatch(JSON.stringify(normalized), /api_key|secret|token=hidden/);
  const summary = summarizeProgress({
    lastAssistantMessage: "Checking the release.",
    toolCounts: { successful: 10, failed: 3 },
    toolUses: [{ id: "call-1", tool: "exec", detail: "git diff --check", success: false, error: "failed" }],
  });
  assert.match(summary, /^Working\. \(10\/🔴3\)$/m);
  assert.match(summary, /^Current: Checking the release\.$/m);
  assert.match(summary, /^Last tool: exec — git diff --check \(🔴 failed: failed\)$/m);
  assert.doesNotMatch(summary, /Recent tools/);
});

test("48 active-hour retention keeps invalid timestamps and newest work clusters", () => {
  const turn = (id, start, hours) => ({
    submissionId: id,
    inboundAt: new Date(start).toISOString(),
    completedAt: new Date(new Date(start).getTime() + hours * 3600_000).toISOString(),
  });
  const turns = [
    turn("old", "2026-07-01T00:00:00Z", 30),
    turn("new-a", "2026-07-10T00:00:00Z", 30),
    turn("new-b", "2026-07-11T06:00:00Z", 30),
    { submissionId: "unknown", inboundAt: "bad", completedAt: null },
  ];
  const retained = selectRecentTurns(turns);
  assert.deepEqual(retained.map((item) => item.submissionId), ["new-a", "new-b", "unknown"]);
});

test("pruning retains an old turn while any output is still pending", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  const times = [
    ["2026-01-01T00:00:00.000Z", "2026-01-02T06:00:00.000Z"],
    ["2026-01-02T13:00:00.000Z", "2026-01-03T19:00:00.000Z"],
    ["2026-01-04T02:00:00.000Z", "2026-01-05T08:00:00.000Z"],
  ];
  const finished = [];
  for (let index = 0; index < times.length; index += 1) {
    const id = `sub_pending_${index}`;
    await begin(state, workspace, id);
    await fs.writeFile(path.join(state.turnPaths(workspace, id).turnOutbox, `output-${index}.txt`), String(index));
    const record = submission(id);
    record.acceptedAt = times[index][0];
    record.startedAt = times[index][0];
    record.completedAt = times[index][1];
    finished.push(await state.finishTurn({ workspace, sessionKey: "main", driver: "claude", submission: record, progress: null }));
  }
  for (const index of [1, 2]) {
    await state.acknowledgeOutputs({
      workspace,
      sessionKey: "main",
      submissionId: `sub_pending_${index}`,
      outputs: finished[index].outputs,
    });
  }
  await state.prune(workspace);
  const history = await readJsonlLossless(state.historyPath(workspace, "main"));
  assert.ok(history.records.some((record) => record.submissionId === "sub_pending_0"));
  await fs.access(finished[0].outputs[0].archivePath);
});
