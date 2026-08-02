"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  WorkspaceState,
  normalizeProgress,
  selectRecentTurns,
  summarizeProgress,
} = require("../src/workspace-state");

test("workspace state stages inputs, bounds progress, archives outputs, and waits for delivery ack", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "voice.ogg");
  await fs.mkdir(path.join(workspace, ".git", "info"), { recursive: true });
  await fs.writeFile(source, "audio-data");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: {} });
  const sessionKey = "telegram:42:main";
  const submissionId = "sub_test";
  const acceptedAt = "2026-08-02T10:00:00.000Z";
  const started = await state.startTurn({
    workspace,
    sessionKey,
    submissionId,
    driver: "claude",
    message: "Inspect sk-secret-value-that-must-not-leak",
    inputs: [{ sourcePath: source, name: "voice.ogg", mimeType: "audio/ogg", transcript: "spoken words" }],
    acceptedAt,
  });

  assert.equal(started.inputs.length, 1);
  assert.match(started.inputs[0].path, /\.qozyai\/io\/inbox\/[a-f0-9]{16}_001_voice\.ogg$/);
  assert.equal(await fs.readFile(started.inputs[0].path, "utf8"), "audio-data");
  assert.equal(await fs.readFile(started.inputs[0].transcriptPath, "utf8"), "spoken words");
  assert.match(await fs.readFile(path.join(workspace, ".git", "info", "exclude"), "utf8"), /^\.qozyai\/$/m);

  const progress = {
    throughOffset: 1234,
    providerSessionId: "provider-one",
    artifactPath: "/tmp/provider.jsonl",
    reasoning: ["one", "two", "three", "Using sk-another-secret-value to inspect four"],
    toolUses: [
      { id: "one", tool: "Read", arguments: { path: "a" }, success: true },
      { id: "two", tool: "Bash", arguments: { command: "true" }, success: true },
      { id: "three", tool: "Write", arguments: { apiKey: "must-hide" }, success: false, error: "Bearer secret-token-value failed" },
      { id: "four", tool: "Edit", arguments: { text: "x".repeat(5000) }, success: null },
    ],
  };
  const active = await state.updateTurn({ workspace, submissionId, progress, status: "running", startedAt: acceptedAt });
  assert.deepEqual(active.reasoning.slice(0, 2), ["two", "three"]);
  assert.match(active.reasoning[2], /\[redacted\]/);
  assert.equal(active.tools.length, 3);
  assert.equal(active.tools[1].arguments.apiKey, "[redacted]");
  assert.ok(active.summary.length <= 500);
  assert.doesNotMatch(JSON.stringify(active), /another-secret|must-hide|secret-token-value/);

  const outputName = `${state.sessionHash(sessionKey)}_report.docx`;
  const outputPath = path.join(workspace, ".qozyai", "io", "outbox", outputName);
  await fs.writeFile(outputPath, "word-file");
  const submission = {
    submissionId,
    message: "Inspect secret=do-not-store",
    inputs: started.inputs,
    outputBaseline: started.outputBaseline,
    status: "completed",
    reply: "Finished",
    error: null,
    acceptedAt,
    startedAt: acceptedAt,
    completedAt: "2026-08-02T10:01:00.000Z",
  };
  const finished = await state.finishTurn({ workspace, sessionKey, submission, driver: "claude", progress });
  assert.equal(finished.outputs.length, 1);
  assert.equal(finished.outputs[0].originalName, "report.docx");
  assert.equal(finished.outputs[0].mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(finished.outputs[0].deliveryStatus, "pending");
  assert.equal(await fs.readFile(finished.outputs[0].archivePath, "utf8"), "word-file");
  await assert.rejects(() => fs.access(state.activePath(workspace, submissionId)));

  const history = (await fs.readFile(state.historyPath(workspace, sessionKey), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(history.length, 1);
  assert.equal(history[0].tools.length, 3);
  assert.doesNotMatch(JSON.stringify(history), /do-not-store|another-secret|must-hide|secret-token-value/);

  const acknowledged = await state.acknowledgeOutputs({
    workspace,
    sessionKey,
    submissionId,
    outputs: finished.outputs,
  });
  assert.equal(acknowledged[0].deliveryStatus, "delivered");
  await assert.rejects(() => fs.access(outputPath));
  assert.equal(await fs.readFile(finished.outputs[0].archivePath, "utf8"), "word-file");
});

test("workspace state rejects symlink inputs and ignores unchanged pending output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  await fs.writeFile(target, "target");
  await fs.symlink(target, link);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: { workspaceMaxOutputFiles: 1 } });
  await assert.rejects(() => state.startTurn({
    workspace,
    sessionKey: "main",
    submissionId: "bad",
    driver: "codex",
    message: "file",
    inputs: [{ sourcePath: link, name: "link.txt" }],
    acceptedAt: "2026-08-02T10:00:00.000Z",
  }), /direct regular file/);

  await state.ensure(workspace);
  const outputPath = path.join(workspace, ".qozyai", "io", "outbox", `${state.sessionHash("main")}_pending.txt`);
  const secondOutputPath = path.join(workspace, ".qozyai", "io", "outbox", `${state.sessionHash("main")}_second.txt`);
  await fs.writeFile(outputPath, "pending");
  await fs.writeFile(secondOutputPath, "also pending");
  const started = await state.startTurn({
    workspace,
    sessionKey: "main",
    submissionId: "next",
    driver: "codex",
    message: "next",
    acceptedAt: "2026-08-02T11:00:00.000Z",
  });
  const finished = await state.finishTurn({
    workspace,
    sessionKey: "main",
    driver: "codex",
    progress: {},
    submission: {
      submissionId: "next",
      message: "next",
      inputs: [],
      outputBaseline: started.outputBaseline,
      status: "completed",
      reply: "done",
      acceptedAt: "2026-08-02T11:00:00.000Z",
      completedAt: "2026-08-02T11:01:00.000Z",
    },
  });
  assert.deepEqual(finished.outputs, []);
  assert.equal(await fs.readFile(outputPath, "utf8"), "pending");
  assert.equal(await fs.readFile(secondOutputPath, "utf8"), "also pending");
});

test("workspace input staging is transactional", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-stage-"));
  const workspace = path.join(root, "workspace");
  const valid = path.join(root, "valid.txt");
  const target = path.join(root, "target.txt");
  const invalid = path.join(root, "invalid.txt");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(valid, "valid");
  await fs.writeFile(target, "target");
  await fs.symlink(target, invalid);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: {} });
  const paths = await state.ensure(workspace);
  const existingPath = path.join(paths.inbox, `${state.sessionHash("main")}_existing.txt`);
  await fs.writeFile(existingPath, "existing");

  await assert.rejects(() => state.startTurn({
    workspace,
    sessionKey: "main",
    submissionId: "transactional",
    driver: "claude",
    message: "inspect inputs",
    inputs: [
      { sourcePath: valid, name: "valid.txt" },
      { sourcePath: invalid, name: "invalid.txt" },
    ],
    acceptedAt: "2026-08-02T12:00:00.000Z",
  }), /direct regular file/);

  assert.equal(await fs.readFile(existingPath, "utf8"), "existing");
  assert.deepEqual(await fs.readdir(paths.historyInbox), []);
});

test("failed output finalization is discarded and repeated finalization is idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-finalize-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: {} });
  const sessionKey = "delegate:failed";
  const submissionId = "failed-once";
  const acceptedAt = "2026-08-02T13:00:00.000Z";
  const started = await state.startTurn({
    workspace,
    sessionKey,
    submissionId,
    driver: "codex",
    message: "fail after writing",
    acceptedAt,
  });
  const outputPath = path.join(workspace, ".qozyai", "io", "outbox", `${state.sessionHash(sessionKey)}_partial.txt`);
  await fs.writeFile(outputPath, "partial output");
  const submission = {
    submissionId,
    message: "fail after writing",
    inputs: [],
    outputBaseline: started.outputBaseline,
    status: "failed",
    reply: "",
    error: "expected failure",
    acceptedAt,
    startedAt: acceptedAt,
    completedAt: "2026-08-02T13:01:00.000Z",
  };

  const first = await state.finishTurn({ workspace, sessionKey, submission, driver: "codex", progress: {} });
  assert.equal(first.outputs[0].deliveryStatus, "discarded");
  await assert.rejects(() => fs.access(outputPath));
  const second = await state.finishTurn({ workspace, sessionKey, submission, driver: "codex", progress: {} });
  assert.equal(second.reused, true);
  const history = (await fs.readFile(state.historyPath(workspace, sessionKey), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(history.length, 1);
});

test("output validation completes before any archive is created", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-output-validation-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: { workspaceMaxOutputFileBytes: 5 } });
  const sessionKey = "main";
  const acceptedAt = "2026-08-02T13:30:00.000Z";
  const started = await state.startTurn({
    workspace,
    sessionKey,
    submissionId: "invalid-outputs",
    driver: "claude",
    message: "write outputs",
    acceptedAt,
  });
  const outbox = state.paths(workspace).outbox;
  await fs.writeFile(path.join(outbox, `${state.sessionHash(sessionKey)}_a.txt`), "one");
  await fs.writeFile(path.join(outbox, `${state.sessionHash(sessionKey)}_b.txt`), "too-large");
  const finished = await state.finishTurn({
    workspace,
    sessionKey,
    driver: "claude",
    progress: {},
    submission: {
      submissionId: "invalid-outputs",
      message: "write outputs",
      inputs: [],
      outputBaseline: started.outputBaseline,
      status: "completed",
      reply: "done",
      acceptedAt,
      completedAt: "2026-08-02T13:31:00.000Z",
    },
  });
  assert.deepEqual(finished.outputs, []);
  assert.match(finished.outputError, /output file exceeds/);
  assert.deepEqual(await fs.readdir(state.paths(workspace).historyOutbox), []);
});

test("prefixed output directories fail explicitly instead of disappearing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-output-directory-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: {} });
  const sessionKey = "main";
  const acceptedAt = "2026-08-02T13:45:00.000Z";
  const started = await state.startTurn({
    workspace,
    sessionKey,
    submissionId: "directory-output",
    driver: "codex",
    message: "return a site",
    acceptedAt,
  });
  const outputDirectory = path.join(state.paths(workspace).outbox, `${state.sessionHash(sessionKey)}_site`);
  await fs.mkdir(outputDirectory);
  await fs.writeFile(path.join(outputDirectory, "index.html"), "<h1>site</h1>");
  const finished = await state.finishTurn({
    workspace,
    sessionKey,
    driver: "codex",
    progress: {},
    submission: {
      submissionId: "directory-output",
      message: "return a site",
      inputs: [],
      outputBaseline: started.outputBaseline,
      status: "completed",
      reply: "done",
      acceptedAt,
      completedAt: "2026-08-02T13:46:00.000Z",
    },
  });
  assert.deepEqual(finished.outputs, []);
  assert.match(finished.outputError, /output is not a direct regular file/);
});

test("workspace history repairs a crash-truncated final JSONL record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-workspace-jsonl-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = new WorkspaceState({ config: {} });
  await state.ensure(workspace);
  const sessionKey = "main";
  const historyPath = state.historyPath(workspace, sessionKey);
  const prior = {
    version: 1,
    kind: "turn",
    submissionId: "prior",
    inboundAt: "2026-08-02T10:00:00.000Z",
    completedAt: "2026-08-02T10:01:00.000Z",
  };
  await fs.writeFile(historyPath, `${JSON.stringify(prior)}\n{\"partial\"`, "utf8");
  const acceptedAt = "2026-08-02T14:00:00.000Z";
  const started = await state.startTurn({
    workspace,
    sessionKey,
    submissionId: "after-crash",
    driver: "claude",
    message: "continue",
    acceptedAt,
  });
  await state.finishTurn({
    workspace,
    sessionKey,
    driver: "claude",
    progress: {},
    submission: {
      submissionId: "after-crash",
      message: "continue",
      inputs: [],
      outputBaseline: started.outputBaseline,
      status: "completed",
      reply: "continued",
      acceptedAt,
      completedAt: "2026-08-02T14:01:00.000Z",
    },
  });
  const history = (await fs.readFile(historyPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(history.map((record) => record.submissionId), ["prior", "after-crash"]);
});

test("48 active-hour retention keeps whole newest work clusters", () => {
  const turn = (id, startHour, endHour) => ({
    submissionId: id,
    inboundAt: new Date(Date.UTC(2026, 0, 1, startHour)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 0, 1, endHour)).toISOString(),
  });
  const turns = [
    turn("old", 0, 10),
    turn("middle", 16, 40),
    turn("new", 46, 70),
  ];
  assert.deepEqual(selectRecentTurns(turns).map((item) => item.submissionId), ["middle", "new"]);
  assert.ok(summarizeProgress({ reasoning: ["x".repeat(1000)] }).length <= 500);
  assert.match(summarizeProgress({ lastAssistantMessage: "Checking files now." }), /Checking files now/);
  assert.match(summarizeProgress({
    reasoning: ["Reading the config."],
    toolUses: [{ tool: "Read", success: true }],
    lastError: "boom",
  }), /^Working\.\nReading the config\.\nRecent tools: Read \(ok\)\nError: boom$/);
});

test("Codex JSON tool arguments receive key-based secret redaction", () => {
  const normalized = normalizeProgress({
    toolUses: [{
      tool: "exec",
      arguments: JSON.stringify({
        api_key: "ordinary-unstructured-value",
        password: "hunter2hunter2",
        nested: { authorization: "opaque-credential", safe: "visible" },
      }),
      success: true,
    }],
  });
  assert.deepEqual(normalized.tools[0].arguments, {
    api_key: "[redacted]",
    password: "[redacted]",
    nested: { authorization: "[redacted]", safe: "visible" },
  });
  assert.doesNotMatch(JSON.stringify(normalized), /ordinary-unstructured-value|hunter2hunter2|opaque-credential/);
});
