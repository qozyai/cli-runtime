"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { request } = require("./client");
const { readJson, sleep, writeAtomic } = require("./util");
const { mimeTypeFor, safeFilename } = require("./workspace-state");

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
    const sent = [];
    for (const part of chunks(text)) {
      sent.push(await this.api("sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id || undefined,
        text: part || " ",
        disable_web_page_preview: true,
      }));
    }
    return sent;
  }

  async sendStatus(message, text = "Working.") {
    return this.api("sendMessage", {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id || undefined,
      text,
      disable_web_page_preview: true,
    });
  }

  async editStatus(message, messageId, text) {
    if (!messageId) return null;
    return this.api("editMessageText", {
      chat_id: message.chat.id,
      message_id: messageId,
      text: String(text || "Working.").slice(0, 4000),
      disable_web_page_preview: true,
    }).catch(() => null);
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

  async waitSubmission(message, submissionId, statusMessageId = null) {
    let lastTypingAt = 0;
    let lastEditAt = Date.now();
    let lastSummary = "Working.";
    while (true) {
      if (Date.now() - lastTypingAt >= 4000) {
        await this.typing(message);
        lastTypingAt = Date.now();
      }
      const result = await this.runtime("GET", `/v1/submissions/${encodeURIComponent(submissionId)}`);
      const status = result.submission.status;
      if (["completed", "failed", "interrupted"].includes(status)) {
        const finalStatus = status === "completed" ? "Completed." : status === "interrupted" ? "Interrupted." : "Stopped with an error.";
        await this.editStatus(message, statusMessageId, finalStatus);
        return result.submission;
      }
      const summary = String(result.submission.progress?.summary || "Working.").trim();
      if (summary && summary !== lastSummary
        && Date.now() - lastEditAt >= (this.config.telegram.statusEditIntervalMs || 30_000)) {
        await this.editStatus(message, statusMessageId, summary);
        lastSummary = summary;
        lastEditAt = Date.now();
      }
      await sleep(500);
    }
  }

  telegramFile(message) {
    if (message.document) {
      return {
        fileId: message.document.file_id,
        name: message.document.file_name || `document-${message.message_id}`,
        mimeType: message.document.mime_type,
        size: message.document.file_size,
      };
    }
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = message.photo.at(-1);
      return { fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", size: photo.file_size };
    }
    for (const kind of ["audio", "voice", "video", "animation"]) {
      const media = message[kind];
      if (!media) continue;
      const extension = kind === "voice" ? ".ogg" : "";
      return {
        fileId: media.file_id,
        name: media.file_name || `${kind}-${message.message_id}${extension}`,
        mimeType: media.mime_type,
        size: media.file_size,
      };
    }
    return null;
  }

  async downloadInputs(message) {
    const file = this.telegramFile(message);
    if (!file) return [];
    const maxFileBytes = this.config.telegram.maxFileBytes || 20 * 1024 * 1024;
    if (Number(file.size) > maxFileBytes) {
      throw new Error(`Telegram file exceeds ${maxFileBytes} bytes`);
    }
    const remote = await this.api("getFile", { file_id: file.fileId });
    const response = await this.fetch(`https://api.telegram.org/file/bot${this.config.telegram.token}/${remote.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxFileBytes) {
      throw new Error(`Telegram file exceeds ${maxFileBytes} bytes`);
    }
    const dir = path.join(this.config.stateDir, "telegram-inputs");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = safeFilename(file.name, `input-${message.message_id}`);
    const sourcePath = path.join(dir, `${message.chat.id}-${message.message_id}-${name}`);
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    return [{
      sourcePath,
      name,
      mimeType: file.mimeType || mimeTypeFor(name),
      temporary: true,
    }];
  }

  async sendFile(message, output) {
    const bytes = await fs.readFile(output.archivePath || output.path);
    const form = new FormData();
    form.append("chat_id", String(message.chat.id));
    if (message.message_thread_id) form.append("message_thread_id", String(message.message_thread_id));
    form.append("document", new Blob([bytes], { type: output.mimeType || mimeTypeFor(output.originalName) }), output.originalName);
    const response = await this.fetch(`https://api.telegram.org/bot${this.config.telegram.token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || "Telegram sendDocument failed");
    return result.result;
  }

  async handle(message) {
    const text = String(message.text || message.caption || "").trim();
    const attached = this.telegramFile(message);
    if (!text && !attached) return;
    const routeKey = this.routeKey(message);
    const route = this.routes[routeKey] || { driver: this.config.telegram.defaultDriver };
    const command = text ? text.match(/^\/([a-z]+)(?:@\S+)?(?:\s+(.+))?$/i) : null;

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
    const inputs = await this.downloadInputs(message);
    let accepted;
    try {
      accepted = await this.runtime(
        "POST",
        `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}/submissions`,
        {
          message: text,
          inputs: inputs.map(({ temporary, ...input }) => input),
          idempotencyKey: `telegram:${message.chat.id}:${message.message_id}`,
        },
      );
    } finally {
      await Promise.all(inputs.filter((input) => input.temporary).map((input) => fs.rm(input.sourcePath, { force: true })));
    }
    await this.typing(message);
    const statusMessage = await this.sendStatus(message);
    const completed = await this.waitSubmission(message, accepted.submission.submissionId, statusMessage?.message_id);
    if (completed.status !== "completed") {
      const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}`);
      if (current.session.status === "auth_required") {
        await this.send(message, await this.authMessage(route.driver, true));
        return;
      }
    }
    await this.send(message, completed.status === "completed" ? completed.reply : `(model error: ${completed.error})`);
    const pendingOutputs = completed.status === "completed"
      ? (completed.outputs || []).filter((output) => output.deliveryStatus === "pending")
      : [];
    if (pendingOutputs.length > 0) {
      for (const output of pendingOutputs) await this.sendFile(message, output);
      await this.runtime("POST", `/v1/submissions/${encodeURIComponent(completed.submissionId)}/outputs/ack`, {});
    }
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
          if (!message || (!message.text && !message.caption && !this.telegramFile(message))) continue;
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
