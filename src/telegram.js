"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { request } = require("./client");
const { readJson, sleep, writeAtomic } = require("./util");
const { mimeTypeFor, safeFilename } = require("./progress");
const { ProjectCatalog, validProjectName } = require("./project-catalog");
const { OwnerStore } = require("./owner-store");
const { RouteStore } = require("./route-store");
const { NoticeSpool, RunMarker, releaseIdFromPath, restartAnnouncement } = require("./notices");

const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;
const TERMINAL_SUBMISSION_STATES = new Set(["completed", "failed", "interrupted"]);
const CONTROL_COMMANDS = new Set(["project", "status", "stop", "reset", "driver"]);
const IMMEDIATE_COMMANDS = new Set(["status", "stop"]);
const BARRIER_COMMANDS = new Set(["project", "reset", "driver"]);
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_RICH_MESSAGE_LIMIT = 32_768;

function chunks(text, max = 4000) {
  const characters = Array.from(String(text || ""));
  if (characters.length === 0) return [""];
  const result = [];
  for (let offset = 0; offset < characters.length; offset += max) result.push(characters.slice(offset, offset + max).join(""));
  return result;
}

function richTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextValue).join("");
  if (!value || typeof value !== "object") return "";
  if (value.type === "custom_emoji") return String(value.alternative_text || "");
  if (value.type === "mathematical_expression") return String(value.expression || "");
  return richTextValue(value.text);
}

function richCaptionValue(caption) {
  if (!caption || typeof caption !== "object") return "";
  return [richTextValue(caption.text), richTextValue(caption.credit)].filter(Boolean).join("\n");
}

function richBlocksValue(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map(richBlockValue).filter(Boolean).join("\n");
}

function richBlockValue(block) {
  if (!block || typeof block !== "object") return "";
  if (["paragraph", "heading", "pre", "footer", "thinking"].includes(block.type)) {
    return richTextValue(block.text);
  }
  if (block.type === "divider") return "---";
  if (block.type === "mathematical_expression") return String(block.expression || "");
  if (block.type === "anchor") return "";
  if (block.type === "list") {
    return (Array.isArray(block.items) ? block.items : []).map((item) => {
      const content = richBlocksValue(item?.blocks);
      const label = String(item?.label || "-").trim();
      return content ? `${label} ${content}`.trim() : "";
    }).filter(Boolean).join("\n");
  }
  if (block.type === "blockquote") {
    return [richBlocksValue(block.blocks), richTextValue(block.credit)].filter(Boolean).join("\n");
  }
  if (block.type === "pullquote") {
    return [richTextValue(block.text), richTextValue(block.credit)].filter(Boolean).join("\n");
  }
  if (["collage", "slideshow"].includes(block.type)) {
    return [richBlocksValue(block.blocks), richCaptionValue(block.caption)].filter(Boolean).join("\n");
  }
  if (block.type === "table") {
    const rows = (Array.isArray(block.cells) ? block.cells : []).map((row) => (
      (Array.isArray(row) ? row : []).map((cell) => richTextValue(cell?.text)).join(" | ")
    )).filter(Boolean);
    return [richTextValue(block.caption), ...rows].filter(Boolean).join("\n");
  }
  if (block.type === "details") {
    return [richTextValue(block.summary), richBlocksValue(block.blocks)].filter(Boolean).join("\n");
  }
  if (["map", "animation", "audio", "photo", "video", "voice_note"].includes(block.type)) {
    return richCaptionValue(block.caption);
  }
  return [
    richTextValue(block.text),
    richTextValue(block.summary),
    richBlocksValue(block.blocks),
    richCaptionValue(block.caption),
  ].filter(Boolean).join("\n");
}

function richMessageValue(message) {
  return richBlocksValue(message?.rich_message?.blocks).trim();
}

function messageBody(message) {
  return String(message?.text || message?.caption || richMessageValue(message)).trim();
}

function submissionMessage(message, repliedInputs = []) {
  const current = messageBody(message);
  const replied = message?.reply_to_message;
  if (!replied) return current;
  const repliedText = messageBody(replied);
  if (!repliedText && repliedInputs.length === 0) return current;

  const lines = ["<telegram-reply-context>"];
  if (repliedText) lines.push("Replied-to message text:", repliedText);
  if (repliedInputs.length > 0) {
    if (repliedText) lines.push("");
    lines.push("Replied-to message attachments included with this request:");
    for (const input of repliedInputs) lines.push(`- ${input.name}`);
  }
  lines.push("</telegram-reply-context>", "", "Current message:", current || "(No text supplied.)");
  return lines.join("\n");
}

function sinceLabel(iso) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function commandFor(message) {
  const text = messageBody(message);
  const match = text.match(/^\/([a-z]+)(?:@\S+)?(?:\s+(.+))?$/i);
  return match ? { name: match[1].toLowerCase(), argument: String(match[2] || "").trim() } : null;
}

function topicThreadId(message) {
  return message?.is_topic_message === true && message.message_thread_id !== undefined
    && message.message_thread_id !== null ? message.message_thread_id : null;
}

function routeOperationCancelled() {
  return Object.assign(new Error("route operation cancelled"), { code: "ROUTE_OPERATION_CANCELLED" });
}

class TelegramAdapter {
  constructor({
    config,
    openaiHelper = null,
    fetchImpl = fetch,
    log = console.error,
    catalog = null,
    routeStore = null,
    ownerStore = null,
  }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.openaiHelper = openaiHelper;
    this.log = log;
    this.offset = 0;
    this.stopped = false;
    this.telegramDir = path.join(config.stateDir, "telegram");
    this.queueDir = path.join(this.telegramDir, "queue");
    this.offsetPath = path.join(this.telegramDir, "offset.json");
    this.catalog = catalog || new ProjectCatalog({ root: config.telegram.projectsRoot, log });
    this.routeStore = routeStore || new RouteStore({ stateDir: config.stateDir, log });
    this.ownerStore = ownerStore || new OwnerStore({ stateDir: config.stateDir, log });
    this.notices = new NoticeSpool({ dir: path.join(this.telegramDir, "notices"), log });
    this.runMarker = new RunMarker({ filePath: path.join(this.telegramDir, "last-run.json"), log });
    this.flushingNotices = false;
    this.noticeTimer = null;
    this.chains = new Map();
    this.routeSequences = new Map();
    this.pendingBarriers = new Map();
    this.activeOperationByRoute = new Map();
    this.inflightUpdates = new Set();
    this.retryCounts = new Map();
  }

  async init() {
    if (!this.config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN required");
    await fs.mkdir(this.queueDir, { recursive: true, mode: 0o700 });
    await this.ownerStore.init();
    await this.catalog.init();
    await this.routeStore.init();
    await this.notices.init();
    // Announce before the backlog is replayed, so the restart precedes the answers
    // to messages that arrived while the runtime was down.
    await this.announceRestart();
    await this.flushNotices();
    this.offset = Number((await readJson(this.offsetPath, {})).offset || 0);
    const queued = (await fs.readdir(this.queueDir).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    for (const name of queued) {
      const filePath = path.join(this.queueDir, name);
      const update = await readJson(filePath, null);
      if (update?.message && await this.acceptedMessage(update)) this.dispatch(update, filePath);
      else await fs.rm(filePath, { force: true });
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
    return `${message.chat.id}:${topicThreadId(message) ?? "main"}`;
  }

  routeState(message) {
    return this.routeStore.get(this.routeKey(message)) || Object.freeze({
      driver: this.config.telegram.defaultDriver,
    });
  }

  sessionKeyFor(routeKey, projectPath) {
    return `telegram:${routeKey}:${projectPath}`;
  }

  sessionKey(message, projectPath) {
    return this.sessionKeyFor(this.routeKey(message), projectPath);
  }

  topicFields(message) {
    const threadId = topicThreadId(message);
    return threadId === null ? {} : { message_thread_id: threadId };
  }

  async send(message, text) {
    const sent = [];
    for (const part of chunks(text)) {
      sent.push(await this.api("sendMessage", {
        chat_id: message.chat.id,
        ...this.topicFields(message),
        text: part || " ",
        disable_web_page_preview: true,
      }));
    }
    return sent;
  }

  async sendStatus(message, text = "Working.") {
    return this.api("sendMessage", {
      chat_id: message.chat.id,
      ...this.topicFields(message),
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

  async editRichStatus(message, messageId, markdown) {
    if (!messageId) return null;
    return this.api("editMessageText", {
      chat_id: message.chat.id,
      message_id: messageId,
      rich_message: { markdown },
    }).catch(() => null);
  }

  async finalizeStatus(message, messageId, text) {
    const value = String(text || "");
    if (Array.from(value).length <= TELEGRAM_RICH_MESSAGE_LIMIT) {
      const rich = await this.editRichStatus(message, messageId, value);
      if (rich) return [rich];
    }
    const parts = chunks(value);
    const edited = await this.editStatus(message, messageId, parts[0] || " ");
    if (!edited) return this.send(message, value);
    for (const part of parts.slice(1)) await this.send(message, part);
    return [edited];
  }

  async typing(message) {
    await this.api("sendChatAction", {
      chat_id: message.chat.id,
      ...this.topicFields(message),
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

  async ensureSession(message, driver, project) {
    const sessionKey = this.sessionKey(message, project.path);
    const key = encodeURIComponent(sessionKey);
    try {
      const current = await this.runtime("GET", `/v1/sessions/${key}`);
      if (current.session.status !== "closed") {
        if (current.session.driver !== driver || current.session.workspace !== project.path) {
          const error = new Error("runtime session identity does not match the selected project");
          error.code = "SESSION_IDENTITY_MISMATCH";
          throw error;
        }
        return current.session;
      }
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    const created = await this.runtime("POST", "/v1/sessions", {
      sessionKey,
      driver,
      workspace: project.path,
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
      if (TERMINAL_SUBMISSION_STATES.has(status)) return result.submission;
      const summary = String(result.submission.progress?.summary || "Working.").trim();
      if (summary && summary !== lastSummary
        && Date.now() - lastEditAt >= (this.config.telegram.statusEditIntervalMs || 5000)) {
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

  async downloadInputs(message, signal = null) {
    const file = this.telegramFile(message);
    if (!file) return [];
    if (signal?.aborted) throw routeOperationCancelled();
    const maxFileBytes = this.config.telegram.maxFileBytes || 20 * 1024 * 1024;
    if (Number(file.size) > maxFileBytes) throw new Error(`Telegram file exceeds ${maxFileBytes} bytes`);
    const remote = await this.api("getFile", { file_id: file.fileId });
    if (signal?.aborted) throw routeOperationCancelled();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.telegram.requestTimeoutMs || TELEGRAM_REQUEST_TIMEOUT_MS);
    let bytes;
    try {
      const response = await this.fetch(`https://api.telegram.org/file/bot${this.config.telegram.token}/${remote.file_path}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw routeOperationCancelled();
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
    if (signal?.aborted) throw routeOperationCancelled();
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
    if (signal?.aborted) {
      await fs.rm(sourcePath, { force: true });
      throw routeOperationCancelled();
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

  async downloadRepliedInputs(message, signal = null) {
    const replied = message?.reply_to_message;
    if (!replied || !this.telegramFile(replied)) return [];
    try {
      const inputs = await this.downloadInputs({ ...replied, chat: replied.chat || message.chat }, signal);
      const messageId = String(replied.message_id ?? "unknown");
      return inputs.map((input) => ({
        ...input,
        name: safeFilename(`replied-${messageId}-${input.name}`, `replied-${messageId}`),
        replyContext: true,
      }));
    } catch (err) {
      if (err.code === "ROUTE_OPERATION_CANCELLED") throw err;
      const wrapped = new Error(`Could not include replied-to attachment: ${err.message}`);
      wrapped.code = err.code;
      throw wrapped;
    }
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
    const threadId = topicThreadId(message);
    if (threadId !== null) form.append("message_thread_id", String(threadId));
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

  projectUnavailableText(projectName) {
    return `Project "${projectName}" is unavailable. Restore that exact directory name to resume its conversation, or select another project with /project <name>.`;
  }

  async sendCatalogError(message, error, projectName = null) {
    if (error?.code === "PROJECTS_ROOT_UNAVAILABLE") {
      await this.send(message, "The configured projects root is unavailable. Ask the operator to restore it.");
      return;
    }
    if (error?.code === "PROJECT_NAME_INVALID") {
      await this.send(message, "Project names may use only ASCII letters, digits, underscore, and hyphen.");
      return;
    }
    if (error?.code === "PROJECT_MISSING" && projectName) {
      await this.send(message, this.projectUnavailableText(projectName));
      return;
    }
    await this.send(message, `Project "${projectName || "requested"}" is not selectable.`);
  }

  async listProjects(message) {
    const route = this.routeState(message);
    let listing;
    try {
      listing = await this.catalog.list();
    } catch (err) {
      await this.sendCatalogError(message, err);
      return;
    }
    const lines = [];
    if (listing.projects.length === 0) {
      lines.push("No projects are available yet. Create a direct child directory in the configured projects root, then send /project again.");
    } else {
      lines.push("Projects:");
      for (const project of listing.projects) {
        lines.push(`- ${project.name}${route.project === project.name ? " (selected)" : ""}`);
      }
      lines.push("", "Select one with /project <name>.");
    }
    if (listing.hasInvalidNames) {
      lines.push("", "Some directories are not selectable because names may use only ASCII letters, digits, underscore, and hyphen.");
    }
    await this.send(message, lines.join("\n"));
  }

  sessionIdentity(message, projectName) {
    const projectPath = this.catalog.identityPath(projectName);
    return {
      projectPath,
      sessionKey: this.sessionKey(message, projectPath),
    };
  }

  async sessionAttached(sessionKey) {
    try {
      const result = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(sessionKey)}/attach`);
      return result.attached === true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  async cancelActiveOperation(message, { fallbackToSelected = false } = {}) {
    const routeKey = this.routeKey(message);
    const operation = this.activeOperationByRoute.get(routeKey);
    if (operation) {
      operation.cancelled = true;
      operation.controller.abort();
      if (operation.submissionId) {
        await this.runtime("POST", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}/interrupt`, {}).catch((err) => {
          if (err.statusCode !== 404) throw err;
        });
      }
      return { cancelled: true, sessionKey: operation.sessionKey };
    }
    if (fallbackToSelected) {
      const route = this.routeState(message);
      if (route.project) {
        const { sessionKey } = this.sessionIdentity(message, route.project);
        const result = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(sessionKey)}/interrupt`, {}).catch((err) => {
          if (err.statusCode === 404) return { interrupted: false };
          throw err;
        });
        return { cancelled: Boolean(result.interrupted), sessionKey };
      }
    }
    return { cancelled: false, sessionKey: null };
  }

  async settleSession(sessionKey, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(sessionKey)}`).catch((err) => {
        if (err.statusCode === 404) return null;
        throw err;
      });
      if (!current?.session?.activeSubmissionId) return;
      await sleep(100);
    }
  }

  barrierWouldPreempt(operation, command) {
    if (command.name === "reset") return true;
    if (command.name === "project") return command.argument !== operation.project;
    if (command.name === "driver") return command.argument.toLowerCase() !== operation.driver;
    return false;
  }

  addPendingBarrier(routeKey, ordinal, command) {
    const record = { ordinal, command };
    const pending = this.pendingBarriers.get(routeKey) || [];
    pending.push(record);
    this.pendingBarriers.set(routeKey, pending);
    return record;
  }

  removePendingBarrier(routeKey, record) {
    if (!record) return;
    const pending = (this.pendingBarriers.get(routeKey) || []).filter((item) => item !== record);
    if (pending.length) this.pendingBarriers.set(routeKey, pending);
    else this.pendingBarriers.delete(routeKey);
  }

  async prepareBarrier(message, command, ordinal) {
    if (command.name === "project") {
      if (!command.argument) return { listOnly: true };
      if (!validProjectName(command.argument)) return { validationError: "name" };
      try {
        await this.catalog.resolve(command.argument);
      } catch (error) {
        return { catalogError: error };
      }
    }
    if (command.name === "driver" && !["claude", "codex"].includes(command.argument.toLowerCase())) {
      return { validationError: "driver" };
    }
    const route = this.routeState(message);
    const requestedDriver = command.argument.toLowerCase();
    const routeKey = this.routeKey(message);
    const hasEarlierBarrier = (this.pendingBarriers.get(routeKey) || [])
      .some((record) => record.ordinal < ordinal);
    const idempotent = command.name === "project" ? route.project === command.argument
      : command.name === "driver" ? route.driver === requestedDriver : false;
    if (idempotent && !hasEarlierBarrier) return { idempotent: true };
    if ((command.name === "reset" || command.name === "driver") && route.project) {
      try {
        await this.catalog.resolve(route.project);
      } catch (error) {
        return { catalogError: error, currentProject: route.project };
      }
    }
    if (route.project) {
      const { sessionKey } = this.sessionIdentity(message, route.project);
      if (await this.sessionAttached(sessionKey)) return { attached: true };
    }
    const pendingBarrier = this.addPendingBarrier(routeKey, ordinal, command);
    try {
      const active = this.activeOperationByRoute.get(routeKey);
      if (command.name !== "project" || !active || active.project !== command.argument) {
        await this.cancelActiveOperation(message, { fallbackToSelected: true });
      }
      return { preempted: true, pendingBarrier };
    } catch (err) {
      this.removePendingBarrier(routeKey, pendingBarrier);
      throw err;
    }
  }

  async controlProject(message, command, preparation = {}) {
    if (!command.argument || preparation.listOnly) return this.listProjects(message);
    if (preparation.validationError === "name") return this.sendCatalogError(message, { code: "PROJECT_NAME_INVALID" });
    if (preparation.catalogError) return this.sendCatalogError(message, preparation.catalogError, command.argument);
    if (preparation.attached) {
      await this.send(message, "A tmux client is attached to this route's session. Detach it and retry the project switch.");
      return;
    }
    let target;
    try {
      target = await this.catalog.resolve(command.argument);
    } catch (err) {
      await this.sendCatalogError(message, err, command.argument);
      return;
    }
    const routeKey = this.routeKey(message);
    const route = this.routeState(message);
    if (route.project === target.name) {
      await this.send(message, `Project "${target.name}" is already selected.`);
      return;
    }
    if (route.project) {
      const previous = this.sessionIdentity(message, route.project);
      await this.settleSession(previous.sessionKey);
      try {
        await this.runtime("POST", `/v1/sessions/${encodeURIComponent(previous.sessionKey)}/release`, {});
      } catch (err) {
        if (err.statusCode === 409 && err.code === "SESSION_ATTACHED") {
          await this.send(message, "A tmux client is attached to this route's session. Detach it and retry the project switch.");
          return;
        }
        if (err.statusCode !== 404) throw err;
      }
    }
    await this.routeStore.update(routeKey, { driver: route.driver, project: target.name });
    await this.send(message, `Project "${target.name}" selected with ${route.driver === "claude" ? "Claude Code" : "Codex"}.`);
  }

  async controlStatus(message) {
    const routeKey = this.routeKey(message);
    const route = this.routeState(message);
    if (!route.project) {
      await this.send(message, `Route: ${routeKey}\nProject: unbound\nDriver: ${route.driver}\nSession: not started\nSelect a project with /project <name>.`);
      return;
    }
    let project = null;
    let availability = "available";
    try {
      project = await this.catalog.resolve(route.project);
    } catch (err) {
      availability = err.code === "PROJECTS_ROOT_UNAVAILABLE" ? "projects root unavailable" : "project unavailable";
    }
    const identity = this.sessionIdentity(message, route.project);
    const result = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(identity.sessionKey)}`).catch((err) => {
      if (err.statusCode === 404) return null;
      throw err;
    });
    const session = result?.session;
    const active = session?.activeSubmissionId
      ? await this.runtime("GET", `/v1/submissions/${encodeURIComponent(session.activeSubmissionId)}`).catch(() => null)
      : null;
    const lines = [
      `Route: ${routeKey}`,
      `Project: ${route.project} (${availability})`,
      `Driver: ${route.driver}`,
      `Session: ${session?.status || "not started"}`,
      `Workspace: ${project?.path || "unavailable"}`,
      `Active submission: ${session?.activeSubmissionId || "none"}`,
    ];
    // A turn has no wall-clock limit, so silence is the only thing worth watching.
    const running = sinceLabel(active?.submission?.startedAt);
    if (running) {
      const idle = sinceLabel(active.submission.lastProgressAt);
      lines.push(`Running for: ${running}${idle ? ` (last activity ${idle} ago)` : ""}`);
    }
    await this.send(message, lines.join("\n"));
  }

  async controlStop(message) {
    const stopped = await this.cancelActiveOperation(message, { fallbackToSelected: true });
    await this.send(message, stopped.cancelled ? "Stop requested." : "Nothing is running.");
  }

  async controlReset(message, preparation = {}) {
    const route = this.routeState(message);
    if (!route.project) {
      await this.send(message, "No project is selected. Use /project <name> first.");
      return;
    }
    if (preparation.catalogError) return this.sendCatalogError(message, preparation.catalogError, route.project);
    if (preparation.attached) {
      await this.send(message, "A tmux client is attached to this route's session. Detach it and retry /reset.");
      return;
    }
    try {
      await this.catalog.resolve(route.project);
    } catch (err) {
      await this.sendCatalogError(message, err, route.project);
      return;
    }
    const { sessionKey } = this.sessionIdentity(message, route.project);
    await this.settleSession(sessionKey);
    try {
      await this.runtime("DELETE", `/v1/sessions/${encodeURIComponent(sessionKey)}`);
    } catch (err) {
      if (err.statusCode === 409 && err.code === "SESSION_ATTACHED") {
        await this.send(message, "A tmux client is attached to this route's session. Detach it and retry /reset.");
        return;
      }
      if (err.statusCode !== 404) throw err;
    }
    await this.send(message, `Conversation reset for project "${route.project}". The next message starts fresh.`);
  }

  async controlDriver(message, command, preparation = {}) {
    const driver = command.argument.toLowerCase();
    if (preparation.validationError === "driver" || !["claude", "codex"].includes(driver)) {
      await this.send(message, "Choose /driver claude or /driver codex.");
      return;
    }
    const route = this.routeState(message);
    if (route.driver === driver) {
      await this.send(message, `${driver === "claude" ? "Claude Code" : "Codex"} is already selected.`);
      return;
    }
    if (preparation.catalogError) return this.sendCatalogError(message, preparation.catalogError, route.project);
    if (preparation.attached) {
      await this.send(message, "A tmux client is attached to this route's session. Detach it and retry the driver change.");
      return;
    }
    if (route.project) {
      try {
        await this.catalog.resolve(route.project);
      } catch (err) {
        await this.sendCatalogError(message, err, route.project);
        return;
      }
      const { sessionKey } = this.sessionIdentity(message, route.project);
      await this.settleSession(sessionKey);
      const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(sessionKey)}`).catch((err) => {
        if (err.statusCode === 404) return null;
        throw err;
      });
      if (current?.session?.status !== "closed" && current?.session?.driver !== driver) {
        try {
          await this.runtime("DELETE", `/v1/sessions/${encodeURIComponent(sessionKey)}`);
        } catch (err) {
          if (err.statusCode === 409 && err.code === "SESSION_ATTACHED") {
            await this.send(message, "A tmux client is attached to this route's session. Detach it and retry the driver change.");
            return;
          }
          if (err.statusCode !== 404) throw err;
        }
      }
    }
    await this.routeStore.update(this.routeKey(message), { driver, ...(route.project ? { project: route.project } : {}) });
    const selectedLabel = driver === "claude" ? "Claude Code" : "Codex";
    const previousLabel = route.driver === "claude" ? "Claude Code" : "Codex";
    await this.send(message, `${selectedLabel} selected. The next message starts or resumes its own conversation lazily; ${previousLabel} chat context is not transferred.`);
  }

  async control(message, command, preparation = {}) {
    if (command.name === "project" && !command.argument) return this.listProjects(message);
    if (command.name === "project") return this.controlProject(message, command, preparation);
    if (command.name === "status") return this.controlStatus(message);
    if (command.name === "stop") return this.controlStop(message);
    if (command.name === "reset") return this.controlReset(message, preparation);
    if (command.name === "driver") return this.controlDriver(message, command, preparation);
    return undefined;
  }

  checkOperation(operation) {
    if (operation.cancelled || operation.controller.signal.aborted) throw routeOperationCancelled();
  }

  async handleStart(message) {
    const route = this.routeState(message);
    if (!route.project) {
      await this.send(message, "No project is selected. Use /project <name>.");
      return;
    }
    try {
      await this.catalog.resolve(route.project);
    } catch (err) {
      await this.sendCatalogError(message, err, route.project);
      return;
    }
    const status = await this.runtime("GET", `/v1/auth/${route.driver}/status`);
    if (status.auth.state === "unknown") {
      await this.send(message, `Could not verify ${route.driver === "claude" ? "Claude Code" : "Codex"} authentication: ${status.auth.error || "unknown error"}`);
      return;
    }
    if (!status.auth.authenticated) {
      await this.send(message, await this.authMessage(route.driver));
      return;
    }
    await this.send(message, `Project "${route.project}" is selected and ${route.driver === "claude" ? "Claude Code" : "Codex"} is authenticated. Send a message to start lazily.`);
  }

  async handleOrdinary(message, route, ordinal = 0) {
    if (!route.project) {
      await this.send(message, "No project is selected. Use /project <name>.");
      return;
    }
    const routeKey = this.routeKey(message);
    const projectPath = this.catalog.identityPath(route.project);
    const operation = {
      routeKey,
      project: route.project,
      driver: route.driver,
      sessionKey: this.sessionKeyFor(routeKey, projectPath),
      submissionId: null,
      cancelled: false,
      controller: new AbortController(),
    };
    this.activeOperationByRoute.set(routeKey, operation);
    let inputs = [];
    try {
      const laterBarrier = (this.pendingBarriers.get(routeKey) || [])
        .find((record) => record.ordinal > ordinal && this.barrierWouldPreempt(operation, record.command));
      if (laterBarrier) {
        operation.cancelled = true;
        operation.controller.abort();
      }
      this.checkOperation(operation);
      const project = await this.catalog.resolve(route.project);
      this.checkOperation(operation);
      let session = await this.ensureSession(message, route.driver, project);
      this.checkOperation(operation);
      if (session.status === "auth_required") {
        await this.send(message, await this.authMessage(route.driver));
        return;
      }
      if (["stopped", "attention_required", "failed"].includes(session.status)) {
        const restarted = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}/restart`, {});
        this.checkOperation(operation);
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
      inputs.push(...await this.downloadInputs(message, operation.controller.signal));
      this.checkOperation(operation);
      const repliedInputs = await this.downloadRepliedInputs(message, operation.controller.signal);
      inputs.push(...repliedInputs);
      this.checkOperation(operation);
      for (const input of inputs) {
        if (input.transcript) {
          const label = input.replyContext ? "Replied-to audio transcript:" : "Your voice transcript:";
          await this.send(message, `${label}\n${input.transcript}`);
        }
        this.checkOperation(operation);
        if (input.transcriptionError) {
          const warning = input.replyContext
            ? `Replied-to media warning: ${input.transcriptionError}` : input.transcriptionError;
          await this.send(message, warning);
        }
        this.checkOperation(operation);
      }
      const accepted = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}/submissions`, {
        message: submissionMessage(message, repliedInputs),
        inputs: inputs.map(({ temporary, replyContext, transcriptionError, ...input }) => ({ ...input, transcriptionError })),
        idempotencyKey: `telegram:${message.chat.id}:${message.message_id}`,
      });
      operation.submissionId = accepted.submission.submissionId;
      if (operation.cancelled || operation.controller.signal.aborted) {
        await this.runtime("POST", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}/interrupt`, {}).catch((err) => {
          if (err.statusCode !== 404) throw err;
        });
      }
      this.checkOperation(operation);
      await this.typing(message);
      this.checkOperation(operation);
      const statusMessage = await this.sendStatus(message);
      const completed = await this.waitSubmission(message, operation.submissionId, statusMessage?.message_id);
      this.checkOperation(operation);
      if (completed.status === "interrupted") {
        await this.finalizeStatus(message, statusMessage?.message_id, "Interrupted.");
        return;
      }
      if (completed.status !== "completed") {
        const current = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}`);
        this.checkOperation(operation);
        if (current.session.status === "auth_required") {
          await this.finalizeStatus(message, statusMessage?.message_id, await this.authMessage(route.driver));
          return;
        }
      }
      await this.finalizeStatus(message, statusMessage?.message_id,
        completed.status === "completed" ? completed.reply : `(model error: ${completed.error})`);
      this.checkOperation(operation);
      if (completed.outputError) await this.send(message, `Output warning: ${completed.outputError}`);
      const pending = completed.status === "completed"
        ? (completed.outputs || []).filter((output) => output.deliveryStatus === "pending") : [];
      for (const output of pending) {
        this.checkOperation(operation);
        try {
          await this.sendFile(message, output);
          this.checkOperation(operation);
          await this.runtime("POST", `/v1/submissions/${encodeURIComponent(completed.submissionId)}/outputs/ack`, {
            outputIds: [output.outputId],
          });
        } catch (err) {
          if (err.code === "ROUTE_OPERATION_CANCELLED") throw err;
          await this.send(message, `Could not deliver ${output.originalName}: ${err.message}`);
        }
      }
    } catch (err) {
      if (err.code === "ROUTE_OPERATION_CANCELLED") return;
      if (["PROJECT_MISSING", "PROJECTS_ROOT_UNAVAILABLE", "PROJECT_INVALID"].includes(err.code)) {
        await this.sendCatalogError(message, err, route.project);
        return;
      }
      throw err;
    } finally {
      await Promise.all(inputs.filter((input) => input.temporary).map((input) => fs.rm(input.sourcePath, { force: true })));
      if (this.activeOperationByRoute.get(routeKey) === operation) this.activeOperationByRoute.delete(routeKey);
    }
  }

  async handle(message, { preparation = {}, ordinal = 0 } = {}) {
    const text = messageBody(message);
    const attached = this.telegramFile(message);
    if (!text && !attached) return;
    const command = commandFor(message);
    if (command && CONTROL_COMMANDS.has(command.name)) return this.control(message, command, preparation);
    if (command?.name === "start") return this.handleStart(message);
    return this.handleOrdinary(message, this.routeState(message), ordinal);
  }

  dispatch(update, queuePath = null) {
    const id = String(update.update_id ?? `local:${update.message?.chat?.id}:${update.message?.message_id}`);
    if (this.inflightUpdates.has(id)) return;
    this.inflightUpdates.add(id);
    const message = update.message;
    const routeKey = this.routeKey(message);
    const ordinal = (this.routeSequences.get(routeKey) || 0) + 1;
    this.routeSequences.set(routeKey, ordinal);
    const command = commandFor(message);
    const listsProjects = command?.name === "project" && !command.argument;
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
    if (listsProjects || (command && IMMEDIATE_COMMANDS.has(command.name))) {
      void run(() => this.handle(message, { ordinal }));
      return;
    }
    const key = routeKey;
    const previous = this.chains.get(key) || Promise.resolve();
    let operation = () => this.handle(message, { ordinal });
    if (command && BARRIER_COMMANDS.has(command.name)) {
      const preparation = this.prepareBarrier(message, command, ordinal);
      operation = async () => {
        const prepared = await preparation;
        try {
          return await this.handle(message, { preparation: prepared, ordinal });
        } finally {
          this.removePendingBarrier(key, prepared.pendingBarrier);
        }
      };
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

  async acceptedMessage(update) {
    const message = update?.message;
    if (!message || (!message.text && !message.caption && !this.telegramFile(message))) return false;
    if (this.ownerStore.get()) return this.ownerStore.authorize(message);
    const admittedChat = this.config.telegram.allowedChatIds.has("*")
      || this.config.telegram.allowedChatIds.has(String(message.chat.id));
    if (!admittedChat) return false;
    return this.ownerStore.authorize(message);
  }

  async acceptUpdate(update) {
    const nextOffset = Math.max(this.offset, Number(update.update_id) + 1);
    let queuePath = null;
    if (await this.acceptedMessage(update)) {
      queuePath = path.join(this.queueDir, `${Number(update.update_id)}.json`);
      const existing = await readJson(queuePath, null);
      if (!existing) await writeAtomic(queuePath, update);
    }
    this.offset = nextOffset;
    await writeAtomic(this.offsetPath, { version: 1, offset: this.offset });
    if (queuePath) this.dispatch(update, queuePath);
  }

  // Notices carry their own route; anything else is operational and goes to the
  // owner privately rather than into every bound project route.
  noticeTarget(route) {
    if (route?.chatId) {
      return route.threadId
        ? { chat: { id: route.chatId }, is_topic_message: true, message_thread_id: route.threadId }
        : { chat: { id: route.chatId } };
    }
    const owner = this.ownerStore.get();
    return owner ? { chat: { id: owner.userId } } : null;
  }

  async flushNotices() {
    if (this.flushingNotices) return;
    this.flushingNotices = true;
    try {
      for (const notice of await this.notices.drain()) {
        const target = this.noticeTarget(notice.route);
        if (!target) {
          this.log(`[telegram] dropped ${notice.kind} notice: no route and no bound owner`);
          continue;
        }
        await this.send(target, notice.text)
          .catch((err) => this.log(`[telegram] ${notice.kind} notice failed: ${err.message}`));
      }
    } catch (err) {
      this.log(`[telegram] notice drain failed: ${err.message}`);
    } finally {
      this.flushingNotices = false;
    }
  }

  // Only the unexplained restart is ours to report: a planned one is announced by
  // whoever planned it, and it knows the reason we cannot see.
  async announceRestart() {
    const marker = await this.runMarker.start({
      release: releaseIdFromPath(process.argv[1]),
      windowMs: this.config.telegram.restartAnnounceWindowMs,
    }).catch((err) => {
      this.log(`[telegram] run marker unavailable: ${err.message}`);
      return null;
    });
    if (!marker?.announce) return;
    const target = this.noticeTarget(null);
    if (!target) {
      this.log("[telegram] unexpected restart not announced: no bound owner");
      return;
    }
    await this.send(target, restartAnnouncement(marker))
      .catch((err) => this.log(`[telegram] restart announcement failed: ${err.message}`));
  }

  async markCleanStop() {
    await this.runMarker.markCleanStop().catch((err) => this.log(`[telegram] clean-stop marker failed: ${err.message}`));
  }

  async run() {
    await this.init();
    // A stop notice must not wait out a 25-second long poll.
    this.noticeTimer = setInterval(() => { this.flushNotices().catch(() => {}); },
      this.config.telegram.noticePollMs || 1000);
    this.noticeTimer.unref?.();
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
    if (this.noticeTimer) {
      clearInterval(this.noticeTimer);
      this.noticeTimer = null;
    }
  }
}

module.exports = {
  BARRIER_COMMANDS,
  CONTROL_COMMANDS,
  TELEGRAM_DOCUMENT_LIMIT,
  TelegramAdapter,
  chunks,
  commandFor,
  topicThreadId,
};
