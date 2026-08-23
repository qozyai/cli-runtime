"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { OpenAIHelper } = require("../src/surface/openai-helper");
const { OpenAINavigation } = require("../src/drivers/openai-navigation");

test("OpenAI navigation defaults to GPT-5.6 Terra at low effort", () => {
  const config = loadConfig({ HOME: "/tmp" });
  assert.equal(config.telegram.statusEditIntervalMs, 5000);
  assert.equal(config.openai.navigatorModel, "gpt-5.6-terra");
  assert.equal(config.openai.navigatorEffort, "low");
  assert.equal(loadConfig({ HOME: "/tmp", CLI_RUNTIME_NAVIGATOR_EFFORT: "none" }).openai.navigatorEffort, "none");
  assert.throws(
    () => loadConfig({ HOME: "/tmp", CLI_RUNTIME_NAVIGATOR_EFFORT: "max" }),
    (error) => error.code === "EX_CONFIG" && /CLI_RUNTIME_NAVIGATOR_EFFORT/.test(error.message),
  );
});

test("OpenAI helper returns a strict navigator decision", async () => {
  let request = null;
  const config = loadConfig({
    HOME: "/tmp",
    OPENAI_API_KEY: "test-key",
    CLI_RUNTIME_NAVIGATOR_MODEL: "test-navigator",
  });
  const helper = new OpenAINavigation({
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
  // The output order is the induced thinking: reason and plan come first,
  // the recognition regex next, the answer last. Effort stays low.
  assert.equal(request.body.reasoning_effort, "low");
  const properties = Object.keys(request.body.response_format.json_schema.schema.properties);
  assert.deepEqual(properties.slice(0, 3), ["reason", "steps", "screen_regex"]);
  assert.match(request.body.messages[0].content, /screen_regex/);
  assert.match(request.body.messages[0].content, /Never include session-specific values/);
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
  const helper = new OpenAINavigation({
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
  const helper = new OpenAINavigation({
    config,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  await assert.rejects(() => helper.navigationDecision({ driver: "codex", screen: "ready" }), /aborted/);
});
