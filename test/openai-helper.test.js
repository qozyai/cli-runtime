"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { OpenAIHelper } = require("../src/openai-helper");

test("OpenAI navigation defaults to GPT-5.6 Luna", () => {
  const config = loadConfig({ HOME: "/tmp" });
  assert.equal(config.openai.navigatorModel, "gpt-5.6-luna");
});

test("OpenAI helper returns a strict navigator decision", async () => {
  let request = null;
  const config = loadConfig({
    HOME: "/tmp",
    OPENAI_API_KEY: "test-key",
    CLI_RUNTIME_NAVIGATOR_MODEL: "test-navigator",
  });
  const helper = new OpenAIHelper({
    config,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: "wait", key: null, text: null, reason: "already ready" }) } }],
        }),
      };
    },
  });
  const decision = await helper.navigationDecision({ driver: "codex", screen: "> Ready" });
  assert.deepEqual(decision, { action: "wait", key: null, text: null, reason: "already ready" });
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.equal(request.body.model, "test-navigator");
  assert.equal(request.body.response_format.json_schema.strict, true);
});

test("OpenAI helper sends audio through the transcription endpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-openai-audio-"));
  const sourcePath = path.join(root, "voice.ogg");
  await fs.writeFile(sourcePath, "ogg-bytes");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadConfig({
    HOME: root,
    OPENAI_API_KEY: "test-key",
    CLI_RUNTIME_TRANSCRIPTION_MODEL: "gpt-4o-transcribe",
  });
  let request = null;
  const helper = new OpenAIHelper({
    config,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ text: "spoken words" }) };
    },
  });
  const transcript = await helper.transcribe({ sourcePath, name: "voice.ogg", mimeType: "audio/ogg" });
  assert.equal(transcript, "spoken words");
  assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.equal(request.options.body.get("model"), "gpt-4o-transcribe");
  assert.equal(request.options.body.get("response_format"), "json");
  assert.equal(request.options.body.get("file").name, "voice.ogg");
});

test("OpenAI timeout covers response body consumption", async () => {
  const config = loadConfig({
    HOME: "/tmp",
    OPENAI_API_KEY: "test-key",
    CLI_RUNTIME_NAVIGATOR_TIMEOUT_MS: "30",
  });
  config.navigator.timeoutMs = 30;
  const helper = new OpenAIHelper({
    config,
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
    }),
  });
  await assert.rejects(() => helper.navigationDecision({ driver: "claude", screen: "ready" }), /aborted/);
});

test("OpenAI timeout covers response headers", async () => {
  const config = loadConfig({
    HOME: "/tmp",
    OPENAI_API_KEY: "test-key",
    CLI_RUNTIME_NAVIGATOR_TIMEOUT_MS: "30",
  });
  config.navigator.timeoutMs = 30;
  const helper = new OpenAIHelper({
    config,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  await assert.rejects(() => helper.navigationDecision({ driver: "codex", screen: "ready" }), /aborted/);
});
