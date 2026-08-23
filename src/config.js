"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DRIVERS } = require("./drivers/drivers");

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
// Spec 0017. Out of range falls back to the default rather than clamping: an operator
// who wrote a number the runtime will not honour should get the documented behaviour,
// not a silently different one that still looks configured.
function boundedInteger(value, fallback, { min, max, allowZero = false }) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (allowZero && parsed === 0) return 0;
  return parsed >= min && parsed <= max ? parsed : fallback;
}
function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// A terminal record has to outlive the poll that collects it, and 1,000 is the shipped
// default rather than a limit — this is the floor below which the prune stops being
// housekeeping and starts being a race with the reply path.
const MIN_OPERATIONAL_RECORD_KEEP = 100;
function configError(message) {
  const error = new Error(message);
  error.code = "EX_CONFIG";
  error.exitCode = 78;
  return error;
}

// A safety switch that silently downgrades is worse than no switch: "blok" or "BLOCK"
// would read as enforcement while permitting the drift it was set to stop.
function driverVersionEnforce(env) {
  const key = "CLI_RUNTIME_DRIVER_VERSION_ENFORCE";
  const value = String(env[key] || "").trim();
  if (!value) return "warn";
  if (value !== "warn" && value !== "block") {
    throw configError(`${key} must be "warn" or "block"`);
  }
  return value;
}

function telegramOwnerEnrollmentCodeHash(env) {
  const key = "CLI_RUNTIME_TELEGRAM_OWNER_ENROLLMENT_CODE_HASH";
  const value = String(env[key] || "").trim().toLowerCase();
  if (value && !/^[a-f0-9]{64}$/.test(value)) {
    throw configError(`${key} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function telegramSystemIngressChatIds(env) {
  const key = "CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS";
  const values = String(env[key] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length > 32) throw configError(`${key} may contain at most 32 Telegram user IDs`);
  if (values.some((value) => !/^[1-9]\d{0,19}$/.test(value))) {
    throw configError(`${key} must contain only positive Telegram user IDs`);
  }
  if (new Set(values).size !== values.length) {
    throw configError(`${key} must not contain duplicate Telegram user IDs`);
  }
  return new Set(values);
}

// Spec 0022. The navigation model runs at low effort by design: the ordered
// structured output is where the thinking happens. "none" omits the parameter.
function navigatorEffort(env) {
  const key = "CLI_RUNTIME_NAVIGATOR_EFFORT";
  const value = String(env[key] || "low").trim().toLowerCase();
  if (!["none", "minimal", "low", "medium", "high"].includes(value)) {
    throw configError(`${key} must be one of: none, minimal, low, medium, high`);
  }
  return value;
}

// Spec 0020. Every sibling Telegram knob fails at load; a typo here used to
// surface per-message instead, as an opaque runtime error on the first send.
function telegramDefaultDriver(env) {
  const key = "CLI_RUNTIME_TELEGRAM_DRIVER";
  const value = String(env[key] || "claude").trim().toLowerCase();
  if (!DRIVERS.has(value)) {
    throw configError(`${key} must be one of: ${[...DRIVERS].join(", ")}`);
  }
  return value;
}

function telegramDefaultProject(env) {
  const key = "CLI_RUNTIME_TELEGRAM_DEFAULT_PROJECT";
  const value = String(env[key] || "").trim();
  if (value && !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw configError(`${key} may use only ASCII letters, digits, underscore, and hyphen`);
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
    // Spec 0018. The workspace age floors are gone from the runtime; `retention-sweep`
    // reads them from a marker beside the data instead. What remains here is the one
    // retention decision that needs a record rather than an mtime.
    //
    // A terminal submission record is how a caller collects its reply — both `send
    // --wait` and the Telegram adapter poll `GET /v1/submissions/:id` until it reports
    // a terminal status. Pruning is therefore not free at small counts: keep 0 and the
    // record can be gone before the next poll, which turns a finished turn into a 404.
    // Hence a floor, and hence the grace window below.
    operationalRecordKeep: boundedInteger(env.CLI_RUNTIME_OPERATIONAL_RECORD_KEEP, 1000, {
      min: MIN_OPERATIONAL_RECORD_KEEP, max: Number.MAX_SAFE_INTEGER,
    }),
    // The count alone cannot be safe: enough concurrent completions and the newest
    // records are themselves the ones over the line. No terminal record is deleted
    // until it has had this long to be collected.
    operationalRecordGraceMs: nonNegativeNumber(env.CLI_RUNTIME_OPERATIONAL_RECORD_GRACE_MS, 10 * 60_000),
    // A pinned driver that drifts is reported, not silently tolerated. Blocking is
    // opt-in: a patch bump that breaks nothing should not take the bot off the air.
    driverVersionEnforce: driverVersionEnforce(env),
    navigator: {
      url: String(env.CLI_RUNTIME_NAVIGATOR_URL || "").trim(),
      apiKey: String(env.CLI_RUNTIME_NAVIGATOR_API_KEY || "").trim(),
      timeoutMs: positiveNumber(env.CLI_RUNTIME_NAVIGATOR_TIMEOUT_MS, 15_000),
      useOpenAI: env.CLI_RUNTIME_OPENAI_NAVIGATOR === "1",
    },
    openai: {
      apiKey: String(env.OPENAI_API_KEY || "").trim(),
      baseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
      navigatorModel: String(env.CLI_RUNTIME_NAVIGATOR_MODEL || "gpt-5.6-terra").trim(),
      navigatorEffort: navigatorEffort(env),
      transcriptionModel: String(env.CLI_RUNTIME_TRANSCRIPTION_MODEL || "gpt-4o-transcribe").trim(),
      transcriptionTimeoutMs: positiveNumber(env.CLI_RUNTIME_TRANSCRIPTION_TIMEOUT_MS, 60_000),
    },
    drivers: {
      claude: {
        command: env.CLI_RUNTIME_CLAUDE_COMMAND || "claude",
        version: String(env.CLI_RUNTIME_CLAUDE_VERSION || "").trim(),
        homeDir: path.resolve(env.CLI_RUNTIME_CLAUDE_HOME || os.homedir()),
        model: String(env.CLI_RUNTIME_CLAUDE_MODEL || "").trim(),
        permissionMode: String(env.CLI_RUNTIME_CLAUDE_PERMISSION_MODE || "bypassPermissions").trim(),
        extraArgs: parseJsonArray(env.CLI_RUNTIME_CLAUDE_ARGS),
      },
      codex: {
        command: env.CLI_RUNTIME_CODEX_COMMAND || "codex",
        version: String(env.CLI_RUNTIME_CODEX_VERSION || "").trim(),
        homeDir: path.resolve(env.CLI_RUNTIME_CODEX_HOME || os.homedir()),
        model: String(env.CLI_RUNTIME_CODEX_MODEL || "").trim(),
        sandbox: String(env.CLI_RUNTIME_CODEX_SANDBOX || "danger-full-access").trim(),
        approval: String(env.CLI_RUNTIME_CODEX_APPROVAL || "never").trim(),
        extraArgs: parseJsonArray(env.CLI_RUNTIME_CODEX_ARGS),
      },
    },
    telegram: {
      token: String(env.TELEGRAM_BOT_TOKEN || "").trim(),
      defaultDriver: telegramDefaultDriver(env),
      defaultProject: telegramDefaultProject(env),
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
      attachServiceTimeoutMs: positiveNumber(env.CLI_RUNTIME_TELEGRAM_ATTACH_SERVICE_TIMEOUT_MS, 45_000),
      allowedChatIds: new Set(String(env.CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)),
      systemIngressChatIds: telegramSystemIngressChatIds(env),
      ownerEnrollmentCodeHash: telegramOwnerEnrollmentCodeHash(env),
    },
  };
}

module.exports = { configError, loadConfig, telegramProjectsRoot };
