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
    submissionTimeoutMs: positiveNumber(env.CLI_RUNTIME_SUBMISSION_TIMEOUT_MS, 30 * 60_000),
    artifactPollMs: positiveNumber(env.CLI_RUNTIME_ARTIFACT_POLL_MS, 150),
    workspaceMaxInputFiles: positiveNumber(env.CLI_RUNTIME_MAX_INPUT_FILES, 20),
    workspaceMaxInputFileBytes: positiveNumber(env.CLI_RUNTIME_MAX_INPUT_FILE_BYTES, 50 * 1024 * 1024),
    workspaceMaxInputTotalBytes: positiveNumber(env.CLI_RUNTIME_MAX_INPUT_TOTAL_BYTES, 100 * 1024 * 1024),
    workspaceMaxOutputFiles: positiveNumber(env.CLI_RUNTIME_MAX_OUTPUT_FILES, 20),
    workspaceMaxOutputFileBytes: positiveNumber(env.CLI_RUNTIME_MAX_OUTPUT_FILE_BYTES, 100 * 1024 * 1024),
    workspaceMaxOutputTotalBytes: positiveNumber(env.CLI_RUNTIME_MAX_OUTPUT_TOTAL_BYTES, 200 * 1024 * 1024),
    navigator: {
      url: String(env.CLI_RUNTIME_NAVIGATOR_URL || "").trim(),
      apiKey: String(env.CLI_RUNTIME_NAVIGATOR_API_KEY || "").trim(),
      timeoutMs: positiveNumber(env.CLI_RUNTIME_NAVIGATOR_TIMEOUT_MS, 15_000),
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
      allowedChatIds: new Set(String(env.CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)),
    },
  };
}

module.exports = { loadConfig };
