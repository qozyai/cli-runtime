"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { writeAtomic } = require("../core/util");
const { validProjectName } = require("./project-catalog");

const ROUTE_KEY_PATTERN = /^-?\d+:(?:main|\d+)$/;
const DRIVERS = new Set(["claude", "codex"]);

function cloneRecord(record) {
  return record ? Object.freeze({ driver: record.driver, ...(record.project ? { project: record.project } : {}) }) : null;
}

function validRecord(key, record) {
  if (!ROUTE_KEY_PATTERN.test(key) || !record || typeof record !== "object" || Array.isArray(record)) return false;
  const keys = Object.keys(record);
  if (!keys.includes("driver") || keys.some((field) => !["driver", "project"].includes(field))) return false;
  if (!DRIVERS.has(record.driver)) return false;
  return record.project === undefined || validProjectName(record.project);
}

class RouteStore {
  constructor({ stateDir, log = console.error } = {}) {
    this.dir = path.join(stateDir, "telegram");
    this.filePath = path.join(this.dir, "routes.json");
    this.log = log;
    this.records = Object.create(null);
    this.writeChain = Promise.resolve();
  }

  quarantinePath() {
    return path.join(this.dir, `routes.invalid.${Date.now()}.json`);
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    let text;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const quarantine = this.quarantinePath();
      await fs.rename(this.filePath, quarantine);
      this.log(`[telegram] routes.json was malformed and was quarantined at ${quarantine}`);
      return;
    }
    await fs.chmod(this.filePath, 0o600);
    const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { "<document>": parsed };
    const invalid = Object.create(null);
    for (const [key, record] of Object.entries(source)) {
      if (validRecord(key, record)) this.records[key] = { ...record };
      else invalid[key] = record;
    }
    if (Object.keys(invalid).length) {
      const quarantine = this.quarantinePath();
      await writeAtomic(quarantine, invalid);
      await writeAtomic(this.filePath, this.records);
      this.log(`[telegram] quarantined invalid route entries at ${quarantine}: ${Object.keys(invalid).join(", ")}`);
    }
  }

  get(key) {
    return cloneRecord(this.records[String(key)] || null);
  }

  async update(key, fields) {
    const routeKey = String(key || "");
    if (!ROUTE_KEY_PATTERN.test(routeKey)) throw new Error(`invalid route key: ${routeKey}`);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
      || Object.keys(fields).some((field) => !["driver", "project"].includes(field))) {
      throw new Error("route update contains invalid fields");
    }
    const run = this.writeChain.then(async () => {
      const next = { ...(this.records[routeKey] || {}), ...fields };
      if (next.project === null || next.project === "") delete next.project;
      if (!validRecord(routeKey, next)) throw new Error("route update would create an invalid record");
      const document = { ...this.records, [routeKey]: next };
      await writeAtomic(this.filePath, document);
      this.records = Object.assign(Object.create(null), document);
      return cloneRecord(next);
    });
    this.writeChain = run.catch(() => {});
    return run;
  }
}

module.exports = { ROUTE_KEY_PATTERN, RouteStore, validRecord };
