"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  SUBMISSION_SOURCE_OWNER,
  appendJsonl,
  normalizeSubmissionSource,
  nowIso,
  readJson,
  safeId,
  tailText,
  writeAtomic,
} = require("./util");
const {
  MAX_STATUS_CHARS,
  boundedHistoryText,
  boundedText,
  mimeTypeFor,
  normalizeHistoryProgress,
  normalizeProgress,
  redactText,
  safeFilename,
  summarizeProgress,
} = require("./progress");

const BREAK_MS = 6 * 60 * 60 * 1000;
const WORK_WINDOW_MS = 48 * 60 * 60 * 1000;
// Spec 0018. The two absolute age floors that used to live here are gone. The runtime
// deletes by meaning — which records are still referenced, which turn is live, which
// history belongs to the last window of work. How long a voice note is worth keeping is
// a preference, and it is now a marker file read by `plugins/retention-sweep`.

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function turnDirName(submissionId) {
  const value = String(submissionId || "");
  return /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? value : safeId(value, 40);
}

function historyUserText(message, inputDescriptors = []) {
  const parts = [String(message || "").trim()].filter(Boolean);
  for (const input of inputDescriptors) {
    if (typeof input?.transcript === "string" && input.transcript.trim()) {
      parts.push(`Automated voice transcript (may contain recognition errors):\n${input.transcript.trim()}`);
    }
  }
  return parts.join("\n\n");
}


function buildWorkClusters(turns) {
  const clusters = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
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

// The start of the oldest cluster still inside the 48-hour budget, or null when
// there is nothing to measure.
function windowBoundary(clusters) {
  let accumulatedMs = 0;
  let boundaryMs = null;
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    const cluster = clusters[index];
    boundaryMs = cluster.startAtMs;
    accumulatedMs += Math.max(0, cluster.endAtMs - cluster.startAtMs);
    if (accumulatedMs >= WORK_WINDOW_MS) break;
  }
  return boundaryMs;
}

function earlierBoundary(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function selectRecentTurns(turns) {
  const valid = turns.filter((turn) => turn && typeof turn === "object"
    && parseTime(turn.inboundAt) !== null && parseTime(turn.completedAt) !== null);
  // The window measures how long a person worked here. A scheduled turn is the
  // machine checking in on itself, and counting it corrupts the measurement twice:
  // it spends budget nothing asked for, and — because any interval under six hours
  // stops a break from ever forming — it can fuse a session into one endless
  // cluster that the rule can no longer trim.
  const owner = valid.filter((turn) => normalizeSubmissionSource(turn.source) === SUBMISSION_SOURCE_OWNER);
  // A session that is only ever woken has no owner turns at all. Measuring it
  // against nothing would retain nothing, so it keeps the original behaviour.
  // Measured two ways and the more generous answer wins. Owner-only measurement is
  // the point of the rule, but on its own it would delete every scheduled turn that
  // preceded a session's first owner turn — an autonomous session losing its whole
  // history the moment somebody speaks to it. Counting everything can only ever
  // spend the budget faster, so the earlier of the two boundaries is always safe.
  const boundaryMs = earlierBoundary(
    windowBoundary(buildWorkClusters(owner)),
    windowBoundary(buildWorkClusters(valid)),
  );
  // Everything from the oldest retained cluster onward is kept, whatever asked for
  // it. Scheduled turns are still history; they simply no longer decide where the
  // boundary falls. Records that cannot be classified are retained rather than
  // treated as old.
  return turns.filter((turn) => {
    if (!turn || typeof turn !== "object") return true;
    const startedAtMs = parseTime(turn.inboundAt);
    if (startedAtMs === null || parseTime(turn.completedAt) === null) return true;
    return boundaryMs === null || startedAtMs >= boundaryMs;
  });
}

async function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function readJsonlLossless(filePath) {
  let text;
  try { text = await fs.readFile(filePath, "utf8"); } catch (err) {
    if (err?.code === "ENOENT") return { records: [], errors: [], text: "" };
    throw err;
  }
  const records = [];
  const errors = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {
      errors.push({ line: index + 1, text: tailText(line, 1000), raw: line });
    }
  }
  return { records, errors, text };
}

async function quarantineMalformedJsonl(filePath, parsed) {
  if (!parsed.errors.length) return null;
  const quarantine = `${filePath}.corrupt-${Date.now()}`;
  await fs.writeFile(quarantine, `${parsed.errors.map((error) => error.raw).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  await writeTextAtomic(filePath, parsed.records.map((record) => JSON.stringify(record)).join("\n") + (parsed.records.length ? "\n" : ""));
  return quarantine;
}

async function repairTrailingJsonl(filePath) {
  let bytes;
  try { bytes = await fs.readFile(filePath); } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return null;
  const lastNewline = bytes.lastIndexOf(0x0a);
  const tail = bytes.subarray(lastNewline + 1);
  try {
    JSON.parse(tail.toString("utf8"));
    await fs.appendFile(filePath, "\n");
    return null;
  } catch {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    await fs.writeFile(quarantine, tail, { mode: 0o600, flag: "wx" });
    await fs.truncate(filePath, lastNewline < 0 ? 0 : lastNewline + 1);
    return quarantine;
  }
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
    this.pruneScheduled = new Map();
    this.initializedWorkspaces = new Set();
  }

  async withWorkspaceLock(workspace, operation) {
    const key = path.resolve(workspace);
    const previous = this.workspaceLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.workspaceLocks.set(key, current);
    await previous.catch(() => {});
    try { return await operation(); } finally {
      release();
      if (this.workspaceLocks.get(key) === current) this.workspaceLocks.delete(key);
    }
  }

  schedulePrune(workspace) {
    const key = path.resolve(workspace);
    const existing = this.pruneScheduled.get(key);
    if (existing) return existing;
    let resolveJob;
    const job = new Promise((resolve) => { resolveJob = resolve; });
    this.pruneScheduled.set(key, job);
    const timer = setTimeout(async () => {
      try {
        await this.prune(key);
      } catch (err) {
        await this.eventStore?.append("workspace.prune_failed", {
          workspace: key,
          error: tailText(err.message || String(err), 4000),
        }).catch(() => {});
      } finally {
        if (this.pruneScheduled.get(key) === job) this.pruneScheduled.delete(key);
        resolveJob();
      }
    }, 25);
    timer.unref();
    return job;
  }

  async waitForPrunes() {
    while (this.pruneScheduled.size > 0) {
      await Promise.all([...this.pruneScheduled.values()]);
    }
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

  turnPaths(workspace, submissionId) {
    const base = this.paths(workspace);
    const id = turnDirName(submissionId);
    return {
      ...base,
      turnId: id,
      turnInbox: path.join(base.inbox, id),
      turnOutbox: path.join(base.outbox, id),
      turnHistoryInbox: path.join(base.historyInbox, id),
      turnHistoryOutbox: path.join(base.historyOutbox, id),
    };
  }

  sessionHash(sessionKey) {
    return safeId(sessionKey, 16);
  }

  historyPath(workspace, sessionKey) {
    return path.join(this.paths(workspace).history, `${this.sessionHash(sessionKey)}.jsonl`);
  }

  activePath(workspace, submissionId) {
    return path.join(this.paths(workspace).active, `${turnDirName(submissionId)}.json`);
  }

  async ensure(workspace) {
    const key = path.resolve(workspace);
    const paths = this.paths(workspace);
    const workspaceStat = await fs.lstat(key).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
      const error = new Error(`workspace is missing or is not a direct directory: ${key}`);
      error.code = "WORKSPACE_MISSING";
      throw error;
    }
    for (const dir of [
      paths.root, paths.history, paths.active, paths.io, paths.inbox, paths.outbox,
      path.dirname(paths.historyInbox), paths.historyInbox, paths.historyOutbox,
    ]) {
      const stat = await fs.lstat(dir).catch(() => null);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`workspace state path is not a direct directory: ${dir}`);
      if (!stat) await fs.mkdir(dir, { mode: 0o700 });
    }
    if (!this.initializedWorkspaces.has(key)) {
      await this.ensureGitExclude(workspace, paths.root);
      this.initializedWorkspaces.add(key);
    }
    return paths;
  }

  async ensureGitExclude(workspace, privateRoot) {
    let worktree = path.resolve(workspace);
    let gitDir = null;
    while (true) {
      const dotGit = path.join(worktree, ".git");
      const stat = await fs.lstat(dotGit).catch(() => null);
      if (stat?.isDirectory()) { gitDir = dotGit; break; }
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
    const relative = `${path.relative(worktree, privateRoot).replaceAll(path.sep, "/")}/`;
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    if (existing.split(/\r?\n/).includes(relative)) return;
    await fs.mkdir(path.dirname(excludePath), { mode: 0o700 }).catch((err) => {
      if (err?.code !== "EEXIST") throw err;
    });
    await fs.appendFile(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${relative}\n`, { mode: 0o600 });
  }

  async stageInputs({ workspace, sessionKey, submissionId, inputs = [], acceptedAt, signal = null }) {
    const descriptors = Array.isArray(inputs) ? inputs : [];
    if (descriptors.length > this.maxInputFiles) throw new Error(`too many input files; maximum is ${this.maxInputFiles}`);
    await this.ensure(workspace);
    const paths = this.turnPaths(workspace, submissionId);
    const prepared = [];
    let totalBytes = 0;
    for (let index = 0; index < descriptors.length; index += 1) {
      if (signal?.aborted) throw Object.assign(new Error("submission interrupted"), { code: "SUBMISSION_INTERRUPTED" });
      const input = descriptors[index] || {};
      const sourcePath = path.resolve(String(input.sourcePath || ""));
      const stat = await fs.lstat(sourcePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`input is not a direct regular file: ${sourcePath}`);
      if (stat.size > this.maxInputFileBytes) throw new Error(`input file exceeds ${this.maxInputFileBytes} bytes: ${sourcePath}`);
      totalBytes += stat.size;
      if (totalBytes > this.maxInputTotalBytes) throw new Error(`input files exceed ${this.maxInputTotalBytes} total bytes`);
      const ordinal = String(index + 1).padStart(3, "0");
      const originalName = safeFilename(input.name || sourcePath, `input-${ordinal}`);
      prepared.push({
        sourcePath,
        originalName,
        fileName: `${ordinal}_${originalName}`,
        mimeType: String(input.mimeType || mimeTypeFor(originalName)),
        size: stat.size,
        transcript: typeof input.transcript === "string" ? input.transcript : null,
        transcriptionError: typeof input.transcriptionError === "string" ? tailText(input.transcriptionError, 2000) : null,
      });
    }

    const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const tempInbox = `${paths.turnInbox}.stage-${nonce}`;
    const tempArchive = `${paths.turnHistoryInbox}.stage-${nonce}`;
    try {
      await fs.mkdir(tempInbox, { mode: 0o700 });
      await fs.mkdir(tempArchive, { mode: 0o700 });
      for (const item of prepared) {
        if (signal?.aborted) throw Object.assign(new Error("submission interrupted"), { code: "SUBMISSION_INTERRUPTED" });
        for (const target of [path.join(tempInbox, item.fileName), path.join(tempArchive, item.fileName)]) {
          await fs.copyFile(item.sourcePath, target, fs.constants.COPYFILE_EXCL);
          await fs.chmod(target, 0o600);
        }
        if (item.transcript !== null) {
          const transcript = tailText(item.transcript, 1024 * 1024);
          await fs.writeFile(path.join(tempInbox, `${item.fileName}.transcript.txt`), transcript, { mode: 0o600, flag: "wx" });
          await fs.writeFile(path.join(tempArchive, `${item.fileName}.transcript.txt`), transcript, { mode: 0o600, flag: "wx" });
        }
      }
      await fs.rename(tempInbox, paths.turnInbox);
      await fs.rename(tempArchive, paths.turnHistoryInbox);
      if (signal?.aborted) throw Object.assign(new Error("submission interrupted"), { code: "SUBMISSION_INTERRUPTED" });
      await fs.mkdir(paths.turnOutbox, { mode: 0o700 });
    } catch (err) {
      await Promise.all([tempInbox, tempArchive, paths.turnInbox, paths.turnHistoryInbox, paths.turnOutbox]
        .map((item) => fs.rm(item, { recursive: true, force: true }).catch(() => {})));
      throw err;
    }

    const records = prepared.map((item) => {
      const record = {
        originalName: item.originalName,
        mimeType: item.mimeType,
        size: item.size,
        path: path.join(paths.turnInbox, item.fileName),
        archivePath: path.join(paths.turnHistoryInbox, item.fileName),
      };
      if (item.transcript !== null) {
        record.transcriptPath = `${record.path}.transcript.txt`;
        record.transcriptArchivePath = `${record.archivePath}.transcript.txt`;
      }
      return record;
    });
    for (const record of records) {
      await appendJsonl(paths.ioEvents, { version: 1, kind: "input.staged", at: acceptedAt, sessionKey, submissionId, ...record });
    }
    return records;
  }

  promptContext({ workspace, submissionId, inputs, inputDescriptors = [] }) {
    const paths = this.turnPaths(workspace, submissionId);
    const lines = [
      "",
      "<cli-runtime-files>",
      `For files you want returned to the caller, write direct regular files under ${paths.turnOutbox}.`,
    ];
    if (inputs.length > 0) {
      lines.push("Input files for this turn:");
      for (const [index, input] of inputs.entries()) {
        lines.push(`- ${input.path} (${input.mimeType}, ${input.size} bytes)`);
        if (input.transcriptPath) {
          lines.push(`  transcript: ${input.transcriptPath}`);
          lines.push("  <audio-transcript>");
          lines.push(tailText(inputDescriptors[index]?.transcript || "", 1024 * 1024));
          lines.push("  </audio-transcript>");
        }
        if (inputDescriptors[index]?.transcriptionError) {
          lines.push(`  transcription warning: ${tailText(inputDescriptors[index].transcriptionError, 2000)}`);
        }
      }
    }
    if (inputs.some((input) => input.transcriptPath)) {
      lines.push("The audio transcript is automated and may contain recognition errors. Use the original audio and transcript together to infer the user's intent.");
      lines.push("Begin your final response with `Here is how I understood your prompt:` followed by a concise, corrected interpretation. Then answer the request.");
    }
    lines.push("</cli-runtime-files>");
    return lines.join("\n");
  }

  async startTurn(options) {
    return this.withWorkspaceLock(options.workspace, async () => {
      const inputs = await this.stageInputs(options);
      const active = {
        version: 1,
        kind: "active_turn",
        submissionId: options.submissionId,
        sessionKey: options.sessionKey,
        driver: options.driver,
        status: "accepted",
        inboundAt: options.acceptedAt,
        startedAt: null,
        completedAt: null,
        user: { text: boundedHistoryText(historyUserText(options.message, options.inputs)), inputs },
        throughOffset: null,
        reasoning: [],
        tools: [],
        summary: "Accepted.",
        updatedAt: options.acceptedAt,
      };
      await writeAtomic(this.activePath(options.workspace, options.submissionId), active);
      return {
        inputs,
        outputDir: this.turnPaths(options.workspace, options.submissionId).turnOutbox,
        promptContext: this.promptContext({
          workspace: options.workspace,
          submissionId: options.submissionId,
          inputs,
          inputDescriptors: options.inputs || [],
        }),
      };
    });
  }

  async updateTurn(options) {
    return this.withWorkspaceLock(options.workspace, async () => {
      const filePath = this.activePath(options.workspace, options.submissionId);
      const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
      const normalized = normalizeProgress(options.progress, options.status || "running");
      const updated = {
        ...existing,
        status: options.status || "running",
        startedAt: existing.startedAt || options.startedAt || nowIso(),
        throughOffset: normalized.throughOffset,
        artifactPath: normalized.artifactPath,
        providerSessionId: normalized.providerSessionId,
        reasoning: normalized.reasoning,
        tools: normalized.tools,
        summary: summarizeProgress(options.progress, options.status || "running", normalized),
        updatedAt: nowIso(),
      };
      const before = JSON.stringify({ ...existing, updatedAt: null });
      const after = JSON.stringify({ ...updated, updatedAt: null });
      if (before !== after) await writeAtomic(filePath, updated);
      return updated;
    });
  }

  async collectOutputs({ workspace, sessionKey, submissionId, completedAt, deliveryStatus }) {
    await this.ensure(workspace);
    const paths = this.turnPaths(workspace, submissionId);
    const archived = await fs.lstat(paths.turnHistoryOutbox).catch(() => null);
    let source = paths.turnHistoryOutbox;
    const errors = [];
    if (!archived) {
      const live = await fs.lstat(paths.turnOutbox).catch(() => null);
      if (!live) await fs.mkdir(paths.turnOutbox, { recursive: true, mode: 0o700 });
      else if (!live.isDirectory() || live.isSymbolicLink()) throw new Error(`turn outbox is not a direct directory: ${paths.turnOutbox}`);
      await fs.rename(paths.turnOutbox, paths.turnHistoryOutbox);
    }

    const outputs = [];
    const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const archivePath = path.join(source, entry.name);
      const stat = await fs.lstat(archivePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        errors.push(`output is not a direct regular file: ${archivePath}`);
        continue;
      }
      if (outputs.length >= this.maxOutputFiles) {
        errors.push(`too many output files; maximum is ${this.maxOutputFiles}`);
        continue;
      }
      if (stat.size > this.maxOutputFileBytes) {
        errors.push(`output file exceeds ${this.maxOutputFileBytes} bytes: ${archivePath}`);
        continue;
      }
      if (total + stat.size > this.maxOutputTotalBytes) {
        errors.push(`output files exceed ${this.maxOutputTotalBytes} total bytes`);
        continue;
      }
      await fs.chmod(archivePath, 0o600);
      const output = {
        outputId: safeId(`${submissionId}:${entry.name}`, 24),
        originalName: entry.name,
        mimeType: mimeTypeFor(entry.name),
        size: stat.size,
        path: archivePath,
        archivePath,
        deliveryStatus,
        discardedAt: deliveryStatus === "discarded" ? completedAt : null,
      };
      outputs.push(output);
      total += stat.size;
      await appendJsonl(paths.ioEvents, { version: 1, kind: "output.archived", at: completedAt, sessionKey, submissionId, ...output });
    }
    return { outputs, outputError: errors.length ? tailText(errors.join("\n"), 4000) : null };
  }

  async finishTurn(options) {
    return this.withWorkspaceLock(options.workspace, async () => {
      const historyPath = this.historyPath(options.workspace, options.sessionKey);
      const quarantine = await repairTrailingJsonl(historyPath);
      if (quarantine) {
        await this.eventStore?.append("workspace.history_repaired", {
          workspace: path.resolve(options.workspace),
          historyPath,
          quarantine,
        });
      }
      const history = await readJsonlLossless(historyPath);
      const existing = history.records.find((record) => record && typeof record === "object"
        && record.submissionId === options.submission.submissionId);
      if (existing) {
        await fs.rm(this.activePath(options.workspace, options.submission.submissionId), { force: true });
        this.schedulePrune(options.workspace);
        return { outputs: existing.outputs || [], outputError: existing.outputError || null, record: existing, reused: true };
      }

      const completedAt = options.submission.completedAt || nowIso();
      let collected = { outputs: [], outputError: null };
      try {
        collected = await this.collectOutputs({
          workspace: options.workspace,
          sessionKey: options.sessionKey,
          submissionId: options.submission.submissionId,
          completedAt,
          deliveryStatus: options.submission.status === "completed" ? "pending" : "discarded",
        });
      } catch (err) {
        collected.outputError = tailText(err.message || String(err), 4000);
      }
      const normalized = normalizeProgress(options.progress, options.submission.status);
      // History keeps the full tool sequence; the reduced progress shape is only a
      // fallback for callers that never captured a durable snapshot.
      const durable = options.historyProgress
        ? normalizeHistoryProgress(options.historyProgress, options.submission.status)
        : normalized;
      const activeTurn = await readJson(this.activePath(options.workspace, options.submission.submissionId), null);
      const record = {
        version: 1,
        kind: "turn",
        turnId: options.submission.submissionId,
        submissionId: options.submission.submissionId,
        sessionKey: options.sessionKey,
        driver: options.driver,
        source: normalizeSubmissionSource(options.submission.source),
        providerSessionId: normalized.providerSessionId,
        status: options.submission.status,
        inboundAt: options.submission.acceptedAt,
        startedAt: options.submission.startedAt || null,
        completedAt,
        user: {
          text: boundedHistoryText(activeTurn?.user?.text || options.submission.message || ""),
          inputs: options.submission.inputs || [],
        },
        reasoning: durable.reasoning,
        tools: durable.tools,
        // Counts are exact and uncapped, so a sequence trimmed by MAX_HISTORY_TOOL_USES
        // announces itself instead of looking complete.
        toolCounts: durable.toolCounts,
        assistant: { text: boundedHistoryText(options.submission.reply || "") },
        failure: options.submission.error ? boundedText(options.submission.error, 20_000) : null,
        outputs: collected.outputs,
        outputError: collected.outputError,
      };
      await appendJsonl(historyPath, record);
      await fs.rm(this.activePath(options.workspace, options.submission.submissionId), { force: true });
      await fs.rm(this.turnPaths(options.workspace, options.submission.submissionId).turnInbox, { recursive: true, force: true });
      this.schedulePrune(options.workspace);
      return { ...collected, record, reused: false };
    });
  }

  async acknowledgeOutputs({ workspace, sessionKey, submissionId, outputs, outputIds = null }) {
    return this.withWorkspaceLock(workspace, async () => {
      const selected = outputIds ? new Set(outputIds) : null;
      const deliveredAt = nowIso();
      const updated = (outputs || []).map((output) => {
        if (output.deliveryStatus !== "pending" || (selected && !selected.has(output.outputId))) return output;
        return { ...output, deliveryStatus: "delivered", deliveredAt };
      });
      const paths = this.paths(workspace);
      for (const output of updated) {
        if (output.deliveredAt !== deliveredAt) continue;
        await appendJsonl(paths.ioEvents, {
          version: 1,
          kind: "output.delivered",
          at: deliveredAt,
          sessionKey,
          submissionId,
          outputId: output.outputId,
          archivePath: output.archivePath,
        });
      }
      return updated;
    });
  }

  // The outer floor. Everything under .qozyai is state derived from conversations
  // that ended long ago; past this age it is kept by nothing but inertia. Files go
  // first, then any submission directory left empty by the sweep. Structural
  // directories are left alone — ensure() recreates them, but removing them here
  // would race a turn that is mid-flight.

  async prune(workspace) {
    return this.withWorkspaceLock(workspace, async () => {
      const paths = this.paths(workspace);
      const rootStat = await fs.lstat(paths.root).catch((err) => {
        if (err?.code === "ENOENT") return null;
        throw err;
      });
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return;
      const entries = await fs.readdir(paths.history, { withFileTypes: true }).catch(() => []);
      const ioEvents = await readJsonlLossless(paths.ioEvents);
      const pendingOutputs = new Map();
      if (ioEvents.errors.length === 0) {
        for (const record of ioEvents.records) {
          if (!record || typeof record !== "object") continue;
          if (record.kind === "output.archived" && record.deliveryStatus === "pending" && record.outputId) {
            pendingOutputs.set(record.outputId, record.submissionId);
          }
          if (record.kind === "output.delivered" && record.outputId) pendingOutputs.delete(record.outputId);
        }
      }
      const retainedIds = new Set([...pendingOutputs.values()].filter(Boolean));
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const filePath = path.join(paths.history, entry.name);
        const parsed = await readJsonlLossless(filePath);
        if (parsed.errors.length > 0) {
          const quarantine = await quarantineMalformedJsonl(filePath, parsed);
          await this.eventStore?.append("workspace.history_quarantined", {
            workspace: path.resolve(workspace),
            historyPath: filePath,
            quarantine,
            lines: parsed.errors.map((item) => item.line),
          });
        }
        const recent = new Set(selectRecentTurns(parsed.records));
        const retained = parsed.records.filter((record) => recent.has(record)
          || (record && typeof record === "object" && retainedIds.has(record.submissionId)));
        for (const record of retained) if (record && typeof record === "object" && record.submissionId) retainedIds.add(record.submissionId);
        if (retained.length !== parsed.records.length) {
          await writeTextAtomic(filePath, retained.map((record) => JSON.stringify(record)).join("\n") + (retained.length ? "\n" : ""));
        }
      }
      const active = await fs.readdir(paths.active, { withFileTypes: true }).catch(() => []);
      for (const entry of active) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const activePath = path.join(paths.active, entry.name);
        const stat = await fs.stat(activePath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          await fs.rm(activePath, { force: true });
          continue;
        }
        retainedIds.add(entry.name.slice(0, -5));
      }
      if (ioEvents.errors.length > 0) {
        const quarantine = await quarantineMalformedJsonl(paths.ioEvents, ioEvents);
        await this.eventStore?.append("workspace.io_history_quarantined", {
          workspace: path.resolve(workspace),
          historyPath: paths.ioEvents,
          quarantine,
          lines: ioEvents.errors.map((item) => item.line),
        });
      }
      const retainedEvents = ioEvents.records.filter((record) => !record.submissionId || retainedIds.has(record.submissionId));
      if (retainedEvents.length !== ioEvents.records.length) {
        await writeTextAtomic(paths.ioEvents, retainedEvents.map((record) => JSON.stringify(record)).join("\n") + (retainedEvents.length ? "\n" : ""));
      }
      const nowMs = Date.now();
      // Spec 0018. Retention decides this, and only retention: a directory goes when
      // nothing references it any more. Age is not consulted — an archived output is
      // kept for as long as it is still referenced, however old, and expired by
      // `retention-sweep` afterwards, however recent.
      for (const root of [paths.inbox, paths.outbox, paths.historyInbox, paths.historyOutbox]) {
        const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const dir of dirs) {
          const entryPath = path.join(root, dir.name);
          if (dir.isDirectory()) {
            if (!retainedIds.has(dir.name)) await fs.rm(entryPath, { recursive: true, force: true });
            continue;
          }
          // Liveness, not retention: a loose file in a staging root belongs to a turn
          // that never finished claiming it.
          const stat = await fs.stat(entryPath).catch(() => null);
          if (stat && nowMs - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) await fs.rm(entryPath, { force: true });
        }
      }
    });
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
  readJsonlLossless,
  redactText,
  repairTrailingJsonl,
  safeFilename,
  selectRecentTurns,
  summarizeProgress,
};
