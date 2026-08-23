"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { nowIso, readJson, writeAtomic } = require("../core/util");

const NOTICE_KINDS = new Set(["shutdown", "startup", "info"]);
const MAX_NOTICE_TEXT = 8000;

// Operational state, not user data: a torn file here is dropped and logged rather
// than quarantined, because the message it held is already stale.
async function readJsonSafe(filePath) {
  try { return { value: await readJson(filePath, null), readable: true }; } catch { return { value: null, readable: false }; }
}

// The running entry point lives in the active release directory, so the release
// identity is already on disk; nothing needs to configure it.
function releaseIdFromPath(entryPath) {
  const match = String(entryPath || "").match(/release_[A-Za-z0-9_.-]+/);
  return match ? match[0] : null;
}

function normalizeRoute(route) {
  if (!route || typeof route !== "object") return null;
  const chatId = String(route.chatId ?? "").trim();
  if (!/^-?\d+$/.test(chatId)) return null;
  const rawThread = route.threadId;
  if (rawThread === undefined || rawThread === null || rawThread === "") return { chatId, threadId: null };
  const threadId = Number(rawThread);
  return Number.isInteger(threadId) && threadId > 0 ? { chatId, threadId } : { chatId, threadId: null };
}

function normalizeNotice(record) {
  if (!record || typeof record !== "object") return null;
  if (Number(record.version) !== 1) return null;
  const kind = String(record.kind || "info");
  if (!NOTICE_KINDS.has(kind)) return null;
  const text = String(record.text || "").trim();
  if (!text) return null;
  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : null;
  if (record.expiresAt && !Number.isFinite(expiresAt)) return null;
  return { kind, text: text.slice(0, MAX_NOTICE_TEXT), route: normalizeRoute(record.route), expiresAt };
}

// One-shot operational messages handed to the adapter by whoever restarts it.
class NoticeSpool {
  constructor({ dir, log = console.error } = {}) {
    this.dir = dir;
    this.log = log;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async write(notice) {
    const record = { version: 1, at: nowIso(), ...notice };
    if (!normalizeNotice(record)) throw new Error("invalid notice");
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
    await writeAtomic(path.join(this.dir, name), record);
    return name;
  }

  // Deleting before sending makes delivery at-most-once: a notice lost to a crash
  // is quieter than a stop announcement arriving after the restart it described.
  async drain(now = Date.now()) {
    const names = (await fs.readdir(this.dir).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const ready = [];
    for (const name of names) {
      const filePath = path.join(this.dir, name);
      const { value: record } = await readJsonSafe(filePath);
      await fs.rm(filePath, { force: true });
      const notice = normalizeNotice(record);
      if (!notice) {
        this.log(`[telegram] discarded unreadable notice ${name}`);
        continue;
      }
      if (notice.expiresAt !== null && now > notice.expiresAt) {
        this.log(`[telegram] discarded expired ${notice.kind} notice ${name}`);
        continue;
      }
      ready.push(notice);
    }
    return ready;
  }
}

// Survives the process it describes, which is the only way to notice that the
// previous run died instead of stopping.
class RunMarker {
  constructor({ filePath, log = console.error } = {}) {
    this.filePath = filePath;
    this.log = log;
  }

  async start({ release = null, windowMs = 300_000, now = Date.now() } = {}) {
    const { value: previous, readable } = await readJsonSafe(this.filePath);
    const valid = previous && Number(previous.version) === 1 && typeof previous.startedAt === "string";
    if (!readable || (previous && !valid)) this.log("[telegram] replacing an unreadable run marker");
    const unexpected = Boolean(valid && previous.stoppedCleanly !== true);
    const lastAnnouncedAt = valid && typeof previous.lastAnnouncedAt === "string" ? previous.lastAnnouncedAt : null;
    const announcedAgo = lastAnnouncedAt ? now - Date.parse(lastAnnouncedAt) : Infinity;
    const announce = unexpected && !(Number.isFinite(announcedAgo) && announcedAgo < windowMs);
    const suppressed = valid && previous.suppressed ? previous.suppressed : { count: 0, since: null };
    const nextSuppressed = announce ? { count: 0, since: null }
      : unexpected ? { count: Number(suppressed.count || 0) + 1, since: suppressed.since || new Date(now).toISOString() }
        : { count: Number(suppressed.count || 0), since: suppressed.since || null };
    await writeAtomic(this.filePath, {
      version: 1,
      startedAt: new Date(now).toISOString(),
      pid: process.pid,
      release,
      stoppedCleanly: false,
      lastAnnouncedAt: announce ? new Date(now).toISOString() : lastAnnouncedAt,
      suppressed: nextSuppressed,
    });
    return {
      unexpected,
      announce,
      release,
      previousStartedAt: valid ? previous.startedAt : null,
      previousRelease: valid ? previous.release || null : null,
      suppressedCount: Number(suppressed.count || 0),
      suppressedSince: suppressed.since || null,
    };
  }

  async markCleanStop() {
    const current = await readJson(this.filePath, null);
    if (!current) return;
    await writeAtomic(this.filePath, { ...current, stoppedCleanly: true, stoppedAt: nowIso() });
  }
}

function restartAnnouncement(marker) {
  const lines = [`The runtime restarted unexpectedly; the previous run did not stop cleanly.`];
  if (marker.previousStartedAt) lines.push(`Previous run started ${marker.previousStartedAt}.`);
  if (marker.release) lines.push(`Now running ${marker.release}.`);
  if (marker.suppressedCount > 0) {
    lines.push(`${marker.suppressedCount} further restart${marker.suppressedCount === 1 ? "" : "s"} were not reported${marker.suppressedSince ? ` since ${marker.suppressedSince}` : ""}.`);
  }
  return lines.join("\n");
}

module.exports = { NoticeSpool, RunMarker, releaseIdFromPath, restartAnnouncement };
