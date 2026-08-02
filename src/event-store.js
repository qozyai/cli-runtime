"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { nowIso } = require("./util");

const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 10_000;

async function readTail(filePath, maxBytes) {
  let handle;
  try { handle = await fs.open(filePath, "r"); } catch (err) {
    if (err?.code === "ENOENT") return { text: "", truncated: false };
    throw err;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

class EventStore {
  constructor(stateDir, { maxBytes = MAX_EVENT_BYTES, maxEvents = MAX_EVENTS } = {}) {
    this.filePath = path.join(stateDir, "events.jsonl");
    this.sequence = 0;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.records = [];
    this.recordBytes = 0;
    this.fileBytes = 0;
    this.fileEvents = 0;
    this.writeChain = Promise.resolve();
    this.maxBytes = maxBytes;
    this.maxEvents = maxEvents;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const loaded = await readTail(this.filePath, this.maxBytes);
    for (const line of loaded.text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const sequence = Number(event.sequence) || 0;
        if (sequence <= 0) continue;
        this.sequence = Math.max(this.sequence, sequence);
        this.records.push({ event, bytes: Buffer.byteLength(`${line}\n`) });
      } catch {}
    }
    this.records.sort((a, b) => a.event.sequence - b.event.sequence);
    this.trim();
    const stat = await fs.stat(this.filePath).catch(() => null);
    this.fileBytes = stat?.size || 0;
    this.fileEvents = this.records.length;
    if (loaded.truncated) await this.compact();
  }

  trim() {
    this.recordBytes = this.records.reduce((total, item) => total + item.bytes, 0);
    while (this.records.length > 1 && (this.records.length > this.maxEvents || this.recordBytes > this.maxBytes)) {
      this.recordBytes -= this.records.shift().bytes;
    }
  }

  async compact() {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const text = this.records.map((item) => `${JSON.stringify(item.event)}\n`).join("");
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    this.fileBytes = Buffer.byteLength(text);
    this.fileEvents = this.records.length;
  }

  async append(type, details = {}) {
    let written;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      written = { version: 1, sequence: ++this.sequence, at: nowIso(), type, ...details };
      const line = `${JSON.stringify(written)}\n`;
      await fs.appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      this.fileBytes += Buffer.byteLength(line);
      this.fileEvents += 1;
      this.records.push({ event: written, bytes: Buffer.byteLength(line) });
      this.trim();
      if (this.fileBytes > this.maxBytes * 2 || this.fileEvents > this.maxEvents * 2) await this.compact();
      this.events.emit("event", written);
    });
    await this.writeChain;
    return written;
  }

  read({ after = 0, sessionKey = null, limit = 500 } = {}) {
    const cursor = Number(after || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) {
      const err = new Error(`event cursor is outside the available sequence range 0-${this.sequence}`);
      err.code = "EVENT_CURSOR_EXPIRED";
      err.earliestSequence = this.records[0]?.event.sequence || this.sequence + 1;
      err.latestSequence = this.sequence;
      throw err;
    }
    const earliest = this.records[0]?.event.sequence || this.sequence + 1;
    if (cursor > 0 && cursor < earliest - 1) {
      const err = new Error(`event cursor expired; earliest available sequence is ${earliest}`);
      err.code = "EVENT_CURSOR_EXPIRED";
      err.earliestSequence = earliest;
      err.latestSequence = this.sequence;
      throw err;
    }
    const result = [];
    for (const item of this.records) {
      const event = item.event;
      if (event.sequence <= cursor) continue;
      if (sessionKey && event.sessionKey !== sessionKey) continue;
      result.push(event);
      if (result.length >= limit) break;
    }
    return result;
  }

  async wait({ after = 0, sessionKey = null, waitMs = 0, limit = 500 } = {}) {
    const existing = this.read({ after, sessionKey, limit });
    if (existing.length > 0 || waitMs <= 0) return existing;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.off("event", onEvent);
        try { resolve(this.read({ after, sessionKey, limit })); } catch (err) { reject(err); }
      };
      const onEvent = (event) => {
        if (!sessionKey || event.sessionKey === sessionKey) finish();
      };
      const timer = setTimeout(finish, Math.min(waitMs, 30_000));
      this.events.on("event", onEvent);
      // Close the registration race without touching disk.
      if (this.read({ after, sessionKey, limit }).length > 0) finish();
    });
  }
}

module.exports = { EventStore, MAX_EVENT_BYTES, MAX_EVENTS };
