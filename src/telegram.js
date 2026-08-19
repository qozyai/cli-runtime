"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { request } = require("./client");
const { SUBMISSION_SOURCE_OWNER, readJson, sleep, writeAtomic } = require("./util");
const { mimeTypeFor, safeFilename } = require("./progress");
const { ProjectCatalog, validProjectName } = require("./project-catalog");
const { OwnerStore, senderUserId, userId } = require("./owner-store");
const { RouteStore } = require("./route-store");
const { NoticeSpool, RunMarker, releaseIdFromPath, restartAnnouncement } = require("./notices");

const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;
const TERMINAL_SUBMISSION_STATES = new Set(["completed", "failed", "interrupted"]);
const CONTROL_COMMANDS = new Set(["project", "status", "stop", "reset", "driver", "attach"]);
const IMMEDIATE_COMMANDS = new Set(["status", "stop", "attach"]);
const BARRIER_COMMANDS = new Set(["project", "reset", "driver"]);
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_ATTACH_SERVICE_TIMEOUT_MS = 45_000;
const TELEGRAM_RICH_MESSAGE_LIMIT = 32_768;
const SYSTEM_INGRESS = Symbol("telegram-system-ingress");

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

function submissionMessage(message, repliedInputs = [], repliedWarning = null) {
  const current = messageBody(message);
  const replied = message?.reply_to_message;
  if (!replied) return current;
  const repliedText = messageBody(replied);
  if (!repliedText && repliedInputs.length === 0 && !repliedWarning) return current;

  const lines = ["<telegram-reply-context>"];
  if (repliedText) lines.push("Replied-to message text:", repliedText);
  if (repliedInputs.length > 0) {
    if (repliedText) lines.push("");
    lines.push("Replied-to message attachments included with this request:");
    for (const input of repliedInputs) lines.push(`- ${input.name}`);
  }
  // The driver is told what it is missing rather than left to infer a complete quote.
  if (repliedWarning) {
    if (repliedText || repliedInputs.length > 0) lines.push("");
    lines.push(`Replied-to attachment unavailable: ${repliedWarning}`);
  }
  lines.push("</telegram-reply-context>", "", "Current message:", current || "(No text supplied.)");
  return lines.join("\n");
}

function systemIngress(message) {
  return message?.[SYSTEM_INGRESS] || null;
}

function provenanceMessage(message, content) {
  const ingress = systemIngress(message);
  if (!ingress) return content;
  return [
    `<system-intervention source="telegram-admin" sender-user-id="${ingress.adminUserId}">`,
    "The following input was authored by a system operator, not by the Telegram owner:",
    content || "(No text supplied.)",
    "</system-intervention>",
  ].join("\n");
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

function matchesOwnerEnrollmentCode(message, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ""))) return false;
  const command = commandFor(message);
  const code = command?.name === "start" ? command.argument : "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return false;
  const actual = createHash("sha256").update(code, "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
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
    this.bursts = new Map();
    this.inflightUpdates = new Set();
    this.retryCounts = new Map();
  }

  async init() {
    if (!this.config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN required");
    await fs.mkdir(this.queueDir, { recursive: true, mode: 0o700 });
    await this.ownerStore.init();
    await this.catalog.init();
    await this.routeStore.init();
    // Announce before the backlog is replayed, so the restart precedes the answers
    // to messages that arrived while the runtime was down. None of it may stop the
    // adapter from starting: announcements are a courtesy, ingress is the job.
    // Each step degrades on its own: a failed announcement must not skip the spool,
    // and neither may stop ingress.
    for (const [label, step] of [
      ["notice spool", () => this.notices.init()],
      ["restart announcement", () => this.announceRestart()],
      ["notice delivery", () => this.flushNotices()],
    ]) {
      try {
        await step();
      } catch (err) {
        this.log(`[telegram] ${label} unavailable: ${err.message}`);
      }
    }
    this.offset = Number((await readJson(this.offsetPath, {})).offset || 0);
    const queued = (await fs.readdir(this.queueDir).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    for (const name of queued) {
      const filePath = path.join(this.queueDir, name);
      const update = await readJson(filePath, null);
      const admitted = update?.message ? await this.admitUpdate(update) : null;
      if (admitted) this.dispatch(admitted, filePath);
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
    const saved = this.routeStore.get(this.routeKey(message));
    const project = saved?.project || this.config.telegram.defaultProject;
    return Object.freeze({
      driver: saved?.driver || this.config.telegram.defaultDriver,
      ...(project ? { project } : {}),
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

  async notifySystemIngress(message) {
    if (!systemIngress(message)) return;
    const text = messageBody(message);
    const attachment = this.telegramFile(message);
    const content = [
      text,
      attachment ? `[Attachment: ${attachment.name}]` : "",
    ].filter(Boolean).join("\n\n") || "(No text supplied.)";
    await this.send(message, `⚙️ System intervention received\n\n${content}`);
  }

  submissionIdempotencyKey(message) {
    const ingress = systemIngress(message);
    if (ingress) {
      return `telegram:system:${ingress.adminUserId}:${ingress.sourceMessageId}:owner:${message.chat.id}`;
    }
    return `telegram:${message.chat.id}:${message.message_id}`;
  }

  async sendStatus(message, text = "Working.") {
    return this.api("sendMessage", {
      chat_id: message.chat.id,
      ...this.topicFields(message),
      text,
      disable_web_page_preview: true,
    });
  }

  async sendButtons(message, text, buttons) {
    return this.api("sendMessage", {
      chat_id: message.chat.id,
      ...this.topicFields(message),
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: buttons.map((button) => [{ text: button.label, url: button.url }]),
      },
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
    const name = driver === "claude" ? "Claude Code" : "Codex";
    let terminal = true;
    try {
      await this.runtime("POST", `/v1/auth/${driver}/start`, { force });
    } catch (err) {
      terminal = false;
      this.log(`[telegram] could not start ${driver} authentication terminal: ${err.message}`);
    }
    const lines = [`This attempt failed because ${name} needs authentication.`];
    if (terminal) lines.push("", `Use /attach, choose ${name} authentication, complete login in the terminal, then send your message again.`);
    else lines.push("", "The authentication terminal could not be started. Try /attach again shortly, then resend your message.");
    return lines.join("\n");
  }

  async attentionMessage(driver, session) {
    const name = driver === "claude" ? "Claude Code" : "Codex";
    let terminal = true;
    try {
      await this.runtime("POST", `/v1/auth/${driver}/start`, { force: false });
    } catch (err) {
      terminal = false;
      this.log(`[telegram] could not start ${driver} troubleshooting terminal: ${err.message}`);
    }
    const lines = [`The ${name} session needs attention: ${session.lastError || session.status}`];
    if (terminal) {
      lines.push("", `Use /attach and choose ${name} authentication to inspect or log in, then send your message again.`);
    } else {
      lines.push("", "The manual terminal could not be started. Try /attach again shortly, then resend your message.");
    }
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

  async controlStop(message, droppedBurst = 0) {
    const stopped = await this.cancelActiveOperation(message, { fallbackToSelected: true });
    const dropped = Number(droppedBurst) > 0
      ? ` Dropped ${droppedBurst} unsent message${droppedBurst === 1 ? "" : "s"}.` : "";
    await this.send(message, `${stopped.cancelled ? "Stop requested." : "Nothing is running."}${dropped}`);
  }

  async controlAttach(message) {
    const serviceUrl = String(this.config.telegram.attachServiceUrl || "").trim();
    if (!serviceUrl) {
      await this.send(message, "Terminal attachment is not configured for this agent.");
      return;
    }

    const route = this.routeState(message);
    let current = null;
    if (route.project) {
      const { sessionKey } = this.sessionIdentity(message, route.project);
      const info = await this.runtime("GET", `/v1/sessions/${encodeURIComponent(sessionKey)}/attach`).catch((err) => {
        if (err.statusCode === 404) return null;
        throw err;
      });
      if (info?.command) {
        current = {
          label: `${route.driver === "claude" ? "Claude Code" : "Codex"} · ${route.project}`,
          attachCommand: info.command,
        };
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.telegram.attachServiceTimeoutMs || TELEGRAM_ATTACH_SERVICE_TIMEOUT_MS,
    );
    let result;
    try {
      const response = await this.fetch(serviceUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current }),
        signal: controller.signal,
      });
      result = await response.json();
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || `attachment service failed (${response.status})`);
      }
    } catch (err) {
      this.log(`[telegram] terminal attachment unavailable: ${err.message}`);
      await this.send(message, "Terminal attachment is temporarily unavailable. Try /attach again.");
      return;
    } finally {
      clearTimeout(timeout);
    }

    const terminals = (Array.isArray(result.terminals) ? result.terminals : []).flatMap((terminal) => {
      const label = String(terminal?.label || "").trim();
      const url = String(terminal?.url || "").trim();
      if (!label || Array.from(label).length > 64) return [];
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return [];
      } catch {
        return [];
      }
      return [{ label, url }];
    }).slice(0, 8);

    if (terminals.length === 0) {
      await this.send(message, "No attachable terminals are running for this conversation.");
      return;
    }
    await this.sendButtons(message, "Choose a terminal:", terminals);
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

  async control(message, command, preparation = {}, droppedBurst = 0) {
    if (command.name === "project" && !command.argument) return this.listProjects(message);
    if (command.name === "project") return this.controlProject(message, command, preparation);
    if (command.name === "status") return this.controlStatus(message);
    if (command.name === "stop") return this.controlStop(message, droppedBurst);
    if (command.name === "reset") return this.controlReset(message, preparation);
    if (command.name === "driver") return this.controlDriver(message, command, preparation);
    if (command.name === "attach") return this.controlAttach(message);
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
    await this.send(message, `Project "${route.project}" is selected with ${route.driver === "claude" ? "Claude Code" : "Codex"}. Send a message and the driver will be attempted.`);
  }

  async handleOrdinary(message, route, ordinal = 0, parts = null) {
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
        const restarted = await this.runtime("POST", `/v1/sessions/${encodeURIComponent(operation.sessionKey)}/restart`, {});
        this.checkOperation(operation);
        session = restarted.session;
        if (session.status === "auth_required") {
          await this.send(message, await this.authMessage(route.driver));
          return;
        }
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
        await this.send(message, await this.attentionMessage(route.driver, session));
        return;
      }
      // Each part contributes what it would have contributed alone, including its own
      // reply context, so a joined burst loses nothing a separate turn would have had.
      const burst = Array.isArray(parts) && parts.length > 0 ? parts : [message];
      const pieces = [];
      for (const part of burst) {
        inputs.push(...await this.downloadInputs(part, operation.controller.signal));
        this.checkOperation(operation);
        // Quoted context is an enrichment of the user's message, not a precondition for
        // it: if the attachment cannot be fetched, say so and still run the turn.
        let repliedInputs = [];
        let repliedWarning = null;
        try {
          repliedInputs = await this.downloadRepliedInputs(part, operation.controller.signal);
        } catch (err) {
          if (err.code === "ROUTE_OPERATION_CANCELLED") throw err;
          repliedWarning = err.message;
          await this.send(message, `Continuing without the replied-to attachment: ${err.message}`).catch(() => {});
        }
        inputs.push(...repliedInputs);
        this.checkOperation(operation);
        const piece = provenanceMessage(part, submissionMessage(part, repliedInputs, repliedWarning));
        if (piece) pieces.push(piece);
      }
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
        message: pieces.join("\n"),
        inputs: inputs.map(({ temporary, replyContext, transcriptionError, ...input }) => ({ ...input, transcriptionError })),
        idempotencyKey: this.submissionIdempotencyKey(message),
        // A person typed this. Stated rather than assumed, so retention measures
        // conversation rather than whatever else reaches the same endpoint.
        source: SUBMISSION_SOURCE_OWNER,
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

  async handle(message, { preparation = {}, ordinal = 0, parts = null, droppedBurst = 0 } = {}) {
    const text = messageBody(message);
    const attached = this.telegramFile(message);
    if (!text && !attached) return;
    const messages = Array.isArray(parts) && parts.length > 0 ? parts : [message];
    for (const part of messages) await this.notifySystemIngress(part);
    const command = commandFor(message);
    if (command && CONTROL_COMMANDS.has(command.name)) return this.control(message, command, preparation, droppedBurst);
    if (command?.name === "start") return this.handleStart(message);
    return this.handleOrdinary(message, this.routeState(message), ordinal, parts);
  }

  // Messages that arrive together are one thought. A client that splits a long paste
  // into several messages must not become several turns, so an ordinary message waits
  // a short quiet period that every later arrival resets.
  bufferBurst(routeKey, part) {
    const debounceMs = Number(this.config.telegram.burstDebounceMs ?? 200);
    if (!(debounceMs > 0)) {
      this.queueBurst(routeKey, [part]);
      return;
    }
    const burst = this.bursts.get(routeKey) || { parts: [], timer: null, firstAt: Date.now() };
    burst.parts.push(part);
    this.bursts.set(routeKey, burst);
    if (burst.timer) clearTimeout(burst.timer);
    burst.timer = null;
    const maxWaitMs = Number(this.config.telegram.burstMaxWaitMs || 2000);
    const maxParts = Number(this.config.telegram.burstMaxParts || 25);
    const elapsed = Date.now() - burst.firstAt;
    if (burst.parts.length >= maxParts || elapsed >= maxWaitMs) {
      this.flushBurst(routeKey);
      return;
    }
    burst.timer = setTimeout(() => this.flushBurst(routeKey), Math.min(debounceMs, maxWaitMs - elapsed));
    burst.timer.unref?.();
  }

  takeBurst(routeKey) {
    const burst = this.bursts.get(routeKey);
    if (!burst) return [];
    this.bursts.delete(routeKey);
    if (burst.timer) clearTimeout(burst.timer);
    return burst.parts;
  }

  flushBurst(routeKey) {
    const parts = this.takeBurst(routeKey);
    if (parts.length > 0) this.queueBurst(routeKey, parts);
    return parts.length;
  }

  // /stop cannot mean "and then run what I was still typing".
  async discardBurst(routeKey) {
    const parts = this.takeBurst(routeKey);
    for (const part of parts) {
      if (part.queuePath) await fs.rm(part.queuePath, { force: true }).catch(() => {});
      this.inflightUpdates.delete(part.id);
    }
    return parts.length;
  }

  queueBurst(routeKey, parts) {
    const primary = parts[0];
    const previous = this.chains.get(routeKey) || Promise.resolve();
    const next = previous.then(() => this.runParts(parts, () => this.handle(primary.message, {
      ordinal: primary.ordinal,
      parts: parts.map((part) => part.message),
    })));
    const tracked = next.finally(() => {
      if (this.chains.get(routeKey) === tracked) this.chains.delete(routeKey);
    });
    this.chains.set(routeKey, tracked);
  }

  async runParts(parts, operation) {
    const primary = parts[0];
    const message = primary.message;
    const settle = async () => {
      for (const part of parts) {
        if (part.queuePath) await fs.rm(part.queuePath, { force: true });
      }
      this.retryCounts.delete(primary.id);
    };
    try {
      await operation();
      await settle();
    } catch (err) {
      this.log(`[telegram] update ${primary.id} failed: ${err.message}`);
      let reported = false;
      try {
        await this.send(message, `Runtime error: ${err.message}`);
        reported = true;
      } catch {}
      if (reported) {
        await settle();
      } else if (parts.some((part) => part.queuePath) && !this.stopped) {
        const attempts = (this.retryCounts.get(primary.id) || 0) + 1;
        this.retryCounts.set(primary.id, attempts);
        if (attempts < 3) {
          setTimeout(() => {
            for (const part of parts) this.dispatch(part.update, part.queuePath);
          }, 2000 * attempts);
        }
      }
    } finally {
      for (const part of parts) this.inflightUpdates.delete(part.id);
    }
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
    const part = { id, update, message, queuePath, ordinal };
    if (!command) {
      this.bufferBurst(routeKey, part);
      return;
    }
    // A command is never absorbed into a burst: it either supersedes what was
    // buffered or lets it through first, so arrival order still holds.
    const pending = command.name === "stop" ? this.discardBurst(routeKey) : Promise.resolve(this.flushBurst(routeKey));
    const listsProjects = command.name === "project" && !command.argument;
    const run = (operation) => Promise.resolve(pending).then((dropped) => this.runParts([part], () => operation(dropped)));
    if (listsProjects || IMMEDIATE_COMMANDS.has(command.name)) {
      void run((dropped) => this.handle(message, { ordinal, droppedBurst: dropped }));
      return;
    }
    const key = routeKey;
    const previous = this.chains.get(key) || Promise.resolve();
    let operation = () => run((dropped) => this.handle(message, { ordinal, droppedBurst: dropped }));
    if (BARRIER_COMMANDS.has(command.name)) {
      const preparation = this.prepareBarrier(message, command, ordinal);
      operation = () => run(async (dropped) => {
        const prepared = await preparation;
        try {
          return await this.handle(message, { preparation: prepared, ordinal, droppedBurst: dropped });
        } finally {
          this.removePendingBarrier(key, prepared.pendingBarrier);
        }
      });
    }
    const next = previous.then(() => operation());
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
  }

  enqueue(message) {
    this.dispatch({ message });
  }

  systemIngressUpdate(update, owner, adminUserId) {
    const original = update.message;
    const message = {
      ...original,
      chat: { id: owner.userId, type: "private" },
    };
    delete message.message_thread_id;
    delete message.is_topic_message;
    Object.defineProperty(message, SYSTEM_INGRESS, {
      value: Object.freeze({
        version: 1,
        source: "telegram-admin",
        adminUserId,
        sourceChatId: String(original.chat.id),
        sourceMessageId: String(original.message_id),
      }),
      enumerable: false,
    });
    return { ...update, message };
  }

  async admitUpdate(update) {
    const message = update?.message;
    if (!message || (!message.text && !message.caption && !this.telegramFile(message))) return null;
    const owner = this.ownerStore.get();
    if (owner) {
      if (await this.ownerStore.authorize(message)) return update;
      const adminUserId = senderUserId(message);
      const systemIngressChatIds = this.config.telegram.systemIngressChatIds || new Set();
      const privateAdminMessage = adminUserId
        && message?.chat?.type === "private"
        && userId(message.chat.id) === adminUserId;
      return privateAdminMessage && systemIngressChatIds.has(adminUserId)
        ? this.systemIngressUpdate(update, owner, adminUserId)
        : null;
    }
    if (this.config.telegram.ownerEnrollmentCodeHash) {
      if (!matchesOwnerEnrollmentCode(message, this.config.telegram.ownerEnrollmentCodeHash)) return null;
      return await this.ownerStore.authorize(message) ? update : null;
    }
    const admittedChat = this.config.telegram.allowedChatIds.has("*")
      || this.config.telegram.allowedChatIds.has(String(message.chat.id));
    if (!admittedChat) return null;
    return await this.ownerStore.authorize(message) ? update : null;
  }

  async acceptedMessage(update) {
    return Boolean(await this.admitUpdate(update));
  }

  async acceptUpdate(update) {
    const nextOffset = Math.max(this.offset, Number(update.update_id) + 1);
    let queuePath = null;
    const admitted = await this.admitUpdate(update);
    if (admitted) {
      queuePath = path.join(this.queueDir, `${Number(update.update_id)}.json`);
      const existing = await readJson(queuePath, null);
      if (!existing) await writeAtomic(queuePath, update);
    }
    this.offset = nextOffset;
    await writeAtomic(this.offsetPath, { version: 1, offset: this.offset });
    if (queuePath) this.dispatch(admitted, queuePath);
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
    // Buffered parts stay on disk in the queue and re-form on the next start.
    for (const routeKey of [...this.bursts.keys()]) this.takeBurst(routeKey);
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
