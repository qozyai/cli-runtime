"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { nowIso } = require("./util");

const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 10_000;
// A filesystem that hangs rather than fails would otherwise queue writes forever,
// because nothing on the turn path awaits them any more.
const MAX_PENDING_WRITES = 1000;

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
  constructor(stateDir, { maxBytes = MAX_EVENT_BYTES, maxEvents = MAX_EVENTS, maxPendingWrites = MAX_PENDING_WRITES } = {}) {
    this.maxPendingWrites = maxPendingWrites;
    this.pendingWrites = 0;
    this.droppedWrites = 0;
    this.filePath = path.join(stateDir, "events.jsonl");
    this.sequence = 0;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.records = [];
    this.recordBytes = 0;
    this.fileBytes = 0;
    this.fileEvents = 0;
    this.writeChain = Promise.resolve();
    this.durableSequence = 0;
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
    this.durableSequence = this.sequence;
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
    // Only rewrite what is already on disk: a record whose queued append has not run
    // yet would otherwise be written twice, once here and once by its own write.
    const durable = this.records.filter((item) => item.event.sequence <= this.durableSequence);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const text = durable.map((item) => `${JSON.stringify(item.event)}\n`).join("");
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    this.fileBytes = Buffer.byteLength(text);
    this.fileEvents = durable.length;
  }

  // Readers serve from memory, so an event is visible the moment it happens. The
  // durable write is queued behind it: a caller that does not await this promise
  // cannot be failed by an unwritable event log. This never throws synchronously —
  // a caller's .catch() is not attached yet when the body runs.
  append(type, details = {}) {
    try {
      return this.publish(type, details);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  publish(type, details) {
    const written = { version: 1, sequence: ++this.sequence, at: nowIso(), type, ...details };
    const line = `${JSON.stringify(written)}\n`;
    const bytes = Buffer.byteLength(line);
    this.records.push({ event: written, bytes });
    this.trim();

    // A stuck disk shows up as a growing backlog, not as an error. Shed the durable
    // write instead of holding every pending line in memory; the event stays
    // readable, and what never reached disk is counted and reported.
    if (this.pendingWrites >= this.maxPendingWrites) {
      if (this.droppedWrites === 0) {
        process.stderr.write(`[cli-runtime] event log backlog full (${this.pendingWrites} pending); shedding durable writes\n`);
      }
      this.droppedWrites += 1;
      this.emitEvent(written, type);
      return Promise.resolve(written);
    }

    this.pendingWrites += 1;
    const durableWrite = this.writeChain.catch(() => {}).then(async () => {
      try {
        await fs.appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
        this.durableSequence = written.sequence;
        this.fileBytes += bytes;
        this.fileEvents += 1;
        if (this.fileBytes > this.maxBytes * 2 || this.fileEvents > this.maxEvents * 2) await this.compact();
      } finally {
        this.pendingWrites -= 1;
        if (this.pendingWrites === 0 && this.droppedWrites > 0) this.reportDroppedWrites();
      }
    });
    this.writeChain = durableWrite.catch(() => {});
    // Emit only after this event owns its position in the chain. A listener that
    // appends re-entrantly would otherwise queue its write first, sending the file
    // out of order and letting durableSequence regress into a lossy compaction.
    this.emitEvent(written, type);
    return durableWrite.then(() => written);
  }

  emitEvent(written, type) {
    try {
      this.events.emit("event", written);
    } catch (err) {
      process.stderr.write(`[cli-runtime] event listener failed (${type}): ${err.message}\n`);
    }
  }

  // Runs once the backlog clears. Resetting first keeps this event from counting
  // itself into a second report.
  reportDroppedWrites() {
    const dropped = this.droppedWrites;
    this.droppedWrites = 0;
    process.stderr.write(`[cli-runtime] event log backlog cleared; ${dropped} events were not persisted\n`);
    this.publish("runtime.events_dropped", { dropped });
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
