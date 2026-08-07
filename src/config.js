"use strict";

const fs = require("node:fs");
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

// Zero is a meaningful setting for the turn limits: it disables one.
function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function configError(message) {
  const error = new Error(message);
  error.code = "EX_CONFIG";
  error.exitCode = 78;
  return error;
}

function telegramOwnerEnrollmentCodeHash(env) {
  const key = "CLI_RUNTIME_TELEGRAM_OWNER_ENROLLMENT_CODE_HASH";
  const value = String(env[key] || "").trim().toLowerCase();
  if (value && !/^[a-f0-9]{64}$/.test(value)) {
    throw configError(`${key} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function telegramProjectsRoot(env, { required = false } = {}) {
  const key = "CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT";
  const present = Object.prototype.hasOwnProperty.call(env, key);
  if (!present) {
    if (required) throw configError(`${key} is required when the Telegram adapter is enabled`);
    return null;
  }
  const raw = String(env[key] ?? "").trim();
  if (!raw) throw configError(`${key} must not be empty`);
  const resolved = path.resolve(raw);
  if (["$HOME", "~"].includes(raw) || resolved === path.resolve(os.homedir())) {
    throw configError(`${key} must not be the runtime user's home directory`);
  }
  if (resolved === path.parse(resolved).root) throw configError(`${key} must not be the filesystem root`);
  let canonical;
  try {
    canonical = fs.realpathSync(resolved);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch (cause) {
    const error = configError(`${key} must name an existing directory`);
    error.cause = cause;
    throw error;
  }
  return canonical;
}

function loadConfig(env = process.env, { requireTelegramProjectsRoot = false } = {}) {
  const stateDir = path.resolve(env.CLI_RUNTIME_STATE_DIR || path.join(os.homedir(), ".local", "state", "qozyai-cli-runtime"));
  return {
    stateDir,
    socketPath: path.resolve(env.CLI_RUNTIME_SOCKET || path.join(stateDir, "runtime.sock")),
    tmuxSocketName: String(env.CLI_RUNTIME_TMUX_SOCKET || "qozyai-cli-runtime").trim(),
    startupTimeoutMs: positiveNumber(env.CLI_RUNTIME_STARTUP_TIMEOUT_MS, 30_000),
    bindTimeoutMs: positiveNumber(env.CLI_RUNTIME_BIND_TIMEOUT_MS, 15_000),
    submissionTimeoutMs: nonNegativeNumber(env.CLI_RUNTIME_SUBMISSION_TIMEOUT_MS, 0),
    submissionInactivityMs: nonNegativeNumber(env.CLI_RUNTIME_SUBMISSION_INACTIVITY_MS, 30 * 60_000),
    timeoutSettleMs: positiveNumber(env.CLI_RUNTIME_TIMEOUT_SETTLE_MS, 5000),
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
      navigatorModel: String(env.CLI_RUNTIME_NAVIGATOR_MODEL || "gpt-5.6-luna").trim(),
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
      projectsRoot: telegramProjectsRoot(env, { required: requireTelegramProjectsRoot }),
      statusEditIntervalMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_STATUS_EDIT_MS, 5000),
      maxFileBytes: positiveNumber(env.CLI_RUNTIME_TELEGRAM_MAX_FILE_BYTES, 20 * 1024 * 1024),
      requestTimeoutMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_REQUEST_TIMEOUT_MS, 30_000),
      restartAnnounceWindowMs: nonNegativeNumber(env.CLI_RUNTIME_RESTART_ANNOUNCE_WINDOW_MS, 5 * 60_000),
      burstDebounceMs: nonNegativeNumber(env.CLI_RUNTIME_TELEGRAM_BURST_DEBOUNCE_MS, 200),
      burstMaxWaitMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_BURST_MAX_WAIT_MS, 2000),
      burstMaxParts: positiveNumber(env.CLI_RUNTIME_TELEGRAM_BURST_MAX_PARTS, 25),
      noticePollMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_NOTICE_POLL_MS, 1000),
      attachServiceUrl: String(env.CLI_RUNTIME_TELEGRAM_ATTACH_SERVICE_URL || "").trim(),
      attachServiceTimeoutMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_ATTACH_SERVICE_TIMEOUT_MS, 30_000),
      allowedChatIds: new Set(String(env.CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)),
      ownerEnrollmentCodeHash: telegramOwnerEnrollmentCodeHash(env),
    },
  };
}

module.exports = { configError, loadConfig, telegramProjectsRoot };
