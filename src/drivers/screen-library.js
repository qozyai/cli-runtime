"use strict";

const fs = require("node:fs/promises");
const { appendJsonl, nowIso, tailText } = require("../core/util");
const { recentScreen } = require("./drivers");

const MAX_PATTERN_CHARS = 200;
const MAX_ENTRIES = 500;
const MATCH_WINDOW_LINES = 60;

// A pattern the model supplies is stored and executed, so it earns its place:
// it must compile, stay short, and must not match the empty string, which
// would make it match every screen. Spec 0022.
function compilePattern(pattern) {
  const value = String(pattern || "");
  if (value.length < 3 || value.length > MAX_PATTERN_CHARS) return null;
  let regex;
  try {
    regex = new RegExp(value, "i");
  } catch {
    return null;
  }
  return regex.test("") ? null : regex;
}

function validEntry(record) {
  if (!record || typeof record !== "object" || record.version !== 1) return null;
  const driver = String(record.driver || "");
  const regex = compilePattern(record.pattern);
  const action = record.action;
  if (!driver || !regex || !action || typeof action !== "object") return null;
  if (!["wait", "press_key", "submit_text"].includes(action.action)) return null;
  return { driver, pattern: String(record.pattern), regex, action, reason: record.reason || null };
}

// Screens the intelligence layer was asked about once and taught the runtime
// to recognize. Lessons are committed only by a successful attempt; a wrong
// answer would have to carry a real authentication to be remembered.
class ScreenLibrary {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.entries = null;
    this.pending = new Map();
  }

  async load() {
    if (this.entries) return this.entries;
    this.entries = [];
    let text = "";
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      return this.entries;
    }
    for (const line of text.split("\n")) {
      if (!line.trim() || this.entries.length >= MAX_ENTRIES) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = validEntry(record);
      if (entry) this.entries.push(entry);
    }
    return this.entries;
  }

  async match(driver, screen) {
    const entries = await this.load();
    const recent = recentScreen(screen, MATCH_WINDOW_LINES);
    for (const entry of entries) {
      if (entry.driver !== driver) continue;
      if (entry.regex.test(recent)) return entry;
    }
    return null;
  }

  has(driver, pattern) {
    const known = (this.entries || []).some((entry) => entry.driver === driver && entry.pattern === pattern);
    if (known) return true;
    for (const lessons of this.pending.values()) {
      if (lessons.some((lesson) => lesson.driver === driver && lesson.pattern === pattern)) return true;
    }
    return false;
  }

  remember(attemptId, { driver, pattern, action, reason = null }) {
    if (!attemptId || !compilePattern(pattern) || this.has(driver, pattern)) return false;
    const lessons = this.pending.get(attemptId) || [];
    lessons.push({ driver, pattern: String(pattern), action, reason });
    this.pending.set(attemptId, lessons);
    return true;
  }

  async commit(attemptId) {
    const lessons = this.pending.get(attemptId) || [];
    this.pending.delete(attemptId);
    const committed = [];
    for (const lesson of lessons) {
      const record = {
        version: 1,
        driver: lesson.driver,
        pattern: lesson.pattern,
        action: lesson.action,
        reason: lesson.reason ? tailText(String(lesson.reason), 500) : null,
        attemptId,
        addedAt: nowIso(),
      };
      const entry = validEntry(record);
      if (!entry) continue;
      await appendJsonl(this.filePath, record);
      if (this.entries) this.entries.push(entry);
      committed.push(entry);
    }
    return committed;
  }

  discard(attemptId) {
    this.pending.delete(attemptId);
  }
}

module.exports = { MAX_PATTERN_CHARS, ScreenLibrary, compilePattern };
