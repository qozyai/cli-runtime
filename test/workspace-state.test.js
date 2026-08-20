"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceState, readJsonlLossless, selectRecentTurns } = require("../src/core/workspace-state");
const { normalizeProgress, summarizeProgress } = require("../src/core/progress");
const { historyProgress, publicProgress } = require("../src/core/artifacts");

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const state = new WorkspaceState({ config });
  t.after(async () => {
    await state.waitForPrunes();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, state };
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
    reasoning: ["Internal reasoning should not be displayed."],
    lastAssistantMessage: "Checking the release.",
    toolCounts: { successful: 10, failed: 3 },
    toolUses: [{ id: "call-1", tool: "exec", detail: "git diff --check", success: false, error: "failed" }],
  });
  assert.match(summary, /^Working\. \(10\/🔴3\)$/m);
  assert.match(summary, /^Checking the release\.$/m);
  assert.doesNotMatch(summary, /Internal reasoning/);
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

test("history keeps every tool call while the progress bubble keeps only the last", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  await begin(state, workspace, "sub_tools");
  const toolUses = Array.from({ length: 25 }, (_, index) => ({
    id: `call-${index}`,
    tool: index === 7 ? "Edit" : "Bash",
    success: index !== 7,
    error: index === 7 ? "permission denied" : null,
    detail: `step ${index}`,
  }));
  const snapshot = { toolUses, toolCounts: { successful: 24, failed: 1 }, reasoning: [] };
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: submission("sub_tools"),
    progress: snapshot,
    historyProgress: snapshot,
  });

  assert.equal(finished.record.tools.length, 25);
  assert.deepEqual(finished.record.tools.map((tool) => tool.id).slice(0, 3), ["call-0", "call-1", "call-2"]);
  assert.equal(finished.record.tools[7].success, false);
  assert.equal(finished.record.tools[7].error, "permission denied");
  // Counts stay exact so a sequence trimmed by the ceiling declares itself.
  assert.deepEqual(finished.record.toolCounts, { successful: 24, failed: 1 });
  // The bubble is unchanged: one entry, and it is the most recent call.
  assert.deepEqual(normalizeProgress(snapshot).tools.map((tool) => tool.id), ["call-24"]);
  assert.match(summarizeProgress(snapshot, "running"), /Last tool: Bash/);
});

test("history falls back to the reduced progress when no durable snapshot was captured", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  await begin(state, workspace, "sub_fallback");
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: submission("sub_fallback"),
    progress: { toolUses: [{ id: "only", tool: "Bash", success: true }], toolCounts: { successful: 4, failed: 0 } },
  });
  assert.deepEqual(finished.record.tools.map((tool) => tool.id), ["only"]);
  assert.deepEqual(finished.record.toolCounts, { successful: 4, failed: 0 });
});

// Spec 0018. This test used to assert the opposite: an archived directory expired on
// age even while its turn was retained. Age is no longer the runtime's business — the
// archive goes when nothing references it, and `retention-sweep` expires it afterwards.
test("an archived directory outlives any age while its turn is still retained", async (t) => {
  const { root, workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  const source = path.join(root, "voice.ogg");
  await fs.writeFile(source, "audio");
  await begin(state, workspace, "sub_media", [{ sourcePath: source, name: "voice.ogg", mimeType: "audio/ogg" }]);
  await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: submission("sub_media"),
    progress: null,
  });
  const paths = state.paths(workspace);
  const dir = path.join(paths.historyInbox, "sub_media");
  const names = await fs.readdir(dir);
  assert.ok(names.length > 0, "the archive has the staged file in it");
  const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  for (const name of names) await fs.utimes(path.join(dir, name), ancient, ancient);

  await state.prune(workspace);

  assert.deepEqual((await fs.readdir(dir).catch(() => [])).sort(), names.sort(),
    "four hundred days old and retained, so the runtime keeps every file in it");
  const history = await readJsonlLossless(state.historyPath(workspace, "main"));
  assert.deepEqual(history.records.map((record) => record.submissionId), ["sub_media"]);
});

// Spec 0018, and the test that had to fail first: the runtime no longer deletes by age
// at all. Both floors and the whole tree walk are gone, which also removes the traversal
// the symlink guards existed to protect.
test("the runtime does not delete anything for being old", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  await begin(state, workspace, "sub_floor");
  await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: submission("sub_floor"),
    progress: null,
  });
  const paths = state.paths(workspace);
  const stale = path.join(paths.historyOutbox, "sub_floor", "stale.txt");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, "old");
  const memory = path.join(paths.root, "memory", "daily", "2026-01-01", "user.md");
  await fs.mkdir(path.dirname(memory), { recursive: true });
  await fs.writeFile(memory, "what the owner decided");
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  await fs.utimes(memory, old, old);

  await state.prune(workspace);

  assert.ok(await fs.stat(stale).catch(() => null), "an aged file in the runtime's own tree survives");
  assert.ok(await fs.stat(memory).catch(() => null), "and so, still, does memory");
  assert.equal(typeof state.sweepAgedFiles, "undefined", "the sweep itself is gone, not merely disabled");
});

test("a scheduled storm cannot evict the conversation it interrupted", () => {
  const turn = (id, start, hours, source) => ({
    submissionId: id,
    source,
    inboundAt: new Date(start).toISOString(),
    completedAt: new Date(new Date(start).getTime() + hours * 3600_000).toISOString(),
  });
  const turns = [
    turn("owner-old", "2026-07-01T00:00:00Z", 1, "owner"),
    // Three days of wakes with no six-hour break anywhere in them.
    turn("wake-a", "2026-07-10T00:00:00Z", 24, "scheduler"),
    turn("wake-b", "2026-07-11T00:00:00Z", 24, "scheduler"),
    turn("wake-c", "2026-07-12T00:00:00Z", 24, "scheduler"),
    turn("owner-new", "2026-07-13T00:00:00Z", 1, "owner"),
  ];
  const retained = selectRecentTurns(turns).map((item) => item.submissionId);
  // Counting the wakes would make one 73-hour cluster, spend the whole budget on
  // it, and drop the older conversation. Counting only the owner keeps 2 hours.
  assert.ok(retained.includes("owner-old"), "older conversation survives the storm");
  // The wakes are still history: they simply no longer decide where the line falls.
  assert.deepEqual(retained, ["owner-old", "wake-a", "wake-b", "wake-c", "owner-new"]);
});

test("a session that is only ever woken still measures its own work", () => {
  const turn = (id, start, hours) => ({
    submissionId: id,
    source: "scheduler",
    inboundAt: new Date(start).toISOString(),
    completedAt: new Date(new Date(start).getTime() + hours * 3600_000).toISOString(),
  });
  const turns = [
    turn("old", "2026-07-01T00:00:00Z", 4),
    turn("recent-a", "2026-07-10T00:00:00Z", 30),
    turn("recent-b", "2026-07-11T06:00:00Z", 30),
  ];
  // With no owner turns there is nothing else to measure, so the original rule
  // applies rather than retaining everything for ever.
  assert.deepEqual(selectRecentTurns(turns).map((item) => item.submissionId), ["recent-a", "recent-b"]);
});

test("an unlabelled turn counts as the owner speaking", () => {
  const turn = (id, start, hours, source) => ({
    submissionId: id,
    ...(source ? { source } : {}),
    inboundAt: new Date(start).toISOString(),
    completedAt: new Date(new Date(start).getTime() + hours * 3600_000).toISOString(),
  });
  const turns = [
    turn("legacy-old", "2026-07-01T00:00:00Z", 30),
    turn("legacy-new-a", "2026-07-10T00:00:00Z", 30),
    turn("legacy-new-b", "2026-07-11T06:00:00Z", 30),
  ];
  // Every record written before this field existed has to keep meaning what it did.
  assert.deepEqual(
    selectRecentTurns(turns).map((item) => item.submissionId),
    ["legacy-new-a", "legacy-new-b"],
  );
});

test("the turn record carries who asked for it", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  await begin(state, workspace, "sub_owner");
  const owner = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "claude",
    submission: submission("sub_owner"),
    progress: null,
  });
  assert.equal(owner.record.source, "owner");

  await begin(state, workspace, "sub_wake");
  const woken = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    submission: { ...submission("sub_wake"), source: "scheduler" },
    progress: null,
  });
  assert.equal(woken.record.source, "scheduler");
});

test("the history snapshot survives the handoff the session manager actually makes", async (t) => {
  const { workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  await begin(state, workspace, "sub_handoff");
  const raw = {
    toolUses: [
      { id: "call-1", tool: "Bash", success: true, detail: "npm test" },
      { id: "call-2", tool: "Edit", success: false, error: "permission denied" },
    ],
    toolCounts: { successful: 1, failed: 1 },
    reasoning: [],
  };
  // This is the composed path: the session manager normalizes for history, then the
  // writer receives that object. Normalizing an already-normalized snapshot used to
  // empty it, so the record kept nonzero counts and no tools at all.
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "claude",
    submission: submission("sub_handoff"),
    progress: publicProgress(raw),
    historyProgress: historyProgress(raw),
  });
  assert.equal(finished.record.tools.length, 2);
  assert.deepEqual(finished.record.tools.map((tool) => tool.id), ["call-1", "call-2"]);
  assert.deepEqual(finished.record.toolCounts, { successful: 1, failed: 1 });
});

test("a session's first owner turn does not delete the scheduled history before it", () => {
  const turn = (id, start, hours, source) => ({
    submissionId: id,
    source,
    inboundAt: new Date(start).toISOString(),
    completedAt: new Date(new Date(start).getTime() + hours * 3600_000).toISOString(),
  });
  const scheduled = [
    turn("wake-1", "2026-07-01T00:00:00Z", 1, "scheduler"),
    turn("wake-2", "2026-07-02T00:00:00Z", 1, "scheduler"),
  ];
  // While nobody has spoken, the session measures itself and keeps everything.
  assert.deepEqual(selectRecentTurns(scheduled).map((t) => t.submissionId), ["wake-1", "wake-2"]);
  // The moment an owner turn appears, an owner-only boundary would sit after both
  // wakes and delete them — two hours of history lost to one minute of conversation.
  const withOwner = [...scheduled, turn("owner", "2026-07-03T00:00:00Z", 0.02, "owner")];
  assert.deepEqual(
    selectRecentTurns(withOwner).map((t) => t.submissionId),
    ["wake-1", "wake-2", "owner"],
  );
});

test("a freshly archived output is not pruned because its submission is old", async (t) => {
  const { root, workspace, state } = await fixture(t);
  state.schedulePrune = () => {};
  const source = path.join(root, "voice.ogg");
  await fs.writeFile(source, "audio");
  // The id says this turn was accepted long ago; the files were written just now.
  const id = "sub_20260101T000000000Z_old";
  await begin(state, workspace, id, [{ sourcePath: source, name: "voice.ogg", mimeType: "audio/ogg" }]);
  const record = submission(id);
  record.acceptedAt = "2026-01-01T00:00:00.000Z";
  record.completedAt = new Date().toISOString();
  await state.finishTurn({ workspace, sessionKey: "main", driver: "codex", submission: record, progress: null });

  await state.prune(workspace);

  const paths = state.paths(workspace);
  assert.ok(
    await fs.stat(path.join(paths.historyInbox, id)).catch(() => null),
    "age is a property of the files, not of when the submission was accepted",
  );
});
