"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { authCommand, driverConfig, isReady, normalizeDriver, recentScreen } = require("./drivers");
const { isolatedProcessEnv, safeId, sleep, tailText } = require("./util");

const execFileAsync = promisify(execFile);

function terminalUrls(screen) {
  const lines = String(screen || "").split(/\r?\n/);
  const urls = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].indexOf("https://");
    if (start < 0) continue;
    let value = lines[index].slice(start).trim().split(/\s/, 1)[0];
    while (index + 1 < lines.length) {
      const continuation = lines[index + 1].trim();
      if (!continuation || !/^[A-Za-z0-9%_?&=+./:#~-]+$/.test(continuation)) break;
      value += continuation;
      index += 1;
    }
    urls.push(value.replace(/[)>.,]+$/, ""));
  }
  return urls;
}

class AuthManager {
  constructor({ config, tmux, eventStore, navigator = null }) {
    this.config = config;
    this.tmux = tmux;
    this.eventStore = eventStore;
    this.navigator = navigator;
    this.authDir = path.join(config.stateDir, "auth");
    this.statusCache = new Map();
    this.startLocks = new Map();
  }

  // Same rule as the session manager: an event append never fails an auth flow.
  note(type, details = {}) {
    this.eventStore.append(type, details).catch((err) => {
      process.stderr.write(`[cli-runtime] event append failed (${type}): ${err.message}\n`);
    });
  }

  async withStartLock(driver, operation) {
    const previous = this.startLocks.get(driver) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.startLocks.set(driver, current);
    await previous.catch(() => {});
    try { return await operation(); } finally {
      release();
      if (this.startLocks.get(driver) === current) this.startLocks.delete(driver);
    }
  }

  sessionName(driver) {
    return `cli-auth-${safeId(driver, 10)}`;
  }

  async status(driverValue) {
    const driver = normalizeDriver(driverValue);
    const cached = this.statusCache.get(driver);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const spec = authCommand(this.config, driver);
    try {
      const result = await execFileAsync(spec.command, spec.args, {
        env: isolatedProcessEnv(spec.env),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      if (driver === "claude") {
        const parsed = JSON.parse(String(result.stdout || "{}").trim());
        const value = {
          driver,
          state: parsed.loggedIn === true ? "authenticated" : "unauthenticated",
          authenticated: parsed.loggedIn === true,
          method: parsed.authMethod || null,
          email: parsed.email || null,
        };
        if (value.authenticated) this.statusCache.set(driver, { value, expiresAt: Date.now() + 60_000 });
        return value;
      }
      const codexStatusText = `${result.stdout || ""}\n${result.stderr || ""}`;
      const value = {
        driver,
        state: /logged in/i.test(codexStatusText) ? "authenticated" : "unauthenticated",
        authenticated: /logged in/i.test(codexStatusText),
        method: /chatgpt/i.test(codexStatusText) ? "chatgpt" : null,
        email: null,
      };
      if (value.authenticated) this.statusCache.set(driver, { value, expiresAt: Date.now() + 60_000 });
      return value;
    } catch (err) {
      if (driver === "claude") {
        try {
          const parsed = JSON.parse(String(err.stdout || "{}").trim());
          if (typeof parsed.loggedIn === "boolean") {
            return {
              driver,
              state: parsed.loggedIn ? "authenticated" : "unauthenticated",
              authenticated: parsed.loggedIn,
              method: parsed.authMethod === "none" ? null : parsed.authMethod || null,
              email: parsed.email || null,
            };
          }
        } catch {}
      }
      const expectedUnauthenticated = driver === "codex" && /not logged in/i.test(`${err.stdout || ""}\n${err.stderr || ""}`);
      return {
        driver,
        state: expectedUnauthenticated ? "unauthenticated" : "unknown",
        authenticated: expectedUnauthenticated ? false : null,
        method: null,
        email: null,
        error: expectedUnauthenticated ? null : tailText(String(err.stderr || err.stdout || err.message || err).trim(), 3000),
      };
    }
  }

  async authScreen(driver) {
    const sessionName = this.sessionName(driver);
    if (!await this.tmux.has(sessionName)) return "";
    return this.tmux.capture(sessionName, 140);
  }

  parseAuthPrompt(driver, screen) {
    const recent = recentScreen(screen, 100);
    const urls = terminalUrls(recent);
    if (driver === "claude") {
      const url = urls.find((value) => /^https:\/\/(?:claude\.ai|claude\.com)\/(?:cai\/)?oauth\/authorize\?/i.test(value)) || null;
      if (url) return { phase: "awaiting_code", url, code: null, screen: tailText(recent, 12_000) };
      if (/Login successful|Welcome back/i.test(recent)) return { phase: "completed", url: null, code: null, screen: tailText(recent, 12_000) };
    } else {
      const url = urls.find((value) => /^https:\/\/auth\.openai\.com\/codex\/device/i.test(value)) || null;
      const code = recent.match(/(?:code|enter)\s*[:：]?\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i)?.[1] ||
        recent.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,})\b/)?.[1] || null;
      if (url || code) return { phase: "awaiting_browser", url, code, screen: tailText(recent, 12_000) };
      if (/Successfully logged in|Login successful/i.test(recent)) return { phase: "completed", url: null, code: null, screen: tailText(recent, 12_000) };
    }
    return { phase: "starting", url: null, code: null, screen: tailText(recent, 12_000) };
  }

  async start(driverValue, { force = false } = {}) {
    const driver = normalizeDriver(driverValue);
    return this.withStartLock(driver, () => this.startLocked(driver, { force }));
  }

  async startLocked(driver, { force = false } = {}) {
    const existing = await this.status(driver);
    if (existing.authenticated && !force) return { ...existing, phase: "completed" };
    const selected = driverConfig(this.config, driver);
    const sessionName = this.sessionName(driver);
    const workspace = path.join(this.authDir, driver);
    await fs.mkdir(workspace, { recursive: true });
    if (!force && await this.tmux.has(sessionName)) {
      const current = this.parseAuthPrompt(driver, await this.authScreen(driver));
      const processState = await this.tmux.driverState(sessionName).catch(() => ({ paneDead: true }));
      if (!processState.paneDead && ["starting", "awaiting_code", "awaiting_browser"].includes(current.phase)) {
        return { driver, authenticated: false, state: "unauthenticated", ...current, attachCommand: this.tmux.attachCommand(sessionName) };
      }
    }
    await this.tmux.kill(sessionName);
    await this.tmux.createShell(sessionName, workspace);
    const args = driver === "claude" ? [] : ["login", "--device-auth"];
    await this.tmux.startCommand(sessionName, selected.command, args, {
      HOME: selected.homeDir,
      DISABLE_AUTOUPDATER: "1",
    });
    this.note("auth.started", { driver });

    const deadline = Date.now() + this.config.startupTimeoutMs;
    let last = { phase: "starting", url: null, code: null, screen: "" };
    let nextNavigationAt = Date.now() + 2000;
    let navigationAttempt = 0;
    while (Date.now() < deadline) {
      const processState = await this.tmux.driverState(sessionName).catch((err) => ({ paneDead: true, error: err.message }));
      if (processState.paneDead) {
        last = {
          ...last,
          phase: "failed",
          error: processState.error || `authentication process exited (${processState.exitCode ?? "unknown"})`,
        };
        break;
      }
      const screen = await this.authScreen(driver);
      last = this.parseAuthPrompt(driver, screen);
      if (last.phase !== "starting") break;
      if (driver === "claude") {
        if (/Choose the text style/i.test(screen) || /Select login method/i.test(screen)) {
          await this.tmux.sendKey(sessionName, "Enter");
        } else if (isReady(driver, screen)) {
          await this.tmux.sendLiteral(sessionName, "/login");
          await this.tmux.sendKey(sessionName, "Enter");
        }
      }
      if (last.phase === "starting" && this.navigator?.enabled && Date.now() >= nextNavigationAt) {
        navigationAttempt += 1;
        try {
          const decision = await this.navigator.decide({
            driver,
            phase: "authentication",
            goal: "Reach the provider's browser authorization URL/code prompt or a completed login state.",
            screen,
            sessionKey: `auth:${driver}`,
            attempt: navigationAttempt,
          });
          if (decision?.action === "fail") {
            last = { ...last, phase: "failed", screen, error: decision.reason || "navigation failed" };
            break;
          }
          await this.navigator.apply(this.tmux, sessionName, decision);
        } catch (err) {
          this.note("navigation.error", {
            sessionKey: `auth:${driver}`,
            driver,
            phase: "authentication",
            error: tailText(err.message || String(err), 2000),
          });
        }
        nextNavigationAt = Date.now() + 2000;
      }
      await sleep(300);
    }
    this.note(`auth.${last.phase}`, { driver, url: last.url, code: last.code });
    return { driver, authenticated: last.phase === "completed", ...last, attachCommand: this.tmux.attachCommand(sessionName) };
  }

  async submit(driverValue, codeValue) {
    const driver = normalizeDriver(driverValue);
    const sessionName = this.sessionName(driver);
    if (!await this.tmux.has(sessionName)) throw new Error("auth terminal is not running");
    const code = String(codeValue || "").trim();
    if (driver === "claude") {
      if (!code) throw new Error("authorization code required");
      await this.tmux.sendKey(sessionName, "C-u");
      await this.tmux.sendLiteral(sessionName, code);
      await this.tmux.sendKey(sessionName, "Enter");
    }

    const deadline = Date.now() + this.config.startupTimeoutMs;
    let last = this.parseAuthPrompt(driver, await this.authScreen(driver));
    while (Date.now() < deadline) {
      const screen = await this.authScreen(driver);
      last = this.parseAuthPrompt(driver, screen);
      if (/Login successful\. Press Enter|Security notes|Quick safety check/i.test(screen)) {
        await this.tmux.sendKey(sessionName, "Enter");
      } else if (isReady(driver, screen) || last.phase === "completed") {
        last.phase = "completed";
        break;
      }
      if (/incorrect|invalid|expired|failed/i.test(recentScreen(screen, 30))) {
        last.phase = "failed";
        break;
      }
      await sleep(300);
    }
    const status = await this.status(driver);
    if (status.authenticated) last.phase = "completed";
    if (status.authenticated) this.statusCache.set(driver, { value: status, expiresAt: Date.now() + 60_000 });
    this.note(`auth.${last.phase}`, { driver });
    return {
      ...status,
      phase: last.phase,
      screen: last.screen,
      attachCommand: this.tmux.attachCommand(sessionName),
    };
  }
}

module.exports = { AuthManager, terminalUrls };
