"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function safeId(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function createId(prefix) {
  return `${prefix}_${new Date().toISOString().replace(/[-:.]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function isolatedProcessEnv(overrides = {}, source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] !== undefined && source[key] !== null) env[key] = String(source[key]);
  }
  if (!env.PATH) env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body must be JSON");
  }
}

function sendJson(res, statusCode, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tailText(value, maxChars = 16_000) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

// Provenance of a turn. The runtime cannot infer this — a scheduled turn and a
// person typing reach the daemon as the same POST — so the caller declares it, and
// an unlabelled submission is treated as the owner speaking. That default keeps
// every existing caller, and every turn already on disk, meaning exactly what it
// did. The runtime knows these two values and nothing about who sends them.
const SUBMISSION_SOURCE_OWNER = "owner";
const SUBMISSION_SOURCE_SCHEDULER = "scheduler";
const SUBMISSION_SOURCES = new Set([SUBMISSION_SOURCE_OWNER, SUBMISSION_SOURCE_SCHEDULER]);

function normalizeSubmissionSource(value) {
  const source = String(value || "").trim().toLowerCase();
  return SUBMISSION_SOURCES.has(source) ? source : SUBMISSION_SOURCE_OWNER;
}

module.exports = {
  SUBMISSION_SOURCE_OWNER,
  SUBMISSION_SOURCE_SCHEDULER,
  appendJsonl,
  createId,
  isolatedProcessEnv,
  normalizeSubmissionSource,
  nowIso,
  readBody,
  readJson,
  safeId,
  sendJson,
  shellQuote,
  sleep,
  sleepWithSignal,
  tailText,
  writeAtomic,
};
