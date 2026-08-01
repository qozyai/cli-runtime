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
const { sleep } = require("./util");

async function createRuntime(config = loadConfig()) {
  const eventStore = new EventStore(config.stateDir);
  await eventStore.init();
  const tmux = new Tmux(config.tmuxSocketName);
  const navigator = new Navigator({ config, eventStore });
  const sessions = new SessionManager({ config, tmux, eventStore, navigator });
  await sessions.init();
  const auth = new AuthManager({ config, tmux, eventStore, navigator });
  const server = createServer({ config, sessions, auth, eventStore });
  return { config, eventStore, tmux, navigator, sessions, auth, server };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
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
    const sessionKey = rest[0];
    const wait = rest.includes("--wait");
    const messageParts = [];
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === "--wait") continue;
      if (rest[index] === "--idempotency") {
        index += 1;
        continue;
      }
      messageParts.push(rest[index]);
    }
    const message = messageParts.join(" ").trim();
    const accepted = await request(config.socketPath, "POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/submissions`, {
      message,
      idempotencyKey: option(rest, "--idempotency"),
    });
    if (!wait) print(accepted);
    else print(await waitForSubmission(config, accepted.submission.submissionId));
    return;
  }
  if (area === "session" && ["status", "output", "interrupt", "restart", "close", "attach"].includes(action)) {
    const sessionKey = rest[0];
    const encoded = encodeURIComponent(sessionKey);
    if (action === "status") print(await request(config.socketPath, "GET", `/v1/sessions/${encoded}`));
    if (action === "output") print(await request(config.socketPath, "GET", `/v1/sessions/${encoded}/output`));
    if (action === "interrupt") print(await request(config.socketPath, "POST", `/v1/sessions/${encoded}/interrupt`, {}));
    if (action === "restart") print(await request(config.socketPath, "POST", `/v1/sessions/${encoded}/restart`, {}));
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
  throw new Error("unknown command; use session, auth, events, daemon, or telegram");
}

async function runService(mode) {
  const runtime = await createRuntime();
  const started = await runtime.server.start();
  process.stderr.write(`[cli-runtime] listening on ${started.socketPath}\n`);
  let telegram = null;
  if (mode === "telegram") {
    telegram = new TelegramAdapter({ config: runtime.config });
    telegram.run().catch((err) => {
      process.stderr.write(`[telegram] fatal: ${err.message}\n`);
      process.exitCode = 1;
    });
  }
  const stop = async () => {
    telegram?.stop();
    await runtime.server.stop();
    process.exit();
  };
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
    process.exit(1);
  });
}

module.exports = { createRuntime, main, runClient, waitForSubmission };
