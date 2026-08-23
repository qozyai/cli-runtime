"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AuthManager, terminalUrls } = require("../src/drivers/auth-manager");

test("auth navigation recognizes wrapped current provider URLs", () => {
  const claude = [
    "Browser did not open. Use the url below:",
    "https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.co",
    "m%2Foauth%2Fcode%2Fcallback&state=xyz",
    "",
    "Paste code here >",
  ].join("\n");
  const codex = "Open https://auth.openai.com/codex/device and enter ABCD-EFGH";
  const manager = new AuthManager({ config: { stateDir: "/tmp" }, tmux: {}, eventStore: {} });

  assert.equal(terminalUrls(claude)[0], "https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz");
  assert.equal(manager.parseAuthPrompt("claude", claude).phase, "awaiting_code");
  assert.equal(manager.parseAuthPrompt("codex", codex).phase, "awaiting_browser");
  assert.equal(manager.parseAuthPrompt("codex", codex).code, "ABCD-EFGH");
});

test("auth start walks an unknown screen to the device code and learns it", async (t) => {
  const { Navigator } = require("../src/drivers/navigator");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-auth-walk-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const loggedIn = path.join(root, "codex");
  await fs.writeFile(loggedIn, "#!/bin/sh\necho 'Logged in using ChatGPT'\n", { mode: 0o700 });
  const frames = [
    "A brand new Codex welcome dialog nothing recognizes\nPress enter to continue",
    "Open https://auth.openai.com/codex/device and enter ABCD-EFGH",
  ];
  const makeTmux = () => {
    const state = { started: false, frame: 0, keys: [] };
    return {
      state,
      has: async () => state.started,
      kill: async () => {},
      createShell: async () => { state.started = true; },
      startCommand: async () => {},
      driverState: async () => ({ paneDead: false }),
      capture: async () => frames[state.frame],
      sendKey: async (_session, key) => { state.keys.push(key); state.frame = 1; },
      sendLiteral: async () => {},
      attachCommand: () => "tmux attach",
    };
  };
  const config = {
    stateDir: root,
    startupTimeoutMs: 8000,
    navigator: { url: "http://navigator.test/decide", apiKey: "", timeoutMs: 1000 },
    drivers: { codex: { command: loggedIn, homeDir: root, sandbox: "danger-full-access", approval: "never", extraArgs: [] } },
  };
  let modelCalls = 0;
  const fetchImpl = async () => {
    modelCalls += 1;
    return {
      ok: true,
      json: async () => ({
        reason: "a first-run welcome dialog is blocking the login flow",
        steps: ["acknowledge the dialog"],
        screen_regex: "brand new Codex welcome dialog",
        action: "press_key",
        key: "Enter",
        text: null,
      }),
    };
  };
  const events = { append: async () => {} };

  const tmuxA = makeTmux();
  const managerA = new AuthManager({
    config, tmux: tmuxA, eventStore: events,
    navigator: new Navigator({ config, eventStore: events, fetchImpl }),
  });
  const started = await managerA.start("codex");
  assert.equal(started.phase, "awaiting_browser");
  assert.equal(started.code, "ABCD-EFGH");
  assert.deepEqual(tmuxA.state.keys, ["Enter"]);
  assert.equal(modelCalls, 1);
  const probed = await managerA.status("codex");
  assert.equal(probed.authenticated, true, "the probe confirms and commits the lesson");

  // A fresh manager and navigator over the same state resolve the same
  // screen from the library: no further model call, same keystroke.
  const tmuxB = makeTmux();
  const managerB = new AuthManager({
    config, tmux: tmuxB, eventStore: events,
    navigator: new Navigator({ config, eventStore: events, fetchImpl }),
  });
  const repeat = await managerB.start("codex");
  assert.equal(repeat.phase, "awaiting_browser");
  assert.deepEqual(tmuxB.state.keys, ["Enter"]);
  assert.equal(modelCalls, 1, "the library answered the second attempt");
});

test("auth status distinguishes unknown command failure from unauthenticated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-auth-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const broken = path.join(root, "broken");
  const loggedOut = path.join(root, "logged-out");
  await fs.writeFile(broken, "#!/bin/sh\necho crashed >&2\nexit 2\n", { mode: 0o700 });
  await fs.writeFile(loggedOut, "#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n", { mode: 0o700 });
  const manager = new AuthManager({
    config: {
      stateDir: root,
      drivers: {
        claude: { command: broken, homeDir: root },
        codex: { command: loggedOut, homeDir: root },
      },
    },
    tmux: {},
    eventStore: {},
  });
  const claude = await manager.status("claude");
  const codex = await manager.status("codex");
  assert.equal(claude.state, "unknown");
  assert.equal(claude.authenticated, null);
  assert.match(claude.error, /crashed/);
  assert.equal(codex.state, "unauthenticated");
  assert.equal(codex.authenticated, false);
});

test("auth status subprocess receives only the execution environment allowlist", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-auth-env-"));
  const command = path.join(root, "status");
  const secretKeys = ["OPENAI_API_KEY", "GH_PAT", "DATABASE_URL", "STRIPE_SK"];
  const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
  for (const key of secretKeys) process.env[key] = "must-not-reach-auth";
  t.after(async () => {
    for (const key of secretKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(command, [
    "#!/bin/sh",
    "test -n \"$PATH\" || exit 3",
    `test \"$HOME\" = \"${root}\" || exit 4`,
    ...secretKeys.map((key) => `test -z \"$${key}\" || exit 5`),
    "printf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\"}'",
  ].join("\n"), { mode: 0o700 });
  const manager = new AuthManager({
    config: {
      stateDir: root,
      drivers: { claude: { command, homeDir: root } },
    },
    tmux: {},
    eventStore: {},
  });
  const status = await manager.status("claude");
  assert.equal(status.state, "unauthenticated");
  assert.equal(status.error, undefined);
});

test("auth start reuses an active login unless force is requested", async () => {
  let killed = 0;
  const manager = new AuthManager({
    config: {
      stateDir: "/tmp/unused-auth-state",
      startupTimeoutMs: 100,
      drivers: { claude: { command: "claude", homeDir: "/tmp" } },
    },
    tmux: {
      has: async () => true,
      driverState: async () => ({ paneDead: false, state: "running", exitCode: null }),
      capture: async () => "https://claude.ai/oauth/authorize?code=true",
      kill: async () => { killed += 1; },
      attachCommand: () => "attach",
    },
    eventStore: { append: async () => {} },
  });
  manager.status = async () => ({ driver: "claude", state: "unauthenticated", authenticated: false });
  const started = await manager.start("claude");
  assert.equal(started.phase, "awaiting_code");
  assert.equal(killed, 0);
});

test("auth start relaunches a dead login pane instead of reusing starting forever", async () => {
  let killed = 0;
  let started = 0;
  const manager = new AuthManager({
    config: {
      stateDir: "/tmp/unused-auth-dead-state",
      startupTimeoutMs: 100,
      drivers: { claude: { command: "claude", homeDir: "/tmp" } },
    },
    tmux: {
      has: async () => true,
      driverState: async () => ({ paneDead: true, state: "exited", exitCode: 1 }),
      capture: async () => "stale login screen",
      kill: async () => { killed += 1; },
      createShell: async () => {},
      startCommand: async () => { started += 1; },
      attachCommand: () => "attach",
    },
    eventStore: { append: async () => {} },
  });
  manager.status = async () => ({ driver: "claude", state: "unauthenticated", authenticated: false });
  const result = await manager.start("claude");
  assert.equal(result.phase, "failed");
  assert.equal(killed, 1);
  assert.equal(started, 1);
});
