"use strict";

const os = require("node:os");
const path = require("node:path");

function parseJsonArray(value, fallback = []) {
  if (!String(value || "").trim()) return fallback;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("driver argument configuration must be a JSON string array");
  }
  return parsed;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const stateDir = path.resolve(env.CLI_RUNTIME_STATE_DIR || path.join(os.homedir(), ".local", "state", "qozyai-cli-runtime"));
  return {
    stateDir,
    socketPath: path.resolve(env.CLI_RUNTIME_SOCKET || path.join(stateDir, "runtime.sock")),
    tmuxSocketName: String(env.CLI_RUNTIME_TMUX_SOCKET || "qozyai-cli-runtime").trim(),
    startupTimeoutMs: positiveNumber(env.CLI_RUNTIME_STARTUP_TIMEOUT_MS, 30_000),
    bindTimeoutMs: positiveNumber(env.CLI_RUNTIME_BIND_TIMEOUT_MS, 15_000),
    submissionTimeoutMs: positiveNumber(env.CLI_RUNTIME_SUBMISSION_TIMEOUT_MS, 30 * 60_000),
    artifactPollMs: positiveNumber(env.CLI_RUNTIME_ARTIFACT_POLL_MS, 150),
    navigator: {
      url: String(env.CLI_RUNTIME_NAVIGATOR_URL || "").trim(),
      apiKey: String(env.CLI_RUNTIME_NAVIGATOR_API_KEY || "").trim(),
      timeoutMs: positiveNumber(env.CLI_RUNTIME_NAVIGATOR_TIMEOUT_MS, 15_000),
      useOpenAI: env.CLI_RUNTIME_OPENAI_NAVIGATOR === "1",
    },
    openai: {
      apiKey: String(env.OPENAI_API_KEY || "").trim(),
      baseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
      navigatorModel: String(env.CLI_RUNTIME_NAVIGATOR_MODEL || "gpt-5.4-mini").trim(),
      transcriptionModel: String(env.CLI_RUNTIME_TRANSCRIPTION_MODEL || "gpt-4o-transcribe").trim(),
      transcriptionTimeoutMs: positiveNumber(env.CLI_RUNTIME_TRANSCRIPTION_TIMEOUT_MS, 60_000),
    },
    drivers: {
      claude: {
        command: env.CLI_RUNTIME_CLAUDE_COMMAND || "claude",
        homeDir: path.resolve(env.CLI_RUNTIME_CLAUDE_HOME || os.homedir()),
        model: String(env.CLI_RUNTIME_CLAUDE_MODEL || "").trim(),
        permissionMode: String(env.CLI_RUNTIME_CLAUDE_PERMISSION_MODE || "bypassPermissions").trim(),
        extraArgs: parseJsonArray(env.CLI_RUNTIME_CLAUDE_ARGS),
      },
      codex: {
        command: env.CLI_RUNTIME_CODEX_COMMAND || "codex",
        homeDir: path.resolve(env.CLI_RUNTIME_CODEX_HOME || os.homedir()),
        model: String(env.CLI_RUNTIME_CODEX_MODEL || "").trim(),
        sandbox: String(env.CLI_RUNTIME_CODEX_SANDBOX || "danger-full-access").trim(),
        approval: String(env.CLI_RUNTIME_CODEX_APPROVAL || "never").trim(),
        extraArgs: parseJsonArray(env.CLI_RUNTIME_CODEX_ARGS),
      },
    },
    telegram: {
      token: String(env.TELEGRAM_BOT_TOKEN || "").trim(),
      defaultDriver: String(env.CLI_RUNTIME_TELEGRAM_DRIVER || "claude").trim().toLowerCase(),
      workspace: path.resolve(env.CLI_RUNTIME_TELEGRAM_WORKSPACE || process.cwd()),
      statusEditIntervalMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_STATUS_EDIT_MS, 30_000),
      maxFileBytes: positiveNumber(env.CLI_RUNTIME_TELEGRAM_MAX_FILE_BYTES, 20 * 1024 * 1024),
      requestTimeoutMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_REQUEST_TIMEOUT_MS, 30_000),
      allowedChatIds: new Set(String(env.CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)),
    },
  };
}

module.exports = { loadConfig };
