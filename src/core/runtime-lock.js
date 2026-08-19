"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function acquireRuntimeLock(stateDir) {
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, "runtime.lock");
  const recoveryPath = path.join(stateDir, "runtime.lock.recovery");
  const token = crypto.randomUUID();
  const candidatePath = path.join(stateDir, `.runtime.lock.${process.pid}.${token}`);
  const ownerRecord = `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`;
  await fs.writeFile(candidatePath, ownerRecord, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.link(candidatePath, filePath);
      await fs.rm(candidatePath, { force: true });
      return {
        filePath,
        async release() {
          let current = null;
          try { current = JSON.parse(await fs.readFile(filePath, "utf8")); } catch {}
          if (current?.token === token) await fs.rm(filePath, { force: true });
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let owner = null;
      try { owner = JSON.parse(await fs.readFile(filePath, "utf8")); } catch {}
      if (processAlive(Number(owner?.pid))) {
        const locked = new Error(`runtime state is already owned by process ${owner.pid}`);
        locked.code = "RUNTIME_ALREADY_RUNNING";
        throw locked;
      }
      try {
        await fs.link(candidatePath, recoveryPath);
      } catch (recoveryError) {
        if (recoveryError?.code !== "EEXIST") throw recoveryError;
        let recoveryOwner = null;
        try { recoveryOwner = JSON.parse(await fs.readFile(recoveryPath, "utf8")); } catch {}
        if (processAlive(Number(recoveryOwner?.pid))) {
          const locked = new Error(`runtime lock recovery is owned by process ${recoveryOwner.pid}`);
          locked.code = "RUNTIME_ALREADY_RUNNING";
          throw locked;
        }
        await fs.rm(recoveryPath, { force: true });
        continue;
      }
      try {
        let current = null;
        try { current = JSON.parse(await fs.readFile(filePath, "utf8")); } catch {}
        if (processAlive(Number(current?.pid))) {
          const locked = new Error(`runtime state is already owned by process ${current.pid}`);
          locked.code = "RUNTIME_ALREADY_RUNNING";
          throw locked;
        }
        await fs.rm(filePath, { force: true });
        await fs.link(candidatePath, filePath);
        await fs.rm(candidatePath, { force: true });
        return {
          filePath,
          async release() {
            let owned = null;
            try { owned = JSON.parse(await fs.readFile(filePath, "utf8")); } catch {}
            if (owned?.token === token) await fs.rm(filePath, { force: true });
          },
        };
      } finally {
        let recoveryOwner = null;
        try { recoveryOwner = JSON.parse(await fs.readFile(recoveryPath, "utf8")); } catch {}
        if (recoveryOwner?.token === token) await fs.rm(recoveryPath, { force: true });
      }
    }
    }
    throw new Error("could not acquire runtime state lock");
  } finally {
    await fs.rm(candidatePath, { force: true });
  }
}

module.exports = { acquireRuntimeLock, processAlive };
