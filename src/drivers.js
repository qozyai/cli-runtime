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

function hasPromptCandidate(screen, glyph) {
  return String(screen || "").split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(glyph)) return false;
    const remainder = trimmed.slice(glyph.length);
    if (!/^[\s\u00a0]/.test(remainder)) return false;
    return !/^\s*\d+(?:[.)])?(?:\s|$)/.test(remainder);
  });
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
  if (driver === "claude") {
    if (/WARNING: Claude Code running in Bypass Permissions mode|Try the new fullscreen renderer\?|Choose the text style|Security notes|Quick safety check|Select login method/i.test(recent)) return false;
    return hasPromptCandidate(recent, "❯");
  }
  if (/esc to interrupt|tab to queue message|still working|Do you trust the contents of this directory\?|update available/i.test(recent)) return false;
  return hasPromptCandidate(recent, "›");
}

function isPromptStillEditable(driver, screen, cursorLine, markerTail) {
  if (!String(cursorLine || "").includes(String(markerTail || ""))) return false;
  return isReady(driver, screen);
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
  isPromptStillEditable,
  isReady,
  isStartupAuthScreen,
  normalizeDriver,
  recentScreen,
};
