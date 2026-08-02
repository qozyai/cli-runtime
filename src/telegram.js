"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { request } = require("./client");
const { readJson, sleep, writeAtomic } = require("./util");
const { mimeTypeFor, safeFilename } = require("./progress");

const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;
const TERMINAL_SUBMISSION_STATES = new Set(["completed", "failed", "interrupted"]);
const CONTROL_COMMANDS = new Set(["status", "stop", "reset", "driver"]);
const IMMEDIATE_COMMANDS = new Set(["status", "stop"]);
const BARRIER_COMMANDS = new Set(["reset", "driver"]);
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

function chunks(text, max = 4000) {
  const characters = Array.from(String(text || ""));
  if (characters.length === 0) return [""];
  const result = [];
  for (let offset = 0; offset < characters.length; offset += max) result.push(characters.slice(offset, offset + max).join(""));
  return result;
}

function commandFor(message) {
  const text = String(message?.text || message?.caption || "").trim();
  const match = text.match(/^\/([a-z]+)(?:@\S+)?(?:\s+(.+))?$/i);
  return match ? { name: match[1].toLowerCase(), argument: String(match[2] || "").trim() } : null;
}

class TelegramAdapter {
  constructor({ config, openaiHelper = null, fetchImpl = fetch, log = console.error }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.openaiHelper = openaiHelper;
    this.log = log;
    this.offset = 0;
    this.stopped = false;
    this.telegramDir = path.join(config.stateDir, "telegram");
    this.queueDir = path.join(this.telegramDir, "queue");
    this.offsetPath = path.join(this.telegramDir, "offset.json");
    this.routesPath = path.join(this.telegramDir, "routes.json");
    this.legacyRoutesPath = path.join(config.stateDir, "telegram-routes.json");
    this.routes = {};
    this.chains = new Map();
    this.inflightUpdates = new Set();
    this.retryCounts = new Map();
  }

  async init() {
    if (!this.config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN required");
    await fs.mkdir(this.queueDir, { recursive: true, mode: 0o700 });
    this.routes = await readJson(this.routesPath, null) || await readJson(this.legacyRoutesPath, {});
    if (Object.keys(this.routes).length > 0 && !await readJson(this.routesPath, null)) {
      await writeAtomic(this.routesPath, this.routes);
    }
    this.offset = Number((await readJson(this.offsetPath, {})).offset || 0);
    const queued = (await fs.readdir(this.queueDir).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    for (const name of queued) {
      const filePath = path.join(this.queueDir, name);
      const update = await readJson(filePath, null);
      if (update?.message) this.dispatch(update, filePath);
    }
  }

  async api(method, body = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.telegram.requestTimeoutMs || TELEGRAM_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.config.telegram.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
      return result.result;
    } finally {
      clearTimeout(timer);
    }
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
      if (TERMINAL_SUBMISSION_STATES.has(status)) {
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
    if (message.document) return {
      fileId: message.document.file_id,
      name: message.document.file_name || `document-${message.message_id}`,
      mimeType: message.document.mime_type,
      size: message.document.file_size,
    };
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = message.photo.at(-1);
      return { fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", size: photo.file_size };
    }
    for (const kind of ["audio", "voice", "video", "video_note", "animation"]) {
      const media = message[kind];
      if (!media) continue;
      return {
        fileId: media.file_id,
        name: media.file_name || `${kind}-${message.message_id}${kind === "voice" ? ".ogg" : kind === "video_note" ? ".mp4" : ""}`,
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
    if (Number(file.size) > maxFileBytes) throw new Error(`Telegram file exceeds ${maxFileBytes} bytes`);
    const remote = await this.api("getFile", { file_id: file.fileId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.telegram.requestTimeoutMs || TELEGRAM_REQUEST_TIMEOUT_MS);
    let bytes;
    try {
      const response = await this.fetch(`https://api.telegram.org/file/bot${this.config.telegram.token}/${remote.file_path}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    if (bytes.length > maxFileBytes) throw new Error(`Telegram file exceeds ${maxFileBytes} bytes`);
    const dir = path.join(this.telegramDir, "inputs");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = safeFilename(file.name, `input-${message.message_id}`);
    const sourcePath = path.join(dir, `${message.chat.id}-${message.message_id}-${name}`);
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
    let transcript = null;
    let transcriptionError = null;
    if (String(file.mimeType || mimeTypeFor(name)).startsWith("audio/") && this.openaiHelper?.enabled) {
      try {
        transcript = await this.openaiHelper.transcribe({ sourcePath, name, mimeType: file.mimeType || mimeTypeFor(name) });
      } catch (err) {
        transcriptionError = `Audio transcription failed: ${err.message}`;
        this.log(`[telegram] ${transcriptionError}`);
      }
    }
    return [{
      sourcePath,
      name,
      mimeType: file.mimeType || mimeTypeFor(name),
      transcript,
      transcriptionError,
      temporary: true,
    }];
  }

  async sendFile(message, output) {
    if (Number(output.size) > TELEGRAM_DOCUMENT_LIMIT) {
      const error = new Error(`${output.originalName} exceeds Telegram's 50 MB document limit`);
      error.code = "TELEGRAM_OUTPUT_TOO_LARGE";
      throw error;
    }
    const filePath = output.archivePath || output.path;
    const stat = await fs.stat(filePath);
    if (stat.size > TELEGRAM_DOCUMENT_LIMIT) {
      const error = new Error(`${output.originalName} exceeds Telegram's 50 MB document limit`);
      error.code = "TELEGRAM_OUTPUT_TOO_LARGE";
      throw error;
    }
    const bytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("chat_id", String(message.chat.id));
    if (message.message_thread_id) form.append("message_thread_id", String(message.message_thread_id));
    form.append("document", new Blob([bytes], { type: output.mimeType || mimeTypeFor(output.originalName) }), output.originalName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.telegram.requestTimeoutMs || TELEGRAM_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.config.telegram.token}/sendDocument`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || "Telegram sendDocument failed");
      return result.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async control(message, route, command, { preempted = false } = {}) {
    const key = encodeURIComponent(this.sessionKey(message));
    if (command.name === "driver") {
      const driver = command.argument.toLowerCase();
      if (!["claude", "codex"].includes(driver)) {
        await this.send(message, "Choose /driver claude or /driver codex.");
        return;
      }
      if (!preempted) await this.runtime("POST", `/v1/sessions/${key}/interrupt`, {}).catch(() => {});
      await this.runtime("DELETE", `/v1/sessions/${key}`).catch(() => {});
      route.driver = driver;
      this.routes[this.routeKey(message)] = route;
      await writeAtomic(this.routesPath, this.routes);
      await this.send(message, `${driver === "claude" ? "Claude Code" : "Codex"} selected.`);
      return;
    }
    if (command.name === "status") {
      try {
        const result = await this.runtime("GET", `/v1/sessions/${key}`);
        const detail = result.session.activeSubmissionId ? ` (${result.session.activeSubmissionId})` : "";
        await this.send(message, `Status: ${result.session.status}${detail}`);
      } catch {
        await this.send(message, "No session has started yet.");
      }
      return;
    }
    if (command.name === "stop") {
      try {
        const result = await this.runtime("POST", `/v1/sessions/${key}/interrupt`, {});
        await this.send(message, result.interrupted ? "Stop requested." : "Nothing is running.");
      } catch (err) {
        if (err.statusCode === 404) await this.send(message, "Nothing is running.");
        else throw err;
      }
      return;
    }
    if (command.name === "reset") {
      if (!preempted) await this.runtime("POST", `/v1/sessions/${key}/interrupt`, {}).catch(() => {});
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = await this.runtime("GET", `/v1/sessions/${key}`).catch(() => null);
        if (!current?.session?.activeSubmissionId) break;
        await sleep(100);
      }
      await this.runtime("DELETE", `/v1/sessions/${key}`).catch(() => {});
      await this.ensureSession(message, route.driver);
      await this.send(message, "New conversation started.");
    }
  }

  async handle(message) {
    const text = String(message.text || message.caption || "").trim();
    const attached = this.telegramFile(message);
    if (!text && !attached) return;
    const routeKey = this.routeKey(message);
    const route = this.routes[routeKey] || { driver: this.config.telegram.defaultDriver };
    const command = commandFor(message);
    if (command && CONTROL_COMMANDS.has(command.name)) return this.control(message, route, command);

    if (command?.name === "start") {
      const status = await this.runtime("GET", `/v1/auth/${route.driver}/status`);
      if (status.auth.state === "unknown") {
        await this.send(message, `Could not verify ${route.driver === "claude" ? "Claude Code" : "Codex"} authentication: ${status.auth.error || "unknown error"}`);
        return;
      }
      if (!status.auth.authenticated) {
        await this.send(message, await this.authMessage(route.driver));
        return;
      }
      await this.ensureSession(message, route.driver);
      await this.send(message, `${route.driver === "claude" ? "Claude Code" : "Codex"} is ready.`);
      return;
    }

    let session = await this.ensureSession(message, route.driver);
    if (session.status === "auth_required") {
      await this.send(message, await this.authMessage(route.driver));
      return;
    }
    if (["stopped", "attention_required", "failed"].includes(session.status)) {
      const restarted = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}/restart`, {});
      session = restarted.session;
      if (session.status === "auth_required") {
        await this.send(message, await this.authMessage(route.driver));
        return;
      }
    }
    if (session.status !== "ready") {
      await this.send(message, `The ${route.driver === "claude" ? "Claude Code" : "Codex"} session needs attention: ${session.lastError || session.status}`);
      return;
    }
    const inputs = await this.downloadInputs(message);
    for (const input of inputs) if (input.transcriptionError) await this.send(message, input.transcriptionError);
    let accepted;
    try {
      accepted = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}/submissions`, {
        message: text,
        inputs: inputs.map(({ temporary, transcriptionError, ...input }) => ({ ...input, transcriptionError })),
        idempotencyKey: `telegram:${message.chat.id}:${message.message_id}`,
      });
    } finally {
      await Promise.all(inputs.filter((input) => input.temporary).map((input) => fs.rm(input.sourcePath, { force: true })));
    }
    await this.typing(message);
    const statusMessage = await this.sendStatus(message);
    const completed = await this.waitSubmission(message, accepted.submission.submissionId, statusMessage?.message_id);
    if (completed.status === "interrupted") return;
    if (completed.status !== "completed") {
      const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(this.sessionKey(message))}`);
      if (current.session.status === "auth_required") {
        await this.send(message, await this.authMessage(route.driver));
        return;
      }
    }
    await this.send(message, completed.status === "completed" ? completed.reply : `(model error: ${completed.error})`);
    if (completed.outputError) await this.send(message, `Output warning: ${completed.outputError}`);
    const pending = completed.status === "completed"
      ? (completed.outputs || []).filter((output) => output.deliveryStatus === "pending")
      : [];
    for (const output of pending) {
      try {
        await this.sendFile(message, output);
        await this.runtime("POST", `/v1/submissions/${encodeURIComponent(completed.submissionId)}/outputs/ack`, {
          outputIds: [output.outputId],
        });
      } catch (err) {
        await this.send(message, `Could not deliver ${output.originalName}: ${err.message}`);
      }
    }
  }

  dispatch(update, queuePath = null) {
    const id = String(update.update_id ?? `local:${update.message?.chat?.id}:${update.message?.message_id}`);
    if (this.inflightUpdates.has(id)) return;
    this.inflightUpdates.add(id);
    const message = update.message;
    const command = commandFor(message);
    const run = async (operation = () => this.handle(message)) => {
      try {
        await operation();
        if (queuePath) await fs.rm(queuePath, { force: true });
        this.retryCounts.delete(id);
      } catch (err) {
        this.log(`[telegram] update ${id} failed: ${err.message}`);
        let reported = false;
        try {
          await this.send(message, `Runtime error: ${err.message}`);
          reported = true;
        } catch {}
        if (reported) {
          if (queuePath) await fs.rm(queuePath, { force: true });
          this.retryCounts.delete(id);
        } else if (queuePath && !this.stopped) {
          const attempts = (this.retryCounts.get(id) || 0) + 1;
          this.retryCounts.set(id, attempts);
          if (attempts < 3) setTimeout(() => this.dispatch(update, queuePath), 2000 * attempts);
        }
      } finally {
        this.inflightUpdates.delete(id);
      }
    };
    if (command && IMMEDIATE_COMMANDS.has(command.name)) {
      void run();
      return;
    }
    const key = this.routeKey(message);
    const previous = this.chains.get(key) || Promise.resolve();
    let operation = () => this.handle(message);
    if (command && BARRIER_COMMANDS.has(command.name)) {
      const encoded = encodeURIComponent(this.sessionKey(message));
      const preempt = this.runtime("POST", `/v1/sessions/${encoded}/interrupt`, {}).then(() => null, (err) => (
        err.statusCode === 404 ? null : err
      ));
      const route = this.routes[key] || { driver: this.config.telegram.defaultDriver };
      operation = () => preempt.then((error) => {
        if (error) throw error;
        return this.control(message, route, command, { preempted: true });
      });
    }
    const next = previous.then(() => run(operation));
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
  }

  enqueue(message) {
    this.dispatch({ message });
  }

  acceptedMessage(update) {
    const message = update?.message;
    if (!message || (!message.text && !message.caption && !this.telegramFile(message))) return false;
    return this.config.telegram.allowedChatIds.has("*")
      || this.config.telegram.allowedChatIds.has(String(message.chat.id));
  }

  async acceptUpdate(update) {
    const nextOffset = Math.max(this.offset, Number(update.update_id) + 1);
    let queuePath = null;
    if (this.acceptedMessage(update)) {
      queuePath = path.join(this.queueDir, `${Number(update.update_id)}.json`);
      const existing = await readJson(queuePath, null);
      if (!existing) await writeAtomic(queuePath, update);
    }
    this.offset = nextOffset;
    await writeAtomic(this.offsetPath, { version: 1, offset: this.offset });
    if (queuePath) this.dispatch(update, queuePath);
  }

  async run() {
    await this.init();
    while (!this.stopped) {
      try {
        const updates = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] });
        for (const update of updates) await this.acceptUpdate(update);
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

module.exports = { CONTROL_COMMANDS, TELEGRAM_DOCUMENT_LIMIT, TelegramAdapter, chunks, commandFor };
