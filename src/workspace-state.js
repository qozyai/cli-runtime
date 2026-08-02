"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { appendJsonl, nowIso, safeId, tailText, writeAtomic } = require("./util");

const BREAK_MS = 6 * 60 * 60 * 1000;
const WORK_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_REASONING_CHUNKS = 3;
const MAX_TOOL_USES = 3;
const MAX_REASONING_CHARS = 2000;
const MAX_TOOL_ARGUMENT_CHARS = 4096;
const MAX_TOOL_ERROR_CHARS = 4000;
const MAX_STATUS_CHARS = 500;
const MAX_HISTORY_MESSAGE_CHARS = 40_000;

const MIME_BY_EXTENSION = new Map([
  [".aac", "audio/aac"],
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampForName(value = new Date()) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFilename(value, fallback = "file") {
  const base = path.basename(String(value || "")).normalize("NFKD");
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 160) || fallback;
}

function mimeTypeFor(filePath, fallback = "application/octet-stream") {
  return MIME_BY_EXTENSION.get(path.extname(String(filePath || "")).toLowerCase()) || fallback;
}

function redactText(value) {
  return String(value || "")
    .replace(/\b(?:sk|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\b\d{6,12}:AA[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[redacted]")
    .replace(/((?:"?(?:api[_-]?key|access[_-]?token|password|secret|authorization)"?)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[redacted]");
}

function boundedText(value, maxChars) {
  const normalized = redactText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}

function boundedHistoryText(value, maxChars = MAX_HISTORY_MESSAGE_CHARS) {
  const text = redactText(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 28))}\n[history text truncated]`;
}

function sanitizeValue(value, maxChars = MAX_TOOL_ARGUMENT_CHARS, key = "") {
  if (/token|password|secret|authorization|api[_-]?key/i.test(key)) return "[redacted]";
  if (typeof value === "string") return boundedText(value, maxChars);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const result = value.slice(0, 50).map((item) => sanitizeValue(item, maxChars));
    let encoded = "";
    try { encoded = JSON.stringify(result); } catch { encoded = String(result); }
    return encoded.length > maxChars ? boundedText(encoded, maxChars) : result;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      result[childKey] = sanitizeValue(childValue, maxChars, childKey);
    }
    let encoded = "";
    try { encoded = JSON.stringify(result); } catch { encoded = String(result); }
    if (encoded.length > maxChars) return boundedText(encoded, maxChars);
    return result;
  }
  return boundedText(String(value ?? ""), maxChars);
}

function sanitizeToolArguments(value) {
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return sanitizeValue(parsed);
    } catch {}
  }
  return sanitizeValue(value);
}

function normalizeProgress(progress, status = "running") {
  const reasoning = [];
  const reasoningInput = Array.isArray(progress?.reasoning) ? progress.reasoning : [];
  for (let index = reasoningInput.length - 1; index >= 0 && reasoning.length < MAX_REASONING_CHUNKS; index -= 1) {
    const item = boundedText(reasoningInput[index], MAX_REASONING_CHARS);
    if (item) reasoning.unshift(item);
  }
  const tools = (Array.isArray(progress?.toolUses) ? progress.toolUses : []).slice(-MAX_TOOL_USES).map((tool) => ({
    callId: tool?.id || tool?.callId || null,
    tool: boundedText(tool?.tool || "unknown", 200),
    arguments: sanitizeToolArguments(tool?.arguments ?? null),
    success: typeof tool?.success === "boolean" ? tool.success : null,
    error: tool?.success === false ? boundedText(tool?.error || "tool failed", MAX_TOOL_ERROR_CHARS) : null,
  }));
  return {
    status,
    throughOffset: Number.isFinite(progress?.throughOffset) ? progress.throughOffset : null,
    artifactPath: progress?.artifactPath || null,
    providerSessionId: progress?.providerSessionId || null,
    reasoning,
    tools,
    lastAssistantMessage: boundedText(progress?.lastAssistantMessage || "", 8000),
    lastError: boundedText(progress?.lastError || "", MAX_TOOL_ERROR_CHARS) || null,
  };
}

function summarizeProgress(progress, status = "running", normalizedProgress = null) {
  const normalized = normalizedProgress || normalizeProgress(progress, status);
  const lines = [];
  if (status === "completed") lines.push("Completed.");
  else if (["failed", "interrupted"].includes(status)) lines.push(status === "failed" ? "Stopped with an error." : "Interrupted.");
  else lines.push("Working.");
  if (normalized.reasoning.length > 0) lines.push(normalized.reasoning.at(-1));
  else if (status === "running" && normalized.lastAssistantMessage) lines.push(normalized.lastAssistantMessage);
  if (normalized.tools.length > 0) {
    lines.push(`Recent tools: ${normalized.tools.map((tool) => {
      const marker = tool.success === true ? "ok" : tool.success === false ? "failed" : "running";
      return `${tool.tool} (${marker})`;
    }).join(", ")}`);
  }
  if (normalized.lastError) lines.push(`Error: ${normalized.lastError}`);
  const summary = lines.join("\n").trim();
  if (summary.length <= MAX_STATUS_CHARS) return summary;
  return `${summary.slice(0, Math.max(0, MAX_STATUS_CHARS - 14))}...[truncated]`;
}

function buildWorkClusters(turns) {
  const clusters = [];
  for (const turn of turns) {
    const startAtMs = parseTime(turn.inboundAt);
    const endAtMs = parseTime(turn.completedAt);
    if (startAtMs === null || endAtMs === null) continue;
    const current = { turn, startAtMs, endAtMs };
    const last = clusters.at(-1);
    if (!last || startAtMs - last.endAtMs >= BREAK_MS) {
      clusters.push({ startAtMs, endAtMs, turns: [current] });
    } else {
      last.turns.push(current);
      last.endAtMs = Math.max(last.endAtMs, endAtMs);
    }
  }
  return clusters;
}

function selectRecentTurns(turns) {
  const clusters = buildWorkClusters(turns);
  const selected = [];
  let accumulatedMs = 0;
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    const cluster = clusters[index];
    selected.push(cluster);
    accumulatedMs += Math.max(0, cluster.endAtMs - cluster.startAtMs);
    if (accumulatedMs >= WORK_WINDOW_MS) break;
  }
  return selected.reverse().flatMap((cluster) => cluster.turns.map((item) => item.turn));
}

async function writeTextAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function readJsonl(filePath) {
  let text;
  try { text = await fs.readFile(filePath, "utf8"); } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const result = [];
  const lines = text.split("\n");
  const finalLineMayBePartial = text.length > 0 && !text.endsWith("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { result.push(JSON.parse(line)); } catch {
      if (finalLineMayBePartial && index === lines.length - 1) {
        const lastNewline = text.lastIndexOf("\n");
        await fs.truncate(filePath, lastNewline < 0 ? 0 : Buffer.byteLength(text.slice(0, lastNewline + 1)));
        break;
      }
      throw new Error(`invalid JSONL at ${filePath}:${index + 1}`);
    }
  }
  return result;
}

class WorkspaceState {
  constructor({ config, eventStore = null } = {}) {
    this.config = config || {};
    this.eventStore = eventStore;
    this.maxInputFiles = Number(config?.workspaceMaxInputFiles) || 20;
    this.maxInputFileBytes = Number(config?.workspaceMaxInputFileBytes) || 50 * 1024 * 1024;
    this.maxInputTotalBytes = Number(config?.workspaceMaxInputTotalBytes) || 100 * 1024 * 1024;
    this.maxOutputFiles = Number(config?.workspaceMaxOutputFiles) || 20;
    this.maxOutputFileBytes = Number(config?.workspaceMaxOutputFileBytes) || 100 * 1024 * 1024;
    this.maxOutputTotalBytes = Number(config?.workspaceMaxOutputTotalBytes) || 200 * 1024 * 1024;
    this.workspaceLocks = new Map();
    this.pruneScheduled = new Set();
  }

  async withWorkspaceLock(workspace, operation) {
    const key = path.resolve(workspace);
    const previous = this.workspaceLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.workspaceLocks.set(key, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceLocks.get(key) === current) this.workspaceLocks.delete(key);
    }
  }

  schedulePrune(workspace) {
    const key = path.resolve(workspace);
    if (this.pruneScheduled.has(key)) return;
    this.pruneScheduled.add(key);
    setImmediate(() => {
      this.prune(key).catch((err) => this.eventStore?.append("workspace.prune_failed", {
        workspace: key,
        error: tailText(err.message || String(err), 4000),
      }).catch(() => {})).finally(() => this.pruneScheduled.delete(key));
    });
  }

  paths(workspace) {
    const root = path.join(path.resolve(workspace), ".qozyai");
    const history = path.join(root, "history");
    const io = path.join(root, "io");
    return {
      root,
      history,
      active: path.join(history, "active"),
      io,
      inbox: path.join(io, "inbox"),
      outbox: path.join(io, "outbox"),
      historyInbox: path.join(io, "history", "inbox"),
      historyOutbox: path.join(io, "history", "outbox"),
      ioEvents: path.join(io, "history", "events.jsonl"),
    };
  }

  sessionHash(sessionKey) {
    return safeId(sessionKey, 16);
  }

  historyPath(workspace, sessionKey) {
    return path.join(this.paths(workspace).history, `${this.sessionHash(sessionKey)}.jsonl`);
  }

  activePath(workspace, submissionId) {
    return path.join(this.paths(workspace).active, `${safeFilename(submissionId, "turn")}.json`);
  }

  async ensure(workspace) {
    const paths = this.paths(workspace);
    for (const dir of [
      paths.root,
      paths.history,
      paths.active,
      paths.io,
      paths.inbox,
      paths.outbox,
      path.dirname(paths.historyInbox),
      paths.historyInbox,
      paths.historyOutbox,
    ]) {
      const stat = await fs.lstat(dir).catch(() => null);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error(`workspace state path is not a direct directory: ${dir}`);
      }
      if (!stat) {
        try { await fs.mkdir(dir, { mode: 0o700 }); } catch (err) {
          if (err?.code !== "EEXIST") throw err;
          const raced = await fs.lstat(dir);
          if (!raced.isDirectory() || raced.isSymbolicLink()) {
            throw new Error(`workspace state path is not a direct directory: ${dir}`);
          }
        }
      }
    }
    await this.ensureGitExclude(workspace, paths.root);
    return paths;
  }

  async ensureGitExclude(workspace, privateRoot) {
    let worktree = path.resolve(workspace);
    let gitDir = null;
    while (true) {
      const dotGit = path.join(worktree, ".git");
      const stat = await fs.lstat(dotGit).catch(() => null);
      if (stat?.isDirectory()) {
        gitDir = dotGit;
        break;
      }
      if (stat?.isFile()) {
        const text = await fs.readFile(dotGit, "utf8").catch(() => "");
        const match = text.match(/^gitdir:\s*(.+)$/m);
        if (match) gitDir = path.resolve(worktree, match[1].trim());
        break;
      }
      const parent = path.dirname(worktree);
      if (parent === worktree) break;
      worktree = parent;
    }
    if (!gitDir) return;
    const excludePath = path.join(gitDir, "info", "exclude");
    const excludeStat = await fs.lstat(excludePath).catch(() => null);
    if (excludeStat?.isSymbolicLink() || (excludeStat && !excludeStat.isFile())) return;
    const relative = `${path.relative(worktree, privateRoot).replaceAll(path.sep, "/")}/`;
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    if (existing.split(/\r?\n/).includes(relative)) return;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.appendFile(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${relative}\n`, { mode: 0o600 });
  }

  async stageInputs({ workspace, sessionKey, submissionId, inputs = [], acceptedAt }) {
    const descriptors = Array.isArray(inputs) ? inputs : [];
    if (descriptors.length > this.maxInputFiles) throw new Error(`too many input files; maximum is ${this.maxInputFiles}`);
    const paths = await this.ensure(workspace);
    const sessionHash = this.sessionHash(sessionKey);
    const timestamp = timestampForName(acceptedAt);
    const staged = [];
    let totalBytes = 0;

    for (let index = 0; index < descriptors.length; index += 1) {
      const input = descriptors[index] || {};
      const sourcePath = path.resolve(String(input.sourcePath || ""));
      const sourceStat = await fs.lstat(sourcePath).catch(() => null);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) throw new Error(`input is not a direct regular file: ${sourcePath}`);
      if (sourceStat.size > this.maxInputFileBytes) throw new Error(`input file exceeds ${this.maxInputFileBytes} bytes: ${sourcePath}`);
      totalBytes += sourceStat.size;
      if (totalBytes > this.maxInputTotalBytes) throw new Error(`input files exceed ${this.maxInputTotalBytes} total bytes`);
      const ordinal = String(index + 1).padStart(3, "0");
      const originalName = safeFilename(input.name || sourcePath, `input-${ordinal}`);
      const liveName = `${sessionHash}_${ordinal}_${originalName}`;
      const archiveName = `${sessionHash}_${timestamp}_${safeId(submissionId, 8)}_${ordinal}_${originalName}`;
      staged.push({
        ordinal,
        sourcePath,
        originalName,
        mimeType: String(input.mimeType || mimeTypeFor(originalName)),
        size: sourceStat.size,
        liveName,
        livePath: path.join(paths.inbox, liveName),
        temporaryPath: path.join(paths.inbox, `.stage-${safeId(submissionId, 12)}-${ordinal}`),
        archivePath: path.join(paths.historyInbox, archiveName),
        transcript: typeof input.transcript === "string" ? input.transcript : null,
      });
    }

    const created = new Set();
    try {
      for (const item of staged) {
        await fs.copyFile(item.sourcePath, item.archivePath, fs.constants.COPYFILE_EXCL);
        created.add(item.archivePath);
        const archivedStat = await fs.lstat(item.archivePath);
        if (!archivedStat.isFile() || archivedStat.isSymbolicLink() || archivedStat.size !== item.size) {
          throw new Error(`input changed while staging: ${item.sourcePath}`);
        }
        await fs.chmod(item.archivePath, 0o600);
        await fs.copyFile(item.archivePath, item.temporaryPath, fs.constants.COPYFILE_EXCL);
        created.add(item.temporaryPath);
        await fs.chmod(item.temporaryPath, 0o600);
        if (item.transcript !== null) {
          const transcript = tailText(item.transcript, 1024 * 1024);
          item.archiveTranscriptPath = `${item.archivePath}.transcript.txt`;
          item.temporaryTranscriptPath = `${item.temporaryPath}.transcript.txt`;
          item.liveTranscriptPath = `${item.livePath}.transcript.txt`;
          await fs.writeFile(item.archiveTranscriptPath, transcript, { encoding: "utf8", mode: 0o600, flag: "wx" });
          created.add(item.archiveTranscriptPath);
          await fs.writeFile(item.temporaryTranscriptPath, transcript, { encoding: "utf8", mode: 0o600, flag: "wx" });
          created.add(item.temporaryTranscriptPath);
        }
      }

      const current = await fs.readdir(paths.inbox, { withFileTypes: true }).catch(() => []);
      for (const entry of current) {
        if (entry.isFile() && entry.name.startsWith(`${sessionHash}_`)) {
          await fs.unlink(path.join(paths.inbox, entry.name));
        }
      }

      const records = [];
      for (const item of staged) {
        await fs.rename(item.temporaryPath, item.livePath);
        created.delete(item.temporaryPath);
        created.add(item.livePath);
        if (item.temporaryTranscriptPath) {
          await fs.rename(item.temporaryTranscriptPath, item.liveTranscriptPath);
          created.delete(item.temporaryTranscriptPath);
          created.add(item.liveTranscriptPath);
        }
        const record = {
          originalName: item.originalName,
          mimeType: item.mimeType,
          size: item.size,
          path: item.livePath,
          archivePath: item.archivePath,
        };
        if (item.liveTranscriptPath) {
          record.transcriptPath = item.liveTranscriptPath;
          record.transcriptArchivePath = item.archiveTranscriptPath;
        }
        records.push(record);
      }

      for (const record of records) {
        await appendJsonl(paths.ioEvents, {
          version: 1,
          kind: "input.staged",
          at: acceptedAt,
          sessionKey,
          submissionId,
          ...record,
        });
        if (record.transcriptPath) {
          await appendJsonl(paths.ioEvents, {
            version: 1,
            kind: "input.transcript_staged",
            at: acceptedAt,
            sessionKey,
            submissionId,
            path: record.transcriptPath,
            archivePath: record.transcriptArchivePath,
            derivedFrom: record.archivePath,
          });
        }
      }
      return records;
    } catch (err) {
      await Promise.all([...created].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
      throw err;
    }
  }

  promptContext({ workspace, sessionKey, inputs }) {
    const paths = this.paths(workspace);
    const outputPrefix = `${this.sessionHash(sessionKey)}_`;
    const lines = [
      "",
      "<cli-runtime-files>",
      `For files you want returned to the caller, write direct regular files under ${paths.outbox}.`,
      `Prefix each output filename with ${outputPrefix} so this session can identify it safely.`,
    ];
    if (inputs.length > 0) {
      lines.push("Input files for this turn:");
      for (const input of inputs) {
        lines.push(`- ${input.path} (${input.mimeType}, ${input.size} bytes)`);
        if (input.transcriptPath) lines.push(`  transcript: ${input.transcriptPath}`);
      }
    }
    lines.push("</cli-runtime-files>");
    return lines.join("\n");
  }

  async outputSnapshot(workspace, sessionKey) {
    const paths = await this.ensure(workspace);
    const prefix = `${this.sessionHash(sessionKey)}_`;
    const entries = await fs.readdir(paths.outbox, { withFileTypes: true }).catch(() => []);
    const snapshot = {};
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const stat = await fs.lstat(path.join(paths.outbox, entry.name)).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) snapshot[entry.name] = { size: stat.size, mtimeMs: stat.mtimeMs };
    }
    return snapshot;
  }

  async startTurn({ workspace, sessionKey, submissionId, driver, message, inputs = [], acceptedAt }) {
    return this.withWorkspaceLock(workspace, () => this.startTurnLocked({
      workspace,
      sessionKey,
      submissionId,
      driver,
      message,
      inputs,
      acceptedAt,
    }));
  }

  async startTurnLocked({ workspace, sessionKey, submissionId, driver, message, inputs = [], acceptedAt }) {
    const stagedInputs = await this.stageInputs({ workspace, sessionKey, submissionId, inputs, acceptedAt });
    const active = {
      version: 1,
      turnId: submissionId,
      submissionId,
      sessionKey,
      driver,
      status: "accepted",
      inboundAt: acceptedAt,
      startedAt: null,
      completedAt: null,
      user: { text: boundedHistoryText(message), inputs: stagedInputs },
      throughOffset: null,
      reasoning: [],
      tools: [],
      summary: "Accepted.",
      updatedAt: acceptedAt,
    };
    await writeAtomic(this.activePath(workspace, submissionId), active);
    return {
      inputs: stagedInputs,
      outputBaseline: await this.outputSnapshot(workspace, sessionKey),
      promptContext: this.promptContext({ workspace, sessionKey, inputs: stagedInputs }),
    };
  }

  async updateTurn({ workspace, submissionId, progress, status = "running", startedAt = null }) {
    return this.withWorkspaceLock(workspace, () => this.updateTurnLocked({
      workspace,
      submissionId,
      progress,
      status,
      startedAt,
    }));
  }

  async updateTurnLocked({ workspace, submissionId, progress, status = "running", startedAt = null }) {
    const filePath = this.activePath(workspace, submissionId);
    const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    const normalized = normalizeProgress(progress, status);
    const updated = {
      ...existing,
      status,
      startedAt: existing.startedAt || startedAt || nowIso(),
      throughOffset: normalized.throughOffset,
      artifactPath: normalized.artifactPath,
      providerSessionId: normalized.providerSessionId,
      reasoning: normalized.reasoning,
      tools: normalized.tools,
      summary: summarizeProgress(progress, status, normalized),
      updatedAt: nowIso(),
    };
    const before = JSON.stringify({ ...existing, updatedAt: null });
    const after = JSON.stringify({ ...updated, updatedAt: null });
    if (before !== after) await writeAtomic(filePath, updated);
    return updated;
  }

  async collectOutputs({
    workspace,
    sessionKey,
    submissionId,
    completedAt,
    archiveAt = completedAt,
    baseline = {},
    deliveryStatus = "pending",
  }) {
    const paths = await this.ensure(workspace);
    const prefix = `${this.sessionHash(sessionKey)}_`;
    const entries = await fs.readdir(paths.outbox, { withFileTypes: true }).catch(() => []);
    const candidates = [];
    for (const entry of entries.filter((item) => item.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name))) {
      const livePath = path.join(paths.outbox, entry.name);
      const stat = await fs.lstat(livePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`output is not a direct regular file: ${livePath}`);
      const prior = baseline?.[entry.name];
      if (prior && prior.size === stat.size && Math.abs(prior.mtimeMs - stat.mtimeMs) < 1) continue;
      candidates.push({ entry, livePath, stat });
    }
    if (candidates.length > this.maxOutputFiles) throw new Error(`too many output files; maximum is ${this.maxOutputFiles}`);
    let totalBytes = 0;
    for (const { livePath, stat } of candidates) {
      if (stat.size > this.maxOutputFileBytes) throw new Error(`output file exceeds ${this.maxOutputFileBytes} bytes: ${livePath}`);
      totalBytes += stat.size;
      if (totalBytes > this.maxOutputTotalBytes) throw new Error(`output files exceed ${this.maxOutputTotalBytes} total bytes`);
    }
    const outputs = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const { entry, livePath, stat } = candidates[index];
      const originalName = safeFilename(entry.name.slice(prefix.length), `output-${index + 1}`);
      const ordinal = String(index + 1).padStart(3, "0");
      const archiveName = `${this.sessionHash(sessionKey)}_${timestampForName(archiveAt)}_${safeId(submissionId, 8)}_${ordinal}_${originalName}`;
      const archivePath = path.join(paths.historyOutbox, archiveName);
      try {
        await fs.copyFile(livePath, archivePath, fs.constants.COPYFILE_EXCL);
        await fs.chmod(archivePath, 0o600);
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        const archivedStat = await fs.lstat(archivePath).catch(() => null);
        if (!archivedStat?.isFile() || archivedStat.isSymbolicLink() || archivedStat.size !== stat.size) throw err;
      }
      const output = {
        originalName,
        mimeType: mimeTypeFor(originalName),
        size: stat.size,
        path: livePath,
        archivePath,
        signature: { size: stat.size, mtimeMs: stat.mtimeMs },
        deliveryStatus,
        discardedAt: deliveryStatus === "discarded" ? completedAt : null,
      };
      outputs.push(output);
      await appendJsonl(paths.ioEvents, {
        version: 1,
        kind: "output.archived",
        at: completedAt,
        sessionKey,
        submissionId,
        ...output,
      });
      if (deliveryStatus === "discarded") await fs.rm(livePath, { force: true });
    }
    return outputs;
  }

  async finishTurn({ workspace, sessionKey, submission, driver, progress }) {
    return this.withWorkspaceLock(workspace, () => this.finishTurnLocked({
      workspace,
      sessionKey,
      submission,
      driver,
      progress,
    }));
  }

  async finishTurnLocked({ workspace, sessionKey, submission, driver, progress }) {
    const historyPath = this.historyPath(workspace, sessionKey);
    const existing = (await readJsonl(historyPath)).find((record) => record.submissionId === submission.submissionId);
    if (existing) {
      await fs.rm(this.activePath(workspace, submission.submissionId), { force: true });
      this.schedulePrune(workspace);
      return {
        outputs: Array.isArray(existing.outputs) ? existing.outputs : [],
        outputError: existing.outputError || null,
        record: existing,
        reused: true,
      };
    }

    const completedAt = submission.completedAt || nowIso();
    let outputs = [];
    let outputError = null;
    try {
      outputs = await this.collectOutputs({
        workspace,
        sessionKey,
        submissionId: submission.submissionId,
        completedAt,
        archiveAt: submission.acceptedAt || completedAt,
        baseline: submission.outputBaseline,
        deliveryStatus: submission.status === "completed" ? "pending" : "discarded",
      });
    } catch (err) {
      outputError = tailText(err.message || String(err), 4000);
    }
    const normalized = normalizeProgress(progress, submission.status);
    const record = {
      version: 1,
      kind: "turn",
      turnId: submission.submissionId,
      submissionId: submission.submissionId,
      sessionKey,
      driver,
      providerSessionId: normalized.providerSessionId,
      status: submission.status,
      inboundAt: submission.acceptedAt,
      startedAt: submission.startedAt || null,
      completedAt,
      user: {
        text: boundedHistoryText(submission.message || ""),
        inputs: Array.isArray(submission.inputs) ? submission.inputs : [],
      },
      reasoning: normalized.reasoning,
      tools: normalized.tools,
      assistant: { text: boundedHistoryText(submission.reply || "") },
      failure: submission.error ? boundedText(submission.error, 20_000) : null,
      outputs,
      outputError,
    };
    await appendJsonl(historyPath, record);
    await fs.rm(this.activePath(workspace, submission.submissionId), { force: true });
    this.schedulePrune(workspace);
    return { outputs, outputError, record, reused: false };
  }

  async acknowledgeOutputs({ workspace, sessionKey, submissionId, outputs }) {
    return this.withWorkspaceLock(workspace, () => this.acknowledgeOutputsLocked({
      workspace,
      sessionKey,
      submissionId,
      outputs,
    }));
  }

  async acknowledgeOutputsLocked({ workspace, sessionKey, submissionId, outputs }) {
    const paths = await this.ensure(workspace);
    const acknowledged = [];
    for (const output of Array.isArray(outputs) ? outputs : []) {
      if (output.deliveryStatus !== "pending") {
        acknowledged.push(output);
        continue;
      }
      const livePath = path.resolve(String(output.path || ""));
      if (!livePath.startsWith(`${paths.outbox}${path.sep}`)) {
        acknowledged.push(output);
        continue;
      }
      const stat = await fs.lstat(livePath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()
        && stat.size === output.signature?.size
        && Math.abs(stat.mtimeMs - Number(output.signature?.mtimeMs)) < 1) {
        await fs.unlink(livePath);
      }
      acknowledged.push({ ...output, deliveryStatus: "delivered", deliveredAt: nowIso() });
      await appendJsonl(paths.ioEvents, {
        version: 1,
        kind: "output.delivered",
        at: nowIso(),
        sessionKey,
        submissionId,
        path: output.path,
        archivePath: output.archivePath,
      });
    }
    return acknowledged;
  }

  async prune(workspace) {
    return this.withWorkspaceLock(workspace, () => this.pruneLocked(workspace));
  }

  async pruneLocked(workspace) {
    const paths = await this.ensure(workspace);
    const entries = await fs.readdir(paths.history, { withFileTypes: true }).catch(() => []);
    const retainedIds = new Set();
    const retainedOutputArchives = new Set();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(paths.history, entry.name);
      const turns = await readJsonl(filePath);
      const retained = selectRecentTurns(turns);
      for (const turn of retained) {
        retainedIds.add(turn.submissionId);
        for (const output of Array.isArray(turn.outputs) ? turn.outputs : []) {
          if (output.archivePath) retainedOutputArchives.add(path.resolve(output.archivePath));
        }
      }
      if (retained.length !== turns.length) {
        await writeTextAtomic(filePath, retained.map((turn) => JSON.stringify(turn)).join("\n") + (retained.length ? "\n" : ""));
      }
    }
    const active = await fs.readdir(paths.active, { withFileTypes: true }).catch(() => []);
    for (const entry of active) if (entry.isFile() && entry.name.endsWith(".json")) retainedIds.add(entry.name.slice(0, -5));

    const ioEvents = await readJsonl(paths.ioEvents);
    const pendingOutputArchives = new Set();
    for (const event of ioEvents) {
      if (event.kind === "output.archived" && event.deliveryStatus === "pending" && event.archivePath) {
        const archivePath = path.resolve(event.archivePath);
        if (retainedOutputArchives.has(archivePath)) pendingOutputArchives.add(archivePath);
      }
      if (event.kind === "output.delivered" && event.archivePath) pendingOutputArchives.delete(path.resolve(event.archivePath));
    }
    const retainedEvents = [];
    const removedArchives = new Set();
    for (const event of ioEvents) {
      const pendingOutput = event.archivePath && pendingOutputArchives.has(path.resolve(event.archivePath));
      if (!event.submissionId || retainedIds.has(event.submissionId) || pendingOutput) retainedEvents.push(event);
      else if (event.archivePath) removedArchives.add(path.resolve(event.archivePath));
      if (!retainedIds.has(event.submissionId) && event.transcriptArchivePath) {
        removedArchives.add(path.resolve(event.transcriptArchivePath));
      }
    }
    const archiveRoots = [paths.historyInbox, paths.historyOutbox];
    for (const filePath of removedArchives) {
      if (archiveRoots.some((root) => filePath.startsWith(`${root}${path.sep}`))) await fs.rm(filePath, { force: true });
    }
    if (retainedEvents.length !== ioEvents.length) {
      await writeTextAtomic(paths.ioEvents, retainedEvents.map((event) => JSON.stringify(event)).join("\n") + (retainedEvents.length ? "\n" : ""));
    }

    const referencedArchives = new Set();
    for (const event of retainedEvents) {
      if (event.archivePath) referencedArchives.add(path.resolve(event.archivePath));
      if (event.transcriptArchivePath) referencedArchives.add(path.resolve(event.transcriptArchivePath));
    }
    for (const root of archiveRoots) {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.resolve(root, entry.name);
        if (!referencedArchives.has(filePath)) await fs.rm(filePath, { force: true });
      }
    }
  }
}

module.exports = {
  BREAK_MS,
  MAX_STATUS_CHARS,
  WORK_WINDOW_MS,
  WorkspaceState,
  boundedText,
  mimeTypeFor,
  normalizeProgress,
  redactText,
  safeFilename,
  selectRecentTurns,
  summarizeProgress,
};
