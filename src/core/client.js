"use strict";

const http = require("node:http");

// Above the longest legitimate wait on the API (the 30-second event long-poll),
// so a wedged daemon fails callers visibly instead of hanging them forever.
const REQUEST_TIMEOUT_MS = 45_000;

function request(socketPath, method, requestPath, body = null, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      socketPath,
      method,
      path: requestPath,
      timeout: timeoutMs,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: text || `HTTP ${res.statusCode}` }; }
        if ((res.statusCode || 500) >= 400) {
          const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.code = parsed.code || null;
          err.body = parsed;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`runtime request timed out after ${timeoutMs}ms: ${method} ${requestPath}`));
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

module.exports = { request };
