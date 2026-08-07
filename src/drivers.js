"use strict";

const path = require("node:path");

const DRIVERS = new Set(["claude", "codex"]);

function normalizeDriver(value) {
  const driver = String(value || "").trim().toLowerCase();
  if (!DRIVERS.has(driver)) throw new Error(`unsupported driver: ${driver || "empty"}`);
  return driver;
}

function recentScreen(screen, lines = 60) {
  const parts = String(screen || "").split(/\r?\n/);
  while (parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  return parts.slice(-lines).join("\n");
}

function lastPromptCandidateIndex(lines, glyph) {
  let result = -1;
  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(glyph)) return;
    const remainder = trimmed.slice(glyph.length);
    if (!/^[\s\u00a0]/.test(remainder)) return;
    if (!/^\s*\d+(?:[.)])?(?:\s|$)/.test(remainder)) result = index;
  });
  return result;
}

function lastMatchingLineIndex(lines, pattern) {
  let result = -1;
  lines.forEach((line, index) => {
    if (pattern.test(line)) result = index;
  });
  return result;
}

function driverConfig(config, driver) {
  return config.drivers[normalizeDriver(driver)];
}

function buildLaunch(config, session) {
  const driver = normalizeDriver(session.driver);
  const selected = driverConfig(config, driver);
  const providerSessionId = String(session.providerSessionId || session.parentProviderSessionId || "").trim();
  const mode = providerSessionId ? String(session.startMode || "resume") : "fresh";
  let args;

  if (driver === "claude") {
    args = [];
    if (selected.permissionMode) args.push("--permission-mode", selected.permissionMode);
    if (selected.model) args.push("--model", selected.model);
    if (mode === "resume" || mode === "fork") args.push("--resume", providerSessionId);
    if (mode === "fork") args.push("--fork-session");
    args.push(...selected.extraArgs);
  } else {
    args = [];
    if (mode === "resume" || mode === "fork") args.push(mode);
    args.push("--no-alt-screen", "--sandbox", selected.sandbox, "--ask-for-approval", selected.approval);
    if (session.workspace) args.push("--cd", session.workspace);
    if (selected.model) args.push("--model", selected.model);
    if (mode === "resume" || mode === "fork") args.push(providerSessionId);
    args.push(...selected.extraArgs);
  }

  return {
    command: selected.command,
    args,
    env: {
      HOME: selected.homeDir,
      DISABLE_AUTOUPDATER: "1",
      CLI_RUNTIME_DRIVER: driver,
    },
  };
}

function isReady(driver, screen) {
  const recent = recentScreen(screen);
  const lines = recent.split(/\r?\n/);
  if (driver === "claude") {
    const prompt = lastPromptCandidateIndex(lines, "❯");
    const blocker = lastMatchingLineIndex(lines,
      /WARNING: Claude Code running in Bypass Permissions mode|Try the new fullscreen renderer\?|Choose the text style|Security notes|Quick safety check|Select login method/i);
    return prompt >= 0 && prompt > blocker;
  }
  const prompt = lastPromptCandidateIndex(lines, "›");
  const blocker = lastMatchingLineIndex(lines,
    /esc to interrupt|tab to queue message|still working|Do you trust the contents of this directory\?|update available/i);
  return prompt >= 0 && prompt > blocker;
}

function isCollapsedPasteReceipt(driver, cursorLine, expectedChars) {
  const line = String(cursorLine || "").trim();
  if (driver === "codex") {
    const match = line.match(/^›\s*\[Pasted Content (\d+) chars\]\s*$/u);
    return Boolean(match) && Number(match[1]) === expectedChars;
  }
  if (driver === "claude") return /^❯\s*\[Pasted text #\d+\]\s*$/u.test(line);
  return false;
}

function isPastedPromptEditable(driver, screen, cursorLine, evidence) {
  if (!isReady(driver, screen)) return false;
  const markerTail = String(evidence.markerTail || "");
  if (markerTail && String(cursorLine || "").includes(markerTail)) return true;
  if (String(cursorLine || "") === String(evidence.beforePasteCursorLine || "")) return false;
  return isCollapsedPasteReceipt(driver, cursorLine, evidence.expectedChars);
}

function isStartupAuthScreen(driver, screen) {
  const text = recentScreen(screen, 16);
  if (driver === "claude") return /Select login method|Opening browser to sign in|Paste code here/i.test(text);
  return /Sign in with ChatGPT|Log in with ChatGPT|auth\.openai\.com\/codex\/device/i.test(text);
}

function isAuthRequired(driver, screen) {
  const text = recentScreen(screen).toLowerCase();
  if (driver === "claude") {
    return text.includes("select login method") ||
      text.includes("opening browser to sign in") ||
      text.includes("paste code here") ||
      text.includes("please run /login") ||
      text.includes("not logged in");
  }
  return text.includes("sign in with chatgpt") ||
    text.includes("log in with chatgpt") ||
    text.includes("codex login") ||
    text.includes("auth.openai.com/codex/device");
}

function driverExit(screen) {
  const matches = [...recentScreen(screen).matchAll(/\[cli-runtime driver exited:\s*(-?\d+)\]/gi)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function artifactRoot(config, driver) {
  const selected = driverConfig(config, driver);
  return driver === "claude"
    ? path.join(selected.homeDir, ".claude", "projects")
    : path.join(selected.homeDir, ".codex", "sessions");
}

function authCommand(config, driver) {
  const selected = driverConfig(config, driver);
  return driver === "claude"
    ? { command: selected.command, args: ["auth", "status"], env: { HOME: selected.homeDir, DISABLE_AUTOUPDATER: "1" } }
    : { command: selected.command, args: ["login", "status"], env: { HOME: selected.homeDir } };
}

module.exports = {
  artifactRoot,
  authCommand,
  buildLaunch,
  driverConfig,
  driverExit,
  isAuthRequired,
  isCollapsedPasteReceipt,
  isPastedPromptEditable,
  isReady,
  isStartupAuthScreen,
  normalizeDriver,
  recentScreen,
};
