"use strict";

const http = require("node:http");

function request(socketPath, method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      socketPath,
      method,
      path: requestPath,
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
          err.body = parsed;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

module.exports = { request };
