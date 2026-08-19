#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { loadConfig } = require("./config");
const { EventStore } = require("./event-store");
const { Tmux } = require("./tmux");
const { SessionManager } = require("./session-manager");
const { AuthManager } = require("./auth-manager");
const { createServer } = require("./server");
const { request } = require("./client");
const { TelegramAdapter } = require("./telegram");
const { Navigator } = require("./navigator");
const { OpenAIHelper } = require("./openai-helper");
const { acquireRuntimeLock } = require("./runtime-lock");
const { sleep } = require("./util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { replayArtifact } = require("./artifacts");
const { blockingVersionFailures, describeVersionCheck, verifyDriverVersions } = require("./driver-version");

async function createRuntime(config = loadConfig()) {
  const ownershipLock = await acquireRuntimeLock(config.stateDir);
  try {
    const eventStore = new EventStore(config.stateDir);
    await eventStore.init();
    const tmux = new Tmux(config.tmuxSocketName);
    const openaiHelper = new OpenAIHelper({ config });
    const navigator = new Navigator({ config, eventStore, openaiHelper });
    const sessions = new SessionManager({ config, tmux, eventStore, navigator });
    await sessions.init();
    const auth = new AuthManager({ config, tmux, eventStore, navigator });
    const server = createServer({ config, sessions, auth, eventStore, ownershipLock });
    return { config, eventStore, tmux, openaiHelper, navigator, sessions, auth, server };
  } catch (err) {
    await ownershipLock.release();
    throw err;
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function parseSendArguments(rest) {
  const sessionKey = rest[0];
  const separator = rest.indexOf("--", 1);
  const optionArgs = separator >= 0 ? rest.slice(1, separator) : rest.slice(1);
  const messageParts = separator >= 0 ? rest.slice(separator + 1) : [];
  if (separator < 0) {
    for (let index = 0; index < optionArgs.length; index += 1) {
      if (optionArgs[index] === "--wait") continue;
      if (optionArgs[index] === "--idempotency") {
        index += 1;
        continue;
      }
      messageParts.push(optionArgs[index]);
    }
  }
  return {
    sessionKey,
    wait: optionArgs.includes("--wait"),
    idempotencyKey: option(optionArgs, "--idempotency"),
    message: messageParts.join(" ").trim(),
  };
}

async function waitForSubmission(config, submissionId) {
  while (true) {
    const result = await request(config.socketPath, "GET", `/v1/submissions/${encodeURIComponent(submissionId)}`);
    if (["completed", "failed", "interrupted"].includes(result.submission.status)) return result.submission;
    await sleep(250);
  }
}

async function runClient(config, args) {
  const [area, action, ...rest] = args;
  if (area === "session" && action === "list") {
    print(await request(config.socketPath, "GET", "/v1/sessions"));
    return;
  }
  if (area === "session" && action === "create") {
    const [sessionKey, driver, workspace] = rest;
    print(await request(config.socketPath, "POST", "/v1/sessions", {
      sessionKey,
      driver,
      workspace,
      forkFromSessionKey: option(rest, "--fork-from"),
    }));
    return;
  }
  if (area === "session" && action === "send") {
    const parsed = parseSendArguments(rest);
    const accepted = await request(config.socketPath, "POST", `/v1/sessions/${encodeURIComponent(parsed.sessionKey)}/submissions`, {
      message: parsed.message,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (!parsed.wait) print(accepted);
    else print(await waitForSubmission(config, accepted.submission.submissionId));
    return;
  }
  if (area === "session" && ["status", "output", "interrupt", "restart", "release", "close", "attach"].includes(action)) {
    const sessionKey = rest[0];
    const encoded = encodeURIComponent(sessionKey);
    if (action === "status") print(await request(config.socketPath, "GET", `/v1/sessions/${encoded}`));
    if (action === "output") print(await request(config.socketPath, "GET", `/v1/sessions/${encoded}/output`));
    if (action === "interrupt") print(await request(config.socketPath, "POST", `/v1/sessions/${encoded}/interrupt`, {}));
    if (action === "restart") print(await request(config.socketPath, "POST", `/v1/sessions/${encoded}/restart`, {}));
    if (action === "release") print(await request(config.socketPath, "POST", `/v1/sessions/${encoded}/release`, {}));
    if (action === "close") print(await request(config.socketPath, "DELETE", `/v1/sessions/${encoded}`));
    if (action === "attach") {
      const info = await request(config.socketPath, "GET", `/v1/sessions/${encoded}/attach`);
      const result = spawnSync("sh", ["-lc", info.command], { stdio: "inherit" });
      process.exitCode = result.status || 0;
    }
    return;
  }
  if (area === "auth" && ["status", "start", "submit"].includes(action)) {
    const driver = rest[0];
    if (action === "status") print(await request(config.socketPath, "GET", `/v1/auth/${driver}/status`));
    if (action === "start") print(await request(config.socketPath, "POST", `/v1/auth/${driver}/start`, { force: rest.includes("--force") }));
    if (action === "submit") print(await request(config.socketPath, "POST", `/v1/auth/${driver}/submit`, { code: rest[1] }));
    return;
  }
  if (area === "events") {
    const after = option(rest, "--after") || 0;
    const sessionKey = option(rest, "--session");
    const query = new URLSearchParams({ after: String(after), waitMs: "30000" });
    if (sessionKey) query.set("sessionKey", sessionKey);
    print(await request(config.socketPath, "GET", `/v1/events?${query}`));
    return;
  }
  if (area === "artifact" && action === "replay") {
    const [driver, marker, filePath] = rest;
    const entries = (await fs.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    print(replayArtifact({ driver, marker, entries }));
    return;
  }
  throw new Error("unknown command; use session, auth, events, daemon, or telegram");
}

// Node makes an unhandled rejection fatal by default. A long-lived service must not
// lose every live session to one stray promise in a peripheral path; the process
// keeps running and the rejection is reported. Uncaught exceptions keep the default
// behavior, because those unwind a stack we no longer know the state of.
function installRejectionBackstop(mode) {
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? `${reason.message}\n${reason.stack || ""}` : String(reason);
    process.stderr.write(`[cli-runtime] unhandled rejection in ${mode}: ${detail}\n`);
  });
}

// Reported at start, where an operator reads it, rather than per turn, and before the
// session manager runs: a pin that stops the daemon must stop it before init finalizes
// interrupted turns and reconciles panes.
//
// Scope is narrower than the wording suggests unless it is said out loud. This probes
// the configured command, which decides what a *newly launched* pane will run. Panes
// already resident keep the binary they started with — reconcileRuntimePanes only kills
// panes no live session claims — so a restart can report a pin that turns do not use.
async function reportDriverVersions(config) {
  const results = await verifyDriverVersions(config);
  for (const result of results) process.stderr.write(`${describeVersionCheck(result)}\n`);
  if (results.some((result) => result.expected)) {
    process.stderr.write("[cli-runtime] version checks cover newly launched sessions;"
      + " resident panes keep the binary they started with\n");
  }
  const blocking = blockingVersionFailures(config, results);
  if (blocking.length > 0) {
    const detail = blocking
      .map((r) => `${r.driver} pinned ${r.expected}, found ${r.actual || "unreadable"}`)
      .join("; ");
    throw new Error(`driver version pin unsatisfied: ${detail}`);
  }
  return results;
}

async function runService(mode) {
  installRejectionBackstop(mode);
  if (mode === "telegram") {
    const config = loadConfig(process.env, { requireTelegramProjectsRoot: true });
    const adapterLock = await acquireRuntimeLock(path.join(config.stateDir, "telegram"));
    const openaiHelper = new OpenAIHelper({ config });
    const telegram = new TelegramAdapter({ config, openaiHelper });
    const stop = async () => {
      telegram.stop();
      // Stamping the marker is what separates "stopped" from "died" at the next start.
      await telegram.markCleanStop();
      await adapterLock.release();
      process.exit();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await telegram.run();
    } finally {
      await adapterLock.release();
    }
    return;
  }
  const config = loadConfig();
  await reportDriverVersions(config);
  const runtime = await createRuntime(config);
  const started = await runtime.server.start();
  process.stderr.write(`[cli-runtime] listening on ${started.socketPath}\n`);
  const stop = async () => { await runtime.server.stop(); process.exit(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "daemon" || command === "telegram") {
    await runService(command);
    return;
  }
  await runClient(loadConfig(), argv);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`cli-runtime: ${err.message}\n`);
    process.exit(err.exitCode || (err.code === "EX_CONFIG" ? 78 : 1));
  });
}

module.exports = { createRuntime, installRejectionBackstop, main, parseSendArguments, reportDriverVersions, runClient, waitForSubmission };
