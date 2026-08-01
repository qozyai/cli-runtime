"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  artifactRoot,
  buildLaunch,
  driverExit,
  isAuthRequired,
  isReady,
  normalizeDriver,
  normalizePrompt,
  recentScreen,
} = require("./drivers");
const { baselineArtifacts, publicProgress, watchArtifacts } = require("./artifacts");
const { createId, nowIso, readJson, safeId, sleep, tailText, writeAtomic } = require("./util");

function publicSession(session) {
  return {
    version: 1,
    sessionKey: session.sessionKey,
    driver: session.driver,
    workspace: session.workspace,
    status: session.status,
    activeSubmissionId: session.activeSubmissionId || null,
    lastSubmissionId: session.lastSubmissionId || null,
    lastReply: tailText(session.lastReply || "", 12_000) || null,
    lastError: tailText(session.lastError || "", 4000) || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function publicSubmission(submission) {
  if (!submission) return null;
  return {
    version: 1,
    submissionId: submission.submissionId,
    sessionKey: submission.sessionKey,
    status: submission.status,
    reply: tailText(submission.reply || "", 20_000) || null,
    error: tailText(submission.error || "", 6000) || null,
    progress: publicProgress(submission.progress),
    acceptedAt: submission.acceptedAt,
    startedAt: submission.startedAt || null,
    completedAt: submission.completedAt || null,
  };
}

class SessionManager {
  constructor({ config, tmux, eventStore, navigator = null }) {
    this.config = config;
    this.tmux = tmux;
    this.eventStore = eventStore;
    this.navigator = navigator;
    this.sessionsDir = path.join(config.stateDir, "sessions");
    this.submissionsDir = path.join(config.stateDir, "submissions");
    this.sessions = new Map();
    this.active = new Map();
  }

  sessionDir(sessionKey) {
    return path.join(this.sessionsDir, safeId(sessionKey, 32));
  }

  sessionPath(sessionKey) {
    return path.join(this.sessionDir(sessionKey), "session.json");
  }

  submissionPath(submissionId) {
    return path.join(this.submissionsDir, `${safeId(submissionId, 40)}.json`);
  }

  promptPath(sessionKey, submissionId) {
    return path.join(this.sessionDir(sessionKey), "prompts", `${safeId(submissionId, 40)}.txt`);
  }

  async init() {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.submissionsDir, { recursive: true });
    let entries = [];
    try { entries = await fs.readdir(this.sessionsDir, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readJson(path.join(this.sessionsDir, entry.name, "session.json"), null);
      if (!record?.sessionKey) continue;
      if (record.activeSubmissionId) {
        const submissionId = record.activeSubmissionId;
        const submission = await readJson(this.submissionPath(submissionId), null);
        if (submission && ["accepted", "running"].includes(submission.status)) {
          submission.status = "failed";
          submission.error = "runtime restarted while the submission was active";
          submission.completedAt = nowIso();
          await this.persistSubmission(submission);
          await this.eventStore.append("submission.failed", {
            sessionKey: record.sessionKey,
            submissionId,
            error: submission.error,
          });
        }
        record.status = "attention_required";
        record.lastError = "runtime restarted while a submission was active";
        record.activeSubmissionId = null;
        record.lastSubmissionId = submissionId;
        record.updatedAt = nowIso();
        await writeAtomic(this.sessionPath(record.sessionKey), record);
      }
      this.sessions.set(record.sessionKey, record);
    }
  }

  async persistSession(session) {
    session.updatedAt = nowIso();
    await writeAtomic(this.sessionPath(session.sessionKey), session);
  }

  async persistSubmission(submission) {
    await writeAtomic(this.submissionPath(submission.submissionId), submission);
  }

  async list() {
    return [...this.sessions.values()].map(publicSession);
  }

  async get(sessionKey, { refresh = true } = {}) {
    const session = this.sessions.get(String(sessionKey || ""));
    if (!session) return null;
    if (refresh && session.status !== "closed" && !this.active.has(session.sessionKey)) {
      if (!await this.tmux.has(session.tmuxSessionName)) {
        session.status = "stopped";
        session.lastError = session.lastError || "terminal session is not running";
        await this.persistSession(session);
      }
    }
    return publicSession(session);
  }

  rawSession(sessionKey) {
    const session = this.sessions.get(String(sessionKey || ""));
    if (!session) throw new Error(`session not found: ${sessionKey}`);
    return session;
  }

  async create({ sessionKey, driver, workspace, forkFromSessionKey = null } = {}) {
    const key = String(sessionKey || "").trim();
    if (!key) throw new Error("sessionKey required");
    const normalizedDriver = normalizeDriver(driver);
    const resolvedWorkspace = path.resolve(String(workspace || "").trim());
    const stat = await fs.stat(resolvedWorkspace).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`workspace is not a directory: ${resolvedWorkspace}`);

    const existing = this.sessions.get(key);
    if (existing && existing.status !== "closed") return publicSession(existing);

    let parentProviderSessionId = null;
    if (forkFromSessionKey) {
      const parent = this.rawSession(forkFromSessionKey);
      if (parent.driver !== normalizedDriver) throw new Error("fork parent must use the same driver");
      parentProviderSessionId = parent.providerSessionId || null;
      if (!parentProviderSessionId) throw new Error("fork parent has no provider session yet");
    }

    const now = nowIso();
    const session = {
      version: 1,
      sessionKey: key,
      driver: normalizedDriver,
      workspace: resolvedWorkspace,
      tmuxSessionName: `cli-${safeId(key, 20)}`,
      status: "starting",
      providerSessionId: null,
      parentProviderSessionId,
      startMode: parentProviderSessionId ? "fork" : "fresh",
      activeSubmissionId: null,
      lastSubmissionId: null,
      lastReply: null,
      lastError: null,
      idempotency: {},
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    await this.persistSession(session);
    await this.eventStore.append("session.created", { sessionKey: key, driver: normalizedDriver });
    await this.launch(session);
    return publicSession(session);
  }

  async handleKnownStartupScreen(session, screen, previousAction) {
    const recent = recentScreen(screen);
    let action = null;
    if (session.driver === "claude") {
      if (/WARNING: Claude Code running in Bypass Permissions mode/i.test(recent)) action = "2";
      else if (/Try the new fullscreen renderer\?/i.test(recent)) action = "2";
      else if (/Choose the text style|Security notes|Quick safety check/i.test(recent)) action = "Enter";
    } else {
      if (/Do you trust the contents of this directory\?/i.test(recent)) action = "1";
      else if (/update available/i.test(recent) && /skip/i.test(recent)) action = "2";
    }
    if (!action || action === previousAction) return null;
    if (/^[0-9]$/.test(action)) {
      await this.tmux.sendLiteral(session.tmuxSessionName, action);
      await this.tmux.sendKey(session.tmuxSessionName, "Enter");
    } else {
      await this.tmux.sendKey(session.tmuxSessionName, action);
    }
    return action;
  }

  async waitUntilReady(session) {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastScreen = "";
    let previousAction = null;
    let nextNavigationAt = Date.now() + 2000;
    let navigationAttempt = 0;
    while (Date.now() < deadline) {
      try { lastScreen = await this.tmux.capture(session.tmuxSessionName, 120); } catch (err) {
        return { status: "failed", error: err.message };
      }
      const exitCode = driverExit(lastScreen);
      if (exitCode !== null) return { status: "failed", error: `driver exited during startup (${exitCode})`, screen: lastScreen };
      if (isAuthRequired(session.driver, lastScreen)) return { status: "auth_required", screen: lastScreen };
      if (isReady(session.driver, lastScreen)) {
        const probe = await this.probeReadyInput(session);
        if (probe.ok) return { status: "ready", screen: probe.screen };
      }
      const action = await this.handleKnownStartupScreen(session, lastScreen, previousAction);
      if (action) previousAction = action;
      else {
        previousAction = null;
        if (this.navigator?.enabled && Date.now() >= nextNavigationAt) {
          navigationAttempt += 1;
          try {
            const decision = await this.navigator.decide({
              driver: session.driver,
              phase: "session_start",
              goal: "Reach the driver's empty prompt, identify authentication, or report a terminal failure.",
              screen: lastScreen,
              sessionKey: session.sessionKey,
              attempt: navigationAttempt,
            });
            if (decision?.action === "auth_required") return { status: "auth_required", screen: lastScreen };
            if (decision?.action === "fail") return { status: "failed", error: decision.reason || "navigation failed", screen: lastScreen };
            await this.navigator.apply(this.tmux, session.tmuxSessionName, decision);
          } catch (err) {
            await this.eventStore.append("navigation.error", {
              sessionKey: session.sessionKey,
              driver: session.driver,
              phase: "session_start",
              error: tailText(err.message || String(err), 2000),
            });
          }
          nextNavigationAt = Date.now() + 2000;
        }
      }
      await sleep(250);
    }
    return {
      status: "attention_required",
      error: `terminal did not become ready before startup timeout: ${tailText(recentScreen(lastScreen, 20), 3000)}`,
      screen: recentScreen(lastScreen, 40),
    };
  }

  async probeReadyInput(session) {
    const marker = `p${crypto.randomBytes(3).toString("hex")}`;
    await this.tmux.sendKey(session.tmuxSessionName, "C-u");
    await this.tmux.sendLiteral(session.tmuxSessionName, marker);
    const deadline = Date.now() + 2500;
    let screen = "";
    while (Date.now() < deadline) {
      screen = await this.tmux.capture(session.tmuxSessionName, 80);
      if (screen.includes(marker)) {
        await this.tmux.sendKey(session.tmuxSessionName, "C-u");
        await sleep(100);
        return { ok: true, screen: await this.tmux.capture(session.tmuxSessionName, 80) };
      }
      await sleep(100);
    }
    await this.tmux.sendKey(session.tmuxSessionName, "C-u").catch(() => {});
    return { ok: false, error: "terminal input probe was not visible", screen };
  }

  async launch(session) {
    await this.tmux.kill(session.tmuxSessionName);
    await this.tmux.createShell(session.tmuxSessionName, session.workspace);
    const launch = buildLaunch(this.config, session);
    await this.tmux.startCommand(session.tmuxSessionName, launch.command, launch.args, launch.env);
    const ready = await this.waitUntilReady(session);
    session.status = ready.status;
    session.lastError = ready.error || null;
    await this.persistSession(session);
    await this.eventStore.append(`session.${ready.status}`, {
      sessionKey: session.sessionKey,
      driver: session.driver,
      error: ready.error || null,
    });
    return publicSession(session);
  }

  async submit(sessionKey, { message, idempotencyKey = null, timeoutMs = null } = {}) {
    const session = this.rawSession(sessionKey);
    const prompt = String(message || "").trim();
    if (!prompt) throw new Error("message required");
    const idempotency = String(idempotencyKey || "").trim();
    if (idempotency && session.idempotency?.[idempotency]) {
      const prior = await this.getSubmission(session.idempotency[idempotency]);
      if (prior) return prior;
    }
    if (this.active.has(session.sessionKey) || session.activeSubmissionId) {
      const err = new Error("session already has an active submission");
      err.code = "SESSION_BUSY";
      throw err;
    }
    if (session.status !== "ready") {
      const err = new Error(`session is not ready: ${session.status}`);
      err.code = session.status === "auth_required" ? "AUTH_REQUIRED" : "SESSION_NOT_READY";
      throw err;
    }
    if (!await this.tmux.has(session.tmuxSessionName)) {
      session.status = "stopped";
      await this.persistSession(session);
      throw new Error("terminal session is not running; restart it before submitting");
    }

    const submissionId = createId("sub");
    const marker = `<cli-runtime-submission id="${submissionId}"/>`;
    const submittedPrompt = `${normalizePrompt(prompt)} ${marker}`;
    const submission = {
      version: 1,
      submissionId,
      sessionKey: session.sessionKey,
      status: "accepted",
      marker,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : this.config.submissionTimeoutMs,
      reply: null,
      error: null,
      progress: null,
      acceptedAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    const controller = new AbortController();
    const activeRuntime = { submission, controller, interrupted: false };
    this.active.set(session.sessionKey, activeRuntime);
    session.status = "running";
    session.activeSubmissionId = submissionId;
    session.lastError = null;
    if (idempotency) {
      session.idempotency = { ...(session.idempotency || {}), [idempotency]: submissionId };
      const keys = Object.keys(session.idempotency);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete session.idempotency[key];
    }
    await this.persistSubmission(submission);
    await this.persistSession(session);
    await this.eventStore.append("submission.accepted", { sessionKey: session.sessionKey, submissionId });
    setImmediate(() => this.executeSubmission(session, submission, submittedPrompt, activeRuntime).catch(() => {}));
    return publicSubmission(submission);
  }

  async monitorTerminal(session, signal) {
    while (!signal.aborted) {
      let screen;
      try { screen = await this.tmux.capture(session.tmuxSessionName, 80); } catch (err) {
        throw new Error(`terminal unavailable: ${err.message}`);
      }
      const exitCode = driverExit(screen);
      if (exitCode !== null) throw new Error(`driver exited (${exitCode})`);
      if (isAuthRequired(session.driver, screen)) {
        const err = new Error("driver authentication required");
        err.code = "AUTH_REQUIRED";
        throw err;
      }
      await sleep(400);
    }
    return null;
  }

  async confirmSubmission(session, observed, signal) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (signal.aborted) throw new Error("submission interrupted");
      await this.tmux.sendKey(session.tmuxSessionName, "Enter");
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error("submission interrupted");
        if (observed.bound) return;
        const screen = await this.tmux.capture(session.tmuxSessionName, 80);
        const exitCode = driverExit(screen);
        if (exitCode !== null) throw new Error(`driver exited (${exitCode})`);
        if (isAuthRequired(session.driver, screen)) {
          const err = new Error("driver authentication required");
          err.code = "AUTH_REQUIRED";
          throw err;
        }
        await sleep(100);
      }
    }
    throw new Error("driver did not accept prompt after 3 submission attempts");
  }

  async executeSubmission(session, submission, submittedPrompt, activeRuntime) {
    const { controller } = activeRuntime;
    const rootDir = artifactRoot(this.config, session.driver);
    const baseline = await baselineArtifacts(rootDir);
    const promptPath = this.promptPath(session.sessionKey, submission.submissionId);
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(promptPath, submittedPrompt, { encoding: "utf8", mode: 0o600 });
    submission.status = "running";
    submission.startedAt = nowIso();
    await this.persistSubmission(submission);
    await this.eventStore.append("submission.started", {
      sessionKey: session.sessionKey,
      submissionId: submission.submissionId,
    });

    const monitorController = new AbortController();
    const watchController = new AbortController();
    const observed = { bound: false };
    const forwardInterrupt = () => watchController.abort();
    controller.signal.addEventListener("abort", forwardInterrupt, { once: true });
    try {
      const artifactPromise = watchArtifacts({
        driver: session.driver,
        rootDir,
        baseline,
        marker: submission.marker,
        timeoutMs: submission.timeoutMs,
        pollMs: this.config.artifactPollMs,
        signal: watchController.signal,
        onBound: ({ artifactPath, providerSessionId }) => {
          observed.bound = true;
          submission.progress = publicProgress({
            ...(submission.progress || {}),
            artifactPath,
            providerSessionId,
          });
        },
        onProgress: async (progress) => {
          submission.progress = publicProgress(progress);
          await this.persistSubmission(submission);
          await this.eventStore.append("submission.progress", {
            sessionKey: session.sessionKey,
            submissionId: submission.submissionId,
            progress: publicProgress(progress),
          });
        },
      });
      artifactPromise.catch(() => {});
      const terminalPromise = this.monitorTerminal(session, monitorController.signal);
      terminalPromise.catch(() => {});
      await this.tmux.sendKey(session.tmuxSessionName, "C-u");
      await this.tmux.pasteFile(
        session.tmuxSessionName,
        promptPath,
        `prompt-${safeId(submission.submissionId, 16)}`,
      );
      await sleep(100);
      await this.confirmSubmission(session, observed, controller.signal);
      const result = await Promise.race([artifactPromise, terminalPromise]);
      monitorController.abort();
      watchController.abort();
      if (!result?.terminal) throw new Error("terminal monitor ended before driver completion");
      submission.progress = publicProgress(result);
      submission.reply = tailText(result.reply || "", 200_000);
      submission.error = result.ok ? null : tailText(result.error || "driver turn failed", 20_000);
      submission.status = result.ok ? "completed" : "failed";
      submission.completedAt = nowIso();
      if (result.providerSessionId) session.providerSessionId = result.providerSessionId;
      session.status = "ready";
      session.lastReply = tailText(submission.reply || "", 200_000) || null;
      session.lastError = submission.error;
      session.activeSubmissionId = null;
      session.lastSubmissionId = submission.submissionId;
      session.startMode = session.providerSessionId ? "resume" : "fresh";
      await this.persistSubmission(submission);
      await this.persistSession(session);
      await this.eventStore.append(`submission.${submission.status}`, {
        sessionKey: session.sessionKey,
        submissionId: submission.submissionId,
        reply: tailText(submission.reply || "", 20_000),
        error: submission.error,
      });
    } catch (err) {
      monitorController.abort();
      watchController.abort();
      submission.status = activeRuntime.interrupted ? "interrupted" : "failed";
      submission.error = tailText(err.message || String(err), 20_000);
      submission.completedAt = nowIso();
      if (session.status !== "closing" && session.status !== "closed") {
        session.status = err.code === "AUTH_REQUIRED" ? "auth_required" : "attention_required";
        session.lastError = submission.error;
        session.activeSubmissionId = null;
        session.lastSubmissionId = submission.submissionId;
      }
      await this.persistSubmission(submission);
      if (session.status !== "closing" && session.status !== "closed") await this.persistSession(session);
      await this.eventStore.append(`submission.${submission.status}`, {
        sessionKey: session.sessionKey,
        submissionId: submission.submissionId,
        error: submission.error,
      });
    } finally {
      controller.signal.removeEventListener("abort", forwardInterrupt);
      this.active.delete(session.sessionKey);
    }
  }

  async getSubmission(submissionId) {
    return publicSubmission(await readJson(this.submissionPath(submissionId), null));
  }

  async output(sessionKey) {
    const session = this.rawSession(sessionKey);
    const submissionId = session.activeSubmissionId || session.lastSubmissionId;
    let screen = "";
    if (await this.tmux.has(session.tmuxSessionName)) {
      screen = await this.tmux.capture(session.tmuxSessionName, 100).catch(() => "");
    }
    return {
      session: publicSession(session),
      submission: submissionId ? await this.getSubmission(submissionId) : null,
      terminal: tailText(recentScreen(screen, 60), 16_000),
    };
  }

  async interrupt(sessionKey) {
    const session = this.rawSession(sessionKey);
    const active = this.active.get(session.sessionKey);
    if (!active) return { ok: true, interrupted: false, session: publicSession(session) };
    await this.tmux.interrupt(session.tmuxSessionName).catch(() => {});
    active.interrupted = true;
    active.controller.abort();
    await this.eventStore.append("session.interrupt_requested", {
      sessionKey: session.sessionKey,
      submissionId: active.submission.submissionId,
    });
    return { ok: true, interrupted: true, submissionId: active.submission.submissionId };
  }

  async restart(sessionKey) {
    const session = this.rawSession(sessionKey);
    if (this.active.has(session.sessionKey)) throw new Error("cannot restart a session with an active submission");
    session.status = "starting";
    session.startMode = session.providerSessionId ? "resume" : "fresh";
    session.lastError = null;
    await this.persistSession(session);
    await this.eventStore.append("session.restart_requested", { sessionKey: session.sessionKey });
    return this.launch(session);
  }

  async close(sessionKey) {
    const session = this.rawSession(sessionKey);
    const active = this.active.get(session.sessionKey);
    session.status = "closing";
    await this.persistSession(session);
    if (active) {
      active.interrupted = true;
      active.controller.abort();
    }
    await this.tmux.kill(session.tmuxSessionName);
    session.status = "closed";
    session.activeSubmissionId = null;
    await this.persistSession(session);
    await this.eventStore.append("session.closed", { sessionKey: session.sessionKey });
    return publicSession(session);
  }

  async attachInfo(sessionKey) {
    const session = this.rawSession(sessionKey);
    return {
      sessionKey: session.sessionKey,
      running: await this.tmux.has(session.tmuxSessionName),
      command: this.tmux.attachCommand(session.tmuxSessionName),
    };
  }
}

module.exports = {
  SessionManager,
  publicSession,
  publicSubmission,
};
