"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { appendJsonl, nowIso } = require("./util");

class EventStore {
  constructor(stateDir) {
    this.filePath = path.join(stateDir, "events.jsonl");
    this.sequence = 0;
    this.events = new EventEmitter();
    this.writeChain = Promise.resolve();
  }

  async init() {
    let text = "";
    try { text = await fs.readFile(this.filePath, "utf8"); } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        this.sequence = Math.max(this.sequence, Number(event.sequence) || 0);
      } catch {}
    }
  }

  async append(type, details = {}) {
    let written;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      written = {
        version: 1,
        sequence: ++this.sequence,
        at: nowIso(),
        type,
        ...details,
      };
      await appendJsonl(this.filePath, written);
      this.events.emit("event", written);
    });
    await this.writeChain;
    return written;
  }

  async read({ after = 0, sessionKey = null, limit = 500 } = {}) {
    let text = "";
    try { text = await fs.readFile(this.filePath, "utf8"); } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const result = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if ((Number(event.sequence) || 0) <= Number(after || 0)) continue;
      if (sessionKey && event.sessionKey !== sessionKey) continue;
      result.push(event);
      if (result.length >= limit) break;
    }
    return result;
  }

  async wait({ after = 0, sessionKey = null, waitMs = 0, limit = 500 } = {}) {
    const existing = await this.read({ after, sessionKey, limit });
    if (existing.length > 0 || waitMs <= 0) return existing;
    return new Promise((resolve) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.events.off("event", onEvent);
        resolve(await this.read({ after, sessionKey, limit }));
      };
      const onEvent = (event) => {
        if (!sessionKey || event.sessionKey === sessionKey) finish().catch(() => resolve([]));
      };
      const timer = setTimeout(() => finish().catch(() => resolve([])), Math.min(waitMs, 30_000));
      this.events.on("event", onEvent);
      // Close the gap between the read above and listener registration.
      this.read({ after, sessionKey, limit }).then((events) => {
        if (events.length > 0) finish().catch(() => resolve([]));
      }).catch(() => {});
    });
  }
}

module.exports = { EventStore };
