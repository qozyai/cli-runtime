"use strict";

const path = require("node:path");
const { request } = require("./client");
const { readJson, sleep, writeAtomic } = require("./util");

function chunks(text, max = 4000) {
  const value = String(text || "");
  if (!value) return [""];
  const result = [];
  for (let offset = 0; offset < value.length; offset += max) result.push(value.slice(offset, offset + max));
  return result;
}

class TelegramAdapter {
  constructor({ config, fetchImpl = fetch, log = console.error }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.log = log;
    this.offset = 0;
    this.stopped = false;
    this.routesPath = path.join(config.stateDir, "telegram-routes.json");
    this.routes = {};
    this.chains = new Map();
  }

  async init() {
    if (!this.config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN required");
    this.routes = await readJson(this.routesPath, {});
  }

  async api(method, body = {}) {
    const response = await this.fetch(`https://api.telegram.org/bot${this.config.telegram.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
    return result.result;
  }

  routeKey(message) {
    return `${message.chat.id}:${message.message_thread_id || "main"}`;
  }

  sessionKey(message) {
    return `telegram:${this.routeKey(message)}`;
  }

  async send(message, text) {
    for (const part of chunks(text)) {
      await this.api("sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id || undefined,
        text: part || " ",
        disable_web_page_preview: true,
      });
    }
  }

  async typing(message) {
    await this.api("sendChatAction", {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id || undefined,
      action: "typing",
    }).catch(() => {});
  }

  async runtime(method, apiPath, body = null) {
    return request(this.config.socketPath, method, apiPath, body);
  }

  async authMessage(driver, force = false) {
    const started = await this.runtime("POST", `/v1/auth/${driver}/start`, { force });
    const auth = started.auth;
    if (auth.phase === "completed") return `${driver === "claude" ? "Claude Code" : "Codex"} is authenticated.`;
    const lines = [`${driver === "claude" ? "Claude Code" : "Codex"} needs authentication.`];
    if (auth.url) lines.push("", auth.url);
    if (auth.code) lines.push("", `Code: ${auth.code}`);
    lines.push("", "Complete authentication, then send another message.");
    return lines.join("\n");
  }

  async ensureSession(message, driver) {
    const key = encodeURIComponent(this.sessionKey(message));
    try {
      const current = await this.runtime("GET", `/v1/sessions/${key}`);
      if (current.session.driver === driver && current.session.status !== "closed") return current.session;
      await this.runtime("DELETE", `/v1/sessions/${key}`);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    const created = await this.runtime("POST", "/v1/sessions", {
      sessionKey: this.sessionKey(message),
      driver,
      workspace: this.config.telegram.workspace,
    });
    return created.session;
  }

  async waitSubmission(message, submissionId) {
    let lastTypingAt = 0;
    while (true) {
      if (Date.now() - lastTypingAt >= 4000) {
        await this.typing(message);
        lastTypingAt = Date.now();
      }
      const result = await this.runtime("GET", `/v1/submissions/${encodeURIComponent(submissionId)}`);
      const status = result.submission.status;
      if (["completed", "failed", "interrupted"].includes(status)) return result.submission;
      await sleep(500);
    }
  }

  async handle(message) {
    const text = String(message.text || "").trim();
    if (!text) return;
    const routeKey = this.routeKey(message);
    const route = this.routes[routeKey] || { driver: this.config.telegram.defaultDriver };
    const command = text.match(/^\/([a-z]+)(?:@\S+)?(?:\s+(.+))?$/i);

    if (command?.[1].toLowerCase() === "driver") {
      const driver = String(command[2] || "").trim().toLowerCase();
      if (!["claude", "codex"].includes(driver)) {
        await this.send(message, "Choose /driver claude or /driver codex.");
        return;
      }
      route.driver = driver;
      this.routes[routeKey] = route;
      await writeAtomic(this.routesPath, this.routes);
      const key = encodeURIComponent(this.sessionKey(message));
      await this.runtime("DELETE", `/v1/sessions/${key}`).catch(() => {});
      await this.send(message, `${driver === "claude" ? "Claude Code" : "Codex"} selected.`);
      return;
    }

    if (command?.[1].toLowerCase() === "status") {
      const key = encodeURIComponent(this.sessionKey(message));
      try {
        const result = await this.runtime("GET", `/v1/sessions/${key}`);
        await this.send(message, `Status: ${result.session.status}`);
      } catch {
        await this.send(message, "No session has started yet.");
      }
      return;
    }

    if (command?.[1].toLowerCase() === "stop") {
      const key = encodeURIComponent(this.sessionKey(message));
      await this.runtime("POST", `/v1/sessions/${key}/interrupt`, {});
      await this.send(message, "Stop requested.");
      return;
    }

    if (command?.[1].toLowerCase() === "reset") {
      const key = encodeURIComponent(this.sessionKey(message));
      await this.runtime("DELETE", `/v1/sessions/${key}`).catch(() => {});
      await this.ensureSession(message, route.driver);
      await this.send(message, "New conversation started.");
      return;
    }

    if (command?.[1].toLowerCase() === "start") {
      const status = await this.runtime("GET", `/v1/auth/${route.driver}/status`);
      if (!status.auth.authenticated) {
        await this.send(message, await this.authMessage(route.driver));
        return;
      }
      await this.ensureSession(message, route.driver);
      await this.send(message, `${route.driver === "claude" ? "Claude Code" : "Codex"} is ready.`);
      return;
    }

    const auth = await this.runtime("GET", `/v1/auth/${route.driver}/status`);
    if (!auth.auth.authenticated) {
      await this.send(message, await this.authMessage(route.driver));
      return;
    }
    const session = await this.ensureSession(message, route.driver);
    if (session.status === "auth_required") {
      await this.send(message, await this.authMessage(route.driver, true));
      return;
    }
    const accepted = await this.runtime(
      "POST",
      `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}/submissions`,
      { message: text, idempotencyKey: `telegram:${message.chat.id}:${message.message_id}` },
    );
    await this.typing(message);
    const completed = await this.waitSubmission(message, accepted.submission.submissionId);
    if (completed.status !== "completed") {
      const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}`);
      if (current.session.status === "auth_required") {
        await this.send(message, await this.authMessage(route.driver, true));
        return;
      }
    }
    await this.send(message, completed.status === "completed" ? completed.reply : `(model error: ${completed.error})`);
  }

  enqueue(message) {
    const key = this.routeKey(message);
    const previous = this.chains.get(key) || Promise.resolve();
    const next = previous.then(() => this.handle(message)).catch((err) => this.send(message, `Runtime error: ${err.message}`).catch(() => {}));
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
  }

  async run() {
    await this.init();
    while (!this.stopped) {
      try {
        const updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, Number(update.update_id) + 1);
          const message = update.message;
          if (!message?.text) continue;
          if (this.config.telegram.allowedChatIds.size > 0 && !this.config.telegram.allowedChatIds.has(String(message.chat.id))) continue;
          this.enqueue(message);
        }
      } catch (err) {
        this.log(`[telegram] ${err.message}`);
        await sleep(2000);
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { TelegramAdapter, chunks };
