"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");
const { buildPromptDelivery, MAX_INLINE_PROMPT_BYTES, SessionManager } = require("../src/session-manager");
const { isCollapsedPasteReceipt, isPastedPromptEditable } = require("../src/drivers");
const { Tmux } = require("../src/tmux");

async function waitFor(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("condition timed out");
}

async function setupRuntime(t, driver, suffix = "matrix", workspaceState = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cli runtime ${driver} ${suffix} `));
  const workspace = path.join(root, "workspace with spaces");
  const home = path.join(root, "driver home");
  const stateDir = path.join(root, "private state with spaces");
  await Promise.all([workspace, home].map((dir) => fs.mkdir(dir, { recursive: true })));
  const selected = driver === "claude"
    ? { command: path.join(__dirname, "..", "fixtures", "mock-driver.js"), homeDir: home, model: "", permissionMode: "bypassPermissions", extraArgs: [] }
    : { command: path.join(__dirname, "..", "fixtures", "mock-driver.js"), homeDir: home, model: "", sandbox: "danger-full-access", approval: "never", extraArgs: [] };
  const config = {
    stateDir,
    tmuxSocketName: `prompt-${driver}-${process.pid}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
    startupTimeoutMs: 5000,
    bindTimeoutMs: 6000,
    submissionTimeoutMs: 10_000,
    artifactPollMs: 25,
    drivers: { [driver]: selected },
  };
  const eventStore = new EventStore(stateDir);
  await eventStore.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const sessions = new SessionManager({ config, tmux, eventStore, workspaceState });
  await sessions.init();
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  await sessions.create({ sessionKey: `${driver}:main`, driver, workspace });
  return { config, eventStore, home, root, sessions, tmux, workspace };
}

test("prompt delivery keeps exact bytes and uses private files for unsafe terminal payloads", () => {
  const promptPath = "/private state/requests/prompt.txt";
  const marker = '<cli-runtime-submission id="sub_boundary"/>';
  const cases = [
    { name: "empty", prompt: "", mode: "inline" },
    { name: "option-like shell text", prompt: "--help `echo nope` $(touch nope) ; && <tag a='b'>&</tag>", mode: "inline" },
    { name: "unicode bytes", prompt: "Привет العربية 中文 e\u0301 👩🏽‍💻 🏳️‍🌈", mode: "inline" },
    { name: "exact threshold", prompt: "a".repeat(MAX_INLINE_PROMPT_BYTES), mode: "inline" },
    { name: "over threshold", prompt: "a".repeat(MAX_INLINE_PROMPT_BYTES + 1), mode: "file" },
    { name: "unicode over byte threshold", prompt: "🙂".repeat((MAX_INLINE_PROMPT_BYTES / 4) + 1), mode: "file" },
    { name: "LF markdown", prompt: "before\n```js\nconsole.log(`x`);\n```\nafter", mode: "file" },
    { name: "CRLF html", prompt: "<main>\r\n  <p>hello</p>\r\n</main>", mode: "file" },
    { name: "NUL", prompt: "before\0after", mode: "file" },
  ];
  for (const item of cases) {
    const delivery = buildPromptDelivery({ prompt: item.prompt, promptPath, marker });
    assert.equal(delivery.mode, item.mode, item.name);
    assert.equal(delivery.storedPrompt, item.prompt, `${item.name} changed stored bytes`);
    assert.match(delivery.terminalPrompt, /sub_boundary/, `${item.name} omitted marker`);
    if (item.mode === "file") {
      assert.match(delivery.terminalPrompt, /Read the complete UTF-8 user request/);
      assert.doesNotMatch(delivery.terminalPrompt, /console\.log|before\0after/);
    }
  }
});

test("collapsed paste receipts are validated using each driver's own format", () => {
  assert.equal(isCollapsedPasteReceipt("codex", "› [Pasted Content 17 chars]", 17), true);
  assert.equal(isCollapsedPasteReceipt("codex", "› [Pasted Content 18 chars]", 17), false);
  assert.equal(isCollapsedPasteReceipt("codex", "old › [Pasted Content 17 chars]", 17), false);
  assert.equal(isCollapsedPasteReceipt("claude", "❯\u00a0[Pasted text #12]", 999), true);
  assert.equal(isCollapsedPasteReceipt("claude", "❯ [Pasted text]", 999), false);
  assert.equal(isCollapsedPasteReceipt("claude", "old ❯ [Pasted text #12]", 999), false);
});

test("collapsed paste evidence must be new and on the active input line", () => {
  const evidence = {
    beforePasteCursorLine: "› ",
    expectedChars: 17,
    markerTail: "marker42",
  };
  assert.equal(isPastedPromptEditable(
    "codex",
    "old output [Pasted Content 17 chars]\n› ",
    "› ",
    evidence,
  ), false);
  assert.equal(isPastedPromptEditable(
    "codex",
    "› [Pasted Content 17 chars]",
    "› [Pasted Content 17 chars]",
    evidence,
  ), true);
  assert.equal(isPastedPromptEditable(
    "codex",
    "› [Pasted Content 18 chars]",
    "› [Pasted Content 18 chars]",
    evidence,
  ), false);
});

for (const driver of ["claude", "codex"]) {
  test(`${driver} preserves complex prompts through a real tmux session`, async (t) => {
    const { sessions, config, workspace } = await setupRuntime(t, driver);
    const cases = [
      { name: "shell", message: "--help `printf unsafe` $(touch /tmp/nope) ; && | <>& \\\\ \"quote\" 'apostrophe'", mode: "inline" },
      { name: "unicode", message: "Привет, мир · العربية · 中文 · e\u0301 · 👩🏽‍💻 · 🏳️‍🌈 · 🚀", mode: "inline" },
      { name: "html", message: "<main data-x=\"a&b\"><script>if (a < b) x = `ok`;</script><!-- comment --></main>", mode: "inline" },
      { name: "markdown", message: "Heading\n\n```js\nconst html = `<strong>hi</strong>`;\nconsole.log(html);\n```\n\nDone ✅", mode: "file" },
      { name: "crlf", message: "first\r\nsecond\r\nthird", mode: "file" },
      { name: "nul", message: "before\0after", mode: "file" },
      { name: "long", message: `START-${"ab🙂".repeat(64 * 1024)}-END`, mode: "file" },
    ];
    for (const item of cases) {
      const accepted = await sessions.submit(`${driver}:main`, { message: item.message });
      const done = await waitFor(async () => {
        const value = await sessions.getSubmission(accepted.submissionId);
        return value?.status === "completed" ? value : null;
      });
      assert.equal(done.promptMode, item.mode, item.name);
      const internal = JSON.parse(await fs.readFile(sessions.submissionPath(accepted.submissionId), "utf8"));
      assert.ok(internal.promptPath.startsWith(config.stateDir));
      assert.equal(internal.promptPath.startsWith(workspace), false);
      const stored = await fs.readFile(internal.promptPath, "utf8");
      assert.ok(stored.startsWith(item.message), `${item.name} prompt bytes changed`);
      assert.equal((await fs.stat(internal.promptPath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(internal.promptPath))).mode & 0o777, 0o700);
      await assert.rejects(() => fs.access(`${internal.promptPath}.submit`));
      if (item.mode === "file") {
        const digest = crypto.createHash("sha256").update(stored).digest("hex");
        assert.match(done.reply, new RegExp(`bytes=${Buffer.byteLength(stored, "utf8")} sha256=${digest}`));
      } else {
        assert.match(done.reply, new RegExp(item.name === "unicode" ? "Привет" : item.name === "html" ? "<main" : "--help"));
      }
      assert.doesNotMatch(done.reply, /cli-runtime-submission/);
    }
  });
}

for (const driver of ["claude", "codex"]) {
  test(`${driver} retries a collapsed pasted prompt only while it remains editable`, async (t) => {
    const workspaceState = {
      ensure: async () => {},
      startTurn: async () => ({ inputs: [], promptContext: "" }),
      updateTurn: async () => null,
      finishTurn: async () => ({ outputs: [], outputError: null }),
    };
    const { sessions, tmux, eventStore } = await setupRuntime(t, driver, "retry", workspaceState);
    const originalSendKey = tmux.sendKey.bind(tmux);
    const originalCapture = tmux.capture.bind(tmux);
    const originalCursorLine = tmux.cursorLine.bind(tmux);
    let enters = 0;
    let collapsed = false;
    let expectedChars = 0;
    const originalPasteFile = tmux.pasteFile.bind(tmux);
    tmux.pasteFile = async (...args) => {
      expectedChars = Array.from(await fs.readFile(args[1], "utf8")).length;
      await originalPasteFile(...args);
      collapsed = true;
    };
    const receipt = () => driver === "codex"
      ? `› [Pasted Content ${expectedChars} chars]`
      : "❯\u00a0[Pasted text #7]";
    tmux.capture = async (...args) => collapsed ? receipt() : originalCapture(...args);
    tmux.cursorLine = async (...args) => collapsed ? receipt() : originalCursorLine(...args);
    tmux.sendKey = async (sessionName, key) => {
      if (key === "Enter" && enters === 0) {
        enters += 1;
        return;
      }
      if (key === "Enter") {
        enters += 1;
        collapsed = false;
      }
      return originalSendKey(sessionName, key);
    };
    const accepted = await sessions.submit(`${driver}:main`, { message: "retry one ignored submit" });
    const done = await waitFor(async () => {
      const value = await sessions.getSubmission(accepted.submissionId);
      return value?.status === "completed" ? value : null;
    }, 9000);
    assert.match(done.reply, /retry one ignored submit/);
    assert.equal(enters, 2);
    const events = await eventStore.read({ after: 0, sessionKey: `${driver}:main` });
    assert.equal(events.filter((event) => event.type === "submission.submit_retry").length, 1);
  });
}

test("submission fails without pressing Enter when pasted content never appears", async (t) => {
  const { sessions, tmux, config } = await setupRuntime(t, "claude", "missing-echo");
  config.bindTimeoutMs = 1000;
  let enters = 0;
  const originalSendKey = tmux.sendKey.bind(tmux);
  tmux.sendKey = async (sessionName, key) => {
    if (key === "Enter") enters += 1;
    return originalSendKey(sessionName, key);
  };
  tmux.pasteFile = async () => {};
  const accepted = await sessions.submit("claude:main", { message: "must not submit blindly" });
  const failed = await waitFor(async () => {
    const value = await sessions.getSubmission(accepted.submissionId);
    return value?.status === "failed" ? value : null;
  }, 6000);
  assert.match(failed.error, /pasted prompt marker did not appear/);
  assert.equal(enters, 0);
});

test("submission preflight clears stale editable text before the real prompt", async (t) => {
  const { sessions, tmux } = await setupRuntime(t, "claude", "stale-input");
  const sessionName = sessions.rawSession("claude:main").tmuxSessionName;
  await tmux.sendLiteral(sessionName, "STALE_TEXT_MUST_NOT_SUBMIT");
  const accepted = await sessions.submit("claude:main", { message: "fresh prompt only" });
  const done = await waitFor(async () => {
    const value = await sessions.getSubmission(accepted.submissionId);
    return value?.status === "completed" ? value : null;
  });
  assert.match(done.reply, /fresh prompt only/);
  assert.doesNotMatch(done.reply, /STALE_TEXT_MUST_NOT_SUBMIT/);
});

test("visual echo accepts a wrapped marker when its unique ID remains intact", async () => {
  const manager = new SessionManager({
    config: { stateDir: path.join(os.tmpdir(), "unused-prompt-echo"), bindTimeoutMs: 500 },
    tmux: {
      capture: async () => '❯ request <cli-runtime-submission\n  id="sub_wrapped_123"/>',
      driverState: async () => ({ paneDead: false }),
    },
    eventStore: {},
    workspaceState: {},
  });
  const screen = await manager.waitForPromptEcho(
    { driver: "claude", tmuxSessionName: "wrapped" },
    {
      beforePasteCursorLine: "❯ ",
      expectedChars: 10,
      markerTail: "pped_123",
      markerToken: "sub_wrapped_123",
    },
    new AbortController().signal,
  );
  assert.match(screen, /sub_wrapped_123/);
});
