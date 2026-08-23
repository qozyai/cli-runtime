"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { jsonOrNull, tailText, withAbortTimeout } = require("../core/util");

// Audio transcription for the chat surface. Navigation moved to
// drivers/openai-navigation.js: it serves session startup, which exists with
// or without a chat attached. Spec 0021.
class OpenAIHelper {
  constructor({ config, fetchImpl = fetch }) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.openai?.apiKey);
  }

  endpoint(relativePath) {
    return `${String(this.config.openai.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/${relativePath}`;
  }

  async transcribe({ sourcePath, name, mimeType }) {
    if (!this.enabled) return null;
    const bytes = await fs.readFile(sourcePath);
    const form = new FormData();
    form.append("model", this.config.openai.transcriptionModel);
    form.append("response_format", "json");
    form.append("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), path.basename(name || sourcePath));
    const { response, body } = await withAbortTimeout(this.config.openai.transcriptionTimeoutMs, async (signal) => {
      const response = await this.fetch(this.endpoint("audio/transcriptions"), {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.openai.apiKey}` },
        body: form,
        signal,
      });
      return { response, body: await jsonOrNull(response) };
    });
    if (!response.ok) throw new Error(body?.error?.message || `OpenAI transcription returned HTTP ${response.status}`);
    const transcript = tailText(body?.text || "", 1024 * 1024).trim();
    if (!transcript) throw new Error("OpenAI transcription returned empty text");
    return transcript;
  }
}

module.exports = { OpenAIHelper };
