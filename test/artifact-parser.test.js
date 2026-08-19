"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createArtifactParser, replayArtifact } = require("../src/artifact-parser");
const { watchArtifacts } = require("../src/artifacts");

function claudeUser(marker) {
  return { type: "user", sessionId: "claude-session", message: { content: marker } };
}

function claudeAssistant(text, stopReason = "end_turn", extra = {}) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: stopReason },
    ...extra,
  };
}

test("Claude parser replays normal and API-error terminal records", () => {
  const marker = "<marker-normal/>";
  const normal = replayArtifact({
    driver: "claude",
    marker,
    entries: [claudeUser(marker), claudeAssistant("all good")],
  });
  assert.equal(normal.terminal, true);
  assert.equal(normal.ok, true);
  assert.equal(normal.reply, "all good");

  const errorMarker = "<marker-error/>";
  const apiError = replayArtifact({
    driver: "claude",
    marker: errorMarker,
    entries: [
      claudeUser(errorMarker),
      claudeAssistant("529 Overloaded", "stop_sequence", { isApiErrorMessage: true, apiErrorStatus: "529" }),
    ],
  });
  assert.equal(apiError.terminal, true);
  assert.equal(apiError.ok, false);
  assert.match(apiError.error, /529/);

  const limitMarker = "<marker-limit/>";
  const tokenLimit = replayArtifact({
    driver: "claude",
    marker: limitMarker,
    entries: [claudeUser(limitMarker), claudeAssistant("partial", "max_tokens")],
  });
  assert.equal(tokenLimit.terminal, true);
  assert.equal(tokenLimit.ok, false);
  assert.match(tokenLimit.error, /token limit/);
});

test("Codex parser uses exact command exit wrappers", () => {
  const marker = "<marker-codex/>";
  const parser = createArtifactParser({ driver: "codex", marker });
  parser.feed({ type: "event_msg", payload: { type: "user_message", message: marker } });
  parser.feed({ type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec", arguments: "false" } });
  parser.feed({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "one", output: "Process exited with code 2\nstderr" },
  });
  parser.feed({ type: "response_item", payload: { type: "function_call", call_id: "two", name: "exec", arguments: "true" } });
  const progress = parser.feed({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "two", output: "Documentation mentions exit code 1, but the command succeeded." },
  });
  assert.equal(progress.toolUses[0].success, false);
  assert.match(progress.toolUses[0].error, /exited with code 2/);
  assert.equal(progress.toolUses[1].success, true);
  assert.deepEqual(progress.toolCounts, { successful: 1, failed: 1 });
  assert.equal(progress.toolUses[1].detail, "true");
  parser.feed({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "two", output: "duplicate result" },
  });
  assert.deepEqual(parser.state.toolCounts, { successful: 1, failed: 1 });
});

test("Codex parser reads structured exit codes from code-mode output blocks", () => {
  const marker = "<marker-codex-structured/>";
  const parser = createArtifactParser({ driver: "codex", marker });
  parser.feed({ type: "event_msg", payload: { type: "user_message", message: marker } });
  parser.feed({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "structured-failure",
      name: "exec",
      input: 'const r = await tools.exec_command({"cmd":"sh -c \'exit 7\'","workdir":"/tmp"});',
    },
  });
  const progress = parser.feed({
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "structured-failure",
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
        { type: "input_text", text: '{"output":"","exit_code":7}' },
      ],
    },
  });
  assert.deepEqual(progress.toolCounts, { successful: 0, failed: 1 });
  assert.equal(progress.toolUses[0].success, false);
  assert.equal(progress.toolUses[0].detail, "sh -c 'exit 7'");
  assert.match(progress.toolUses[0].error, /exit_code/);
});

test("Claude parser retains descriptions, one safe detail source, and cumulative outcomes", () => {
  const marker = "<marker-claude-tools/>";
  const parser = createArtifactParser({ driver: "claude", marker });
  parser.feed(claudeUser(marker));
  parser.feed({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "bash-one",
        name: "Bash",
        input: { command: "npm test", description: "Run the complete test suite" },
      }],
      stop_reason: "tool_use",
    },
  });
  parser.feed({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-one", content: "", is_error: false }] },
  });
  parser.feed({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "read-two", name: "Read", input: { file_path: "/tmp/report.md" } }],
      stop_reason: "tool_use",
    },
  });
  const progress = parser.feed({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "read-two", content: "permission denied", is_error: true }] },
  });
  assert.deepEqual(progress.toolCounts, { successful: 1, failed: 1 });
  assert.equal(progress.toolUses[0].detail, "Run the complete test suite");
  assert.equal(progress.toolUses[1].detail, "/tmp/report.md");
  assert.equal(progress.toolUses[1].success, false);
});

test("artifact watcher preserves UTF-8 split across poll reads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-artifact-utf8-"));
  const artifact = path.join(root, "session.jsonl");
  const marker = "<marker-utf8/>";
  await fs.writeFile(artifact, `${JSON.stringify(claudeUser(marker))}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const watching = watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 3000,
    pollMs: 5,
  });
  const terminalLine = Buffer.from(`${JSON.stringify(claudeAssistant("Deployment finished ✅ all green"))}\n`);
  const emoji = Buffer.from("✅");
  const emojiAt = terminalLine.indexOf(emoji);
  assert.ok(emojiAt > 0);
  await fs.appendFile(artifact, terminalLine.subarray(0, emojiAt + 1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.appendFile(artifact, terminalLine.subarray(emojiAt + 1));
  const result = await watching;
  assert.equal(result.reply, "Deployment finished ✅ all green");
  assert.doesNotMatch(result.reply, /�/);
});

test("artifact watcher reads capped increments without skipping the submission marker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-artifact-chunks-"));
  const artifact = path.join(root, "session.jsonl");
  const marker = "<marker-chunks/>";
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(artifact, [
    JSON.stringify(claudeUser(marker)),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x".repeat(500) }], stop_reason: "tool_use" } }),
    JSON.stringify(claudeAssistant("chunked completion")),
    "",
  ].join("\n"));

  const result = await watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 3000,
    pollMs: 5,
    maxIncrementBytes: 64,
  });
  assert.equal(result.terminal, true);
  assert.equal(result.reply, "chunked completion");
});

test("artifact watcher observes aborts while reading a large increment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-artifact-abort-"));
  const artifact = path.join(root, "session.jsonl");
  const marker = "<marker-abort/>";
  const controller = new AbortController();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(artifact, `${JSON.stringify(claudeUser(marker))}\n${"x".repeat(2 * 1024 * 1024)}`);
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => watchArtifacts({
    driver: "claude",
    rootDir: root,
    baseline: new Map(),
    marker,
    timeoutMs: 5000,
    pollMs: 5,
    maxIncrementBytes: 64,
    signal: controller.signal,
  }), /submission interrupted/);
  assert.ok(Date.now() - startedAt < 1000);
});

test("sanitized vendor artifact fixtures replay deterministically", async () => {
  const root = path.join(__dirname, "..", "fixtures", "artifacts");
  const readFixture = async (name) => (await fs.readFile(path.join(root, name), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const claude = replayArtifact({
    driver: "claude",
    marker: '<cli-runtime-submission id="fixture-claude"/>',
    entries: await readFixture("claude-api-error.jsonl"),
  });
  assert.equal(claude.terminal, true);
  assert.equal(claude.ok, false);
  assert.match(claude.error, /temporarily overloaded/);
  const codex = replayArtifact({
    driver: "codex",
    marker: '<cli-runtime-submission id="fixture-codex"/>',
    entries: await readFixture("codex-tool-results.jsonl"),
  });
  assert.equal(codex.ok, true);
  assert.equal(codex.toolUses[0].success, false);
  assert.match(codex.toolUses[0].error, /code 2/);

  const cases = [
    ["claude", "claude-normal.jsonl", '<cli-runtime-submission id="fixture-claude-normal"/>', true, /Normal completion/],
    ["claude", "claude-token-limit.jsonl", '<cli-runtime-submission id="fixture-claude-limit"/>', false, /token limit/],
    ["codex", "codex-completion.jsonl", '<cli-runtime-submission id="fixture-codex-complete"/>', true, /Codex completion/],
    ["codex", "codex-abort.jsonl", '<cli-runtime-submission id="fixture-codex-abort"/>', false, /aborted/],
    ["codex", "codex-error.jsonl", '<cli-runtime-submission id="fixture-codex-error"/>', false, /temporarily unavailable/],
    ["codex", "codex-tool-result-json.jsonl", '<cli-runtime-submission id="fixture-codex-json"/>', true, /Handled JSON-wrapped failure/],
  ];
  for (const [driver, fileName, fixtureMarker, expectedOk, expectedText] of cases) {
    const replayed = replayArtifact({ driver, marker: fixtureMarker, entries: await readFixture(fileName) });
    assert.equal(replayed.terminal, true, fileName);
    assert.equal(replayed.ok, expectedOk, fileName);
    assert.match(`${replayed.reply || ""}\n${replayed.error || ""}`, expectedText, fileName);
    if (fileName === "codex-tool-result-json.jsonl") assert.equal(replayed.toolUses[0].success, false);
  }
});

test("Claude parser recognizes real auth failures and rejects synthetic success endings", () => {
  const authMarker = "<marker-auth/>";
  const auth = replayArtifact({
    driver: "claude",
    marker: authMarker,
    entries: [
      claudeUser(authMarker),
      claudeAssistant("Login expired · Please run /login", "stop_sequence", {
        isApiErrorMessage: true,
        error: "authentication_failed",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Login expired · Please run /login" }],
          stop_reason: "stop_sequence",
        },
      }),
    ],
  });
  assert.equal(auth.terminal, true);
  assert.equal(auth.kind, "auth_required");
  assert.match(auth.error, /Login expired/);

  const syntheticMarker = "<marker-synthetic/>";
  const synthetic = replayArtifact({
    driver: "claude",
    marker: syntheticMarker,
    entries: [
      claudeUser(syntheticMarker),
      claudeAssistant("Control record", "stop_sequence", {
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Control record" }],
          stop_reason: "stop_sequence",
        },
      }),
    ],
  });
  assert.equal(synthetic.terminal, false);
});

test("the parser keeps the whole tool sequence, not a tail of twenty", () => {
  const marker = "<marker-sequence/>";
  const parser = createArtifactParser({ driver: "codex", marker });
  parser.feed({ type: "event_msg", payload: { type: "user_message", message: marker } });
  let progress = null;
  for (let index = 0; index < 30; index += 1) {
    parser.feed({
      type: "response_item",
      payload: { type: "function_call", call_id: `call-${index}`, name: "exec", arguments: `step ${index}` },
    });
    progress = parser.feed({
      type: "response_item",
      payload: { type: "function_call_output", call_id: `call-${index}`, output: "ok" },
    });
  }
  // The first call has to survive: truncating to the newest 20 is what made the
  // history record a progress snapshot rather than a record.
  assert.equal(progress.toolUses.length, 30);
  assert.equal(progress.toolUses[0].id, "call-0");
  assert.equal(progress.toolUses.at(-1).id, "call-29");
  assert.deepEqual(progress.toolCounts, { successful: 30, failed: 0 });
});

test("the Claude parser also keeps the whole tool sequence", () => {
  const marker = "<marker-claude-sequence/>";
  const parser = createArtifactParser({ driver: "claude", marker });
  parser.feed(claudeUser(marker));
  let progress = null;
  for (let index = 0; index < 30; index += 1) {
    progress = parser.feed({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: `toolu_${index}`,
          name: index === 3 ? "Edit" : "Bash",
          input: { description: `step ${index}` },
        }],
        stop_reason: "tool_use",
      },
    });
    parser.feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_${index}`, content: "ok" }] },
    });
  }
  // Both drivers push into the same accumulator, so the fix has to hold for both.
  assert.equal(progress.toolUses.length, 30);
  assert.equal(progress.toolUses[0].id, "toolu_0");
  assert.equal(progress.toolUses[3].tool, "Edit");
  assert.equal(progress.toolUses.at(-1).id, "toolu_29");
});

test("the retained tool sequence is bounded, and the counts stay exact past the bound", () => {
  const marker = "<marker-bound/>";
  const parser = createArtifactParser({ driver: "codex", marker });
  parser.feed({ type: "event_msg", payload: { type: "user_message", message: marker } });
  let progress = null;
  for (let index = 0; index < 520; index += 1) {
    parser.feed({
      type: "response_item",
      payload: { type: "function_call", call_id: `call-${index}`, name: "exec", arguments: `step ${index}` },
    });
    progress = parser.feed({
      type: "response_item",
      payload: { type: "function_call_output", call_id: `call-${index}`, output: "ok" },
    });
  }
  // Unbounded accumulation would let a looping provider grow this array — and the
  // per-tick copy and serialization with it — inside the process that also serves
  // Telegram. The ceiling is far above the busiest turn ever measured.
  assert.equal(progress.toolUses.length, 500);
  assert.equal(progress.toolUses.at(-1).id, "call-519");
  // Counts are never trimmed, so a truncated sequence still reports its true size.
  assert.deepEqual(progress.toolCounts, { successful: 520, failed: 0 });
});

// A turn that the driver ran perfectly was reported to the user as a bind timeout,
// because Codex had renamed the one event the bind check read. Every shape Codex has
// used for the prompt is accepted, so the same rename cannot strand a turn again.
test("Codex binds on every rollout shape that carries the prompt", () => {
  const marker = '<cli-runtime-submission id="fixture-codex-shapes"/>';
  const shapes = [
    ["legacy user_message event", {
      type: "event_msg",
      payload: { type: "user_message", message: `fixture ${marker}` },
    }],
    ["item_completed UserMessage envelope", {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: `fixture ${marker}`, text_elements: [] }] },
      },
    }],
    ["response_item message with role user", {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `fixture ${marker}` }] },
    }],
  ];

  for (const [label, entry] of shapes) {
    const parser = createArtifactParser({ driver: "codex", marker });
    parser.feed(entry);
    assert.equal(parser.state.bound, true, `did not bind on ${label}`);
    const result = parser.feed({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Bound and finished." },
    });
    assert.equal(result.terminal, true, `did not complete after ${label}`);
    assert.equal(result.ok, true);
    assert.equal(result.reply, "Bound and finished.");
  }
});

// A prompt echoed back inside an unrelated turn must not bind this one.
test("Codex ignores prompt-shaped entries that lack this turn's marker", () => {
  const parser = createArtifactParser({ driver: "codex", marker: "<marker-mine/>" });
  parser.feed({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "text", text: "replayed <marker-theirs/>" }] },
    },
  });
  parser.feed({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "leaked reply" }] },
  });
  assert.equal(parser.state.bound, false);
  assert.equal(parser.state.lastAssistantMessage, "");
});
