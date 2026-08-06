"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sleepWithSignal } = require("./util");
const { createArtifactParser, replayArtifact } = require("./artifact-parser");
const { normalizeProgress, summarizeProgress } = require("./progress");

const MAX_INCREMENT_BYTES = 8 * 1024 * 1024;

async function listJsonlFiles(rootDir) {
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files;
}

async function baselineArtifacts(rootDir) {
  const offsets = new Map();
  for (const filePath of await listJsonlFiles(rootDir)) {
    try { offsets.set(filePath, (await fs.stat(filePath)).size); } catch {}
  }
  return offsets;
}

function providerSessionIdFromPath(filePath) {
  const name = path.basename(String(filePath || ""));
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return match ? match[1] : null;
}

function absoluteTimeout(timeoutMs) {
  return Object.assign(new Error(`driver artifacts did not complete within ${timeoutMs}ms`), {
    code: "SUBMISSION_ABSOLUTE_TIMEOUT",
    reason: "absolute_timeout",
  });
}

function inactivityTimeout(inactivityMs, lastActivityAt) {
  return Object.assign(new Error(`driver produced no artifact activity for ${inactivityMs}ms`), {
    code: "SUBMISSION_INACTIVITY_TIMEOUT",
    reason: "inactivity_timeout",
    lastActivityAt,
  });
}

async function watchArtifacts({
  driver,
  rootDir,
  baseline,
  marker,
  timeoutMs,
  inactivityMs = 0,
  pollMs,
  signal,
  onBound,
  onProgress,
  onActivity,
  maxIncrementBytes = MAX_INCREMENT_BYTES,
}) {
  const offsets = new Map(baseline || []);
  const remainders = new Map();
  const parser = createArtifactParser({ driver, marker });
  let boundFile = null;
  let lastProgressJson = "";
  // An absolute limit is opt-in. Silence, not age, ends a healthy turn.
  const absoluteLimit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  const inactivityLimit = Number(inactivityMs) > 0 ? Number(inactivityMs) : 0;
  const deadline = absoluteLimit ? Date.now() + absoluteLimit : Infinity;
  let lastActivityAt = Date.now();
  const inactivityDeadline = () => (inactivityLimit ? lastActivityAt + inactivityLimit : Infinity);
  const expired = () => {
    const now = Date.now();
    if (now >= deadline) return absoluteTimeout(absoluteLimit);
    if (now >= inactivityDeadline()) return inactivityTimeout(inactivityLimit, lastActivityAt);
    return null;
  };
  // Only a new record on this turn's bound artifact proves the provider is working.
  const noteActivity = () => {
    lastActivityAt = Date.now();
    onActivity?.(lastActivityAt);
  };

  for (;;) {
    const expiry = expired();
    if (expiry) throw expiry;
    if (signal?.aborted) throw new Error("submission interrupted");
    const files = boundFile ? [boundFile] : await listJsonlFiles(rootDir);
    for (const filePath of files) {
      if (boundFile && filePath !== boundFile) continue;
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      let offset = offsets.has(filePath) ? offsets.get(filePath) : 0;
      if (stat.size < offset) {
        offset = 0;
        remainders.delete(filePath);
      }
      if (stat.size === offset) continue;
      const handle = await fs.open(filePath, "r");
      try {
        while (offset < stat.size) {
          if (signal?.aborted) throw new Error("submission interrupted");
          const readExpiry = expired();
          if (readExpiry) throw readExpiry;
          const length = Math.min(stat.size - offset, maxIncrementBytes);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          offsets.set(filePath, offset);
          const combined = Buffer.concat([
            remainders.get(filePath) || Buffer.alloc(0),
            buffer.subarray(0, bytesRead),
          ]);
          const lines = [];
          let start = 0;
          for (let index = 0; index < combined.length; index += 1) {
            if (combined[index] !== 0x0a) continue;
            lines.push(combined.subarray(start, index));
            start = index + 1;
          }
          remainders.set(filePath, combined.subarray(start));
          for (const lineBuffer of lines) {
            const line = lineBuffer.toString("utf8").replace(/\r$/, "");
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            const parsed = parser.feed(entry);
            if (parser.state.bound && !boundFile) {
              boundFile = filePath;
              if (!parser.state.providerSessionId) parser.state.providerSessionId = providerSessionIdFromPath(filePath);
              await onBound?.({
                artifactPath: filePath,
                providerSessionId: parser.state.providerSessionId,
              });
            }
            if (boundFile === filePath) noteActivity();
            if (!parsed) continue;
            const result = { ...parsed, throughOffset: offset };
            const progressJson = JSON.stringify(result);
            if (!result.terminal && progressJson !== lastProgressJson) {
              lastProgressJson = progressJson;
              await onProgress?.({ ...result, artifactPath: filePath });
            }
            if (result.terminal) return { ...result, artifactPath: filePath };
          }
        }
      } finally {
        await handle.close();
      }
    }
    await sleepWithSignal(pollMs, signal);
  }
}

function publicProgress(progress, status = "running") {
  if (!progress) return null;
  const normalized = normalizeProgress(progress, status);
  return {
    providerSessionId: normalized.providerSessionId,
    lastAssistantMessage: normalized.lastAssistantMessage,
    lastError: normalized.lastError,
    reasoning: normalized.reasoning,
    toolUses: normalized.tools.map((tool) => ({ ...tool })),
    toolCounts: { ...normalized.toolCounts },
    summary: summarizeProgress(progress, status, normalized),
    artifactPath: normalized.artifactPath,
    throughOffset: normalized.throughOffset,
  };
}

module.exports = {
  baselineArtifacts,
  createArtifactParser,
  listJsonlFiles,
  publicProgress,
  replayArtifact,
  watchArtifacts,
};
