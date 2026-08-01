"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const { readBody, sendJson } = require("./util");

function decode(value) {
  return decodeURIComponent(String(value || ""));
}

function createServer({ config, sessions, auth, eventStore, log = console.error }) {
  let server = null;

  async function handle(req, res) {
    const url = new URL(req.url, "http://unix");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(res, 200, { ok: true, sessions: await sessions.list() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        sendJson(res, 201, { ok: true, session: await sessions.create(await readBody(req)) });
        return;
      }
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2]) {
        const sessionKey = decode(parts[2]);
        if (parts.length === 3 && req.method === "GET") {
          const session = await sessions.get(sessionKey);
          sendJson(res, session ? 200 : 404, session ? { ok: true, session } : { ok: false, error: "session not found" });
          return;
        }
        if (parts.length === 3 && req.method === "DELETE") {
          sendJson(res, 200, { ok: true, session: await sessions.close(sessionKey) });
          return;
        }
        if (parts[3] === "submissions" && req.method === "POST") {
          sendJson(res, 202, { ok: true, submission: await sessions.submit(sessionKey, await readBody(req)) });
          return;
        }
        if (parts[3] === "output" && req.method === "GET") {
          sendJson(res, 200, { ok: true, ...(await sessions.output(sessionKey)) });
          return;
        }
        if (parts[3] === "interrupt" && req.method === "POST") {
          sendJson(res, 200, await sessions.interrupt(sessionKey));
          return;
        }
        if (parts[3] === "restart" && req.method === "POST") {
          sendJson(res, 200, { ok: true, session: await sessions.restart(sessionKey) });
          return;
        }
        if (parts[3] === "attach" && req.method === "GET") {
          sendJson(res, 200, { ok: true, ...(await sessions.attachInfo(sessionKey)) });
          return;
        }
      }
      if (parts[0] === "v1" && parts[1] === "submissions" && parts[2] && req.method === "GET") {
        const submission = await sessions.getSubmission(decode(parts[2]));
        sendJson(res, submission ? 200 : 404, submission ? { ok: true, submission } : { ok: false, error: "submission not found" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const events = await eventStore.wait({
          after: Number(url.searchParams.get("after") || 0),
          sessionKey: url.searchParams.get("sessionKey") || null,
          waitMs: Number(url.searchParams.get("waitMs") || 0),
          limit: Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 500))),
        });
        sendJson(res, 200, { ok: true, events });
        return;
      }
      if (parts[0] === "v1" && parts[1] === "auth" && parts[2]) {
        const driver = decode(parts[2]);
        if (parts[3] === "status" && req.method === "GET") {
          sendJson(res, 200, { ok: true, auth: await auth.status(driver) });
          return;
        }
        if (parts[3] === "start" && req.method === "POST") {
          const body = await readBody(req);
          sendJson(res, 200, { ok: true, auth: await auth.start(driver, { force: body.force === true }) });
          return;
        }
        if (parts[3] === "submit" && req.method === "POST") {
          const body = await readBody(req);
          sendJson(res, 200, { ok: true, auth: await auth.submit(driver, body.code) });
          return;
        }
      }
      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const status = err.code === "SESSION_BUSY" ? 409 : err.code === "AUTH_REQUIRED" ? 401 : 400;
      sendJson(res, status, { ok: false, error: err.message || String(err), code: err.code || null });
    }
  }

  return {
    async start() {
      await fs.mkdir(config.stateDir, { recursive: true });
      await fs.rm(config.socketPath, { force: true });
      server = http.createServer((req, res) => handle(req, res).catch((err) => {
        log(`[cli-runtime] request failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      }));
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await fs.chmod(config.socketPath, 0o600);
      await eventStore.append("runtime.started", { socketPath: config.socketPath });
      return { socketPath: config.socketPath };
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
      await fs.rm(config.socketPath, { force: true });
    },
  };
}

module.exports = { createServer };
