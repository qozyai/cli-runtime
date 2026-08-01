"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

module.exports = {
  appendJsonl,
  createId,
  nowIso,
  readBody,
  readJson,
  safeId,
  sendJson,
  shellQuote,
  sleep,
  tailText,
  writeAtomic,
};
