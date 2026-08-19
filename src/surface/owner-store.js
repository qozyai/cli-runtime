"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { nowIso, writeAtomic } = require("../core/util");

const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

function userId(value) {
  const normalized = String(value ?? "").trim();
  return TELEGRAM_USER_ID_PATTERN.test(normalized) ? normalized : null;
}

function validOwnerRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.version !== 1 || !userId(record.userId)) return false;
  if (typeof record.claimedAt !== "string" || !Number.isFinite(Date.parse(record.claimedAt))) return false;
  return Object.keys(record).every((key) => ["version", "userId", "claimedAt"].includes(key));
}

function senderUserId(message) {
  if (message?.from?.is_bot === true) return null;
  return userId(message?.from?.id);
}

function isDirectOwnerClaim(message, senderId) {
  return message?.chat?.type === "private"
    && userId(message.chat.id) === senderId;
}

class OwnerStore {
  constructor({ stateDir, log = console.error } = {}) {
    this.dir = path.join(stateDir, "telegram");
    this.filePath = path.join(this.dir, "owner.json");
    this.log = log;
    this.record = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    const stat = await fs.lstat(this.filePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error("Telegram owner state is not a direct regular file");
      error.code = "TELEGRAM_OWNER_STATE_INVALID";
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (cause) {
      const error = new Error("Telegram owner state is malformed");
      error.code = "TELEGRAM_OWNER_STATE_INVALID";
      error.cause = cause;
      throw error;
    }
    if (!validOwnerRecord(parsed)) {
      const error = new Error("Telegram owner state is invalid");
      error.code = "TELEGRAM_OWNER_STATE_INVALID";
      throw error;
    }
    await fs.chmod(this.filePath, 0o600);
    this.record = Object.freeze({ ...parsed, userId: userId(parsed.userId) });
  }

  get() {
    return this.record ? Object.freeze({ ...this.record }) : null;
  }

  async claim(senderId) {
    const normalized = userId(senderId);
    if (!normalized) return false;
    const run = this.writeChain.then(async () => {
      if (this.record) return this.record.userId === normalized;
      const record = { version: 1, userId: normalized, claimedAt: nowIso() };
      await writeAtomic(this.filePath, record);
      this.record = Object.freeze(record);
      this.log("[telegram] owner bound from the first accepted private message");
      return true;
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  async authorize(message) {
    const senderId = senderUserId(message);
    if (!senderId) return false;
    if (this.record) {
      if (this.record.userId !== senderId) return false;
      return message?.chat?.type === "private" || GROUP_CHAT_TYPES.has(message?.chat?.type);
    }
    if (!isDirectOwnerClaim(message, senderId)) return false;
    return this.claim(senderId);
  }
}

module.exports = {
  OwnerStore,
  TELEGRAM_USER_ID_PATTERN,
  senderUserId,
  userId,
  validOwnerRecord,
};
