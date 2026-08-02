"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  artifactRoot,
  buildLaunch,
  isReady,
  isStartupAuthScreen,
  normalizeDriver,
  normalizePrompt,
  recentScreen,
} = require("./drivers");
const { baselineArtifacts, publicProgress, watchArtifacts } = require("./artifacts");
const { createId, nowIso, readJson, safeId, sleep, sleepWithSignal, tailText, writeAtomic } = require("./util");
const { WorkspaceState } = require("./workspace-state");

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
    progress: publicProgress(submission.progress, submission.status),
    inputs: Array.isArray(submission.inputs) ? submission.inputs : [],
    outputs: (Array.isArray(submission.outputs) ? submission.outputs : []).map((output) => ({
      outputId: output.outputId,
      originalName: output.originalName,
      mimeType: output.mimeType,
      size: output.size,
      path: output.path,
      archivePath: output.archivePath,
      deliveryStatus: output.deliveryStatus,
      deliveredAt: output.deliveredAt || null,
    })),
    outputError: tailText(submission.outputError || "", 4000) || null,
    artifactPath: submission.artifactPath || null,
    artifactStartOffset: Number.isFinite(submission.artifactStartOffset) ? submission.artifactStartOffset : null,
    artifactEndOffset: Number.isFinite(submission.artifactEndOffset) ? submission.artifactEndOffset : null,
    acceptedAt: submission.acceptedAt,
    startedAt: submission.startedAt || null,
    completedAt: submission.completedAt || null,
  };
}

class SessionManager {
  constructor({ config, tmux, eventStore, navigator = null, workspaceState = null }) {
    this.config = config;
    this.tmux = tmux;
    this.eventStore = eventStore;
    this.navigator = navigator;
    this.workspaceState = workspaceState || new WorkspaceState({ config, eventStore });
    this.sessionsDir = path.join(config.stateDir, "sessions");
    this.submissionsDir = path.join(config.stateDir, "submissions");
    this.sessions = new Map();
    this.active = new Map();
  }

  sessionState(session) {
    const active = this.active.get(session.sessionKey) || null;
    return {
      status: session.status,
      busy: Boolean(active) || ["preparing", "submitting", "running", "interrupting"].includes(session.status),
      active,
    };
  }

  assertSessionInvariant(session) {
    const active = this.active.get(session.sessionKey) || null;
    const busy = ["preparing", "submitting", "running", "interrupting"].includes(session.status);
    const hasId = Boolean(session.activeSubmissionId);
    if (Boolean(active) !== busy || busy !== hasId) {
      const error = new Error(`invalid session lifecycle: ${session.status}, active=${Boolean(active)}, submission=${hasId}`);
      error.code = "SESSION_INVARIANT_VIOLATION";
      throw error;
    }
    if (active && active.submission.submissionId !== session.activeSubmissionId) {
      throw Object.assign(new Error("active submission identity mismatch"), { code: "SESSION_INVARIANT_VIOLATION" });
    }
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
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readJson(path.join(this.sessionsDir, entry.name, "session.json"), null);
      if (!record?.sessionKey) continue;
      if (record.activeSubmissionId) {
        const submissionId = record.activeSubmissionId;
        const submission = await readJson(this.submissionPath(submissionId), null);
        if (submission && ["accepted", "preparing", "submitting", "running", "interrupting"].includes(submission.status)) {
          submission.status = "failed";
          submission.error = "runtime restarted while the submission was active";
          submission.completedAt = nowIso();
          await this.finishWorkspaceTurn(record, submission);
          await this.persistSubmission(submission);
          await this.eventStore.append(`submission.${submission.status}`, {
            sessionKey: record.sessionKey,
            submissionId,
            error: submission.error || null,
          });
        }
        record.status = submission?.status === "completed" ? "ready" : "attention_required";
        record.lastError = submission?.status === "completed" ? null : "runtime restarted while a submission was active";
        record.activeSubmissionId = null;
        record.lastSubmissionId = submissionId;
        record.updatedAt = nowIso();
        await writeAtomic(this.sessionPath(record.sessionKey), record);
      }
      this.sessions.set(record.sessionKey, record);
    }
  }

  async persistSession(session) {
    this.assertSessionInvariant(session);
    session.updatedAt = nowIso();
    await writeAtomic(this.sessionPath(session.sessionKey), session);
  }

  async persistSubmission(submission) {
    await writeAtomic(this.submissionPath(submission.submissionId), submission);
  }

  async finalizeSubmission(session, submission, fields) {
    const finalized = { ...submission, ...fields };
    await this.finishWorkspaceTurn(session, finalized);
    Object.assign(submission, finalized);
    await this.persistSubmission(submission);
  }

  async list() {
    return [...this.sessions.values()].map(publicSession);
  }

  async driverRunning(session) {
    if (!await this.tmux.has(session.tmuxSessionName)) return false;
    if (typeof this.tmux.driverState !== "function") return true;
    const state = await this.tmux.driverState(session.tmuxSessionName).catch(() => ({ paneDead: true }));
    return !state.paneDead;
  }

  async get(sessionKey, { refresh = true } = {}) {
    const session = this.sessions.get(String(sessionKey || ""));
    if (!session) return null;
    if (refresh && session.status !== "closed" && !this.sessionState(session).busy) {
      if (!await this.driverRunning(session)) {
        session.status = "stopped";
        session.lastError = session.lastError || "driver process is not running";
        await this.persistSession(session);
      }
    }
    return publicSession(session);
  }

  rawSession(sessionKey) {
    const session = this.sessions.get(String(sessionKey || ""));
    if (!session) {
      const error = new Error(`session not found: ${sessionKey}`);
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    return session;
  }

  async create({ sessionKey, driver, workspace, forkFromSessionKey = null } = {}) {
    const key = String(sessionKey || "").trim();
    if (!key) throw new Error("sessionKey required");
    const normalizedDriver = normalizeDriver(driver);
    const requestedWorkspace = path.resolve(String(workspace || "").trim());
    const resolvedWorkspace = await fs.realpath(requestedWorkspace).catch(() => requestedWorkspace);
    const stat = await fs.stat(resolvedWorkspace).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`workspace is not a directory: ${resolvedWorkspace}`);
    await this.workspaceState.ensure(resolvedWorkspace);

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
      const processState = await this.tmux.driverState(session.tmuxSessionName).catch((err) => ({ error: err }));
      if (processState.error) return { status: "failed", error: processState.error.message };
      if (processState.paneDead) {
        return { status: "failed", error: `driver exited during startup (${processState.exitCode ?? "unknown"})`, screen: lastScreen };
      }
      try { lastScreen = await this.tmux.capture(session.tmuxSessionName, 120); } catch (err) {
        return { status: "failed", error: err.message };
      }
      if (isStartupAuthScreen(session.driver, lastScreen)) return { status: "auth_required", screen: lastScreen };
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

  async submit(sessionKey, { message, inputs = [], idempotencyKey = null, timeoutMs = null } = {}) {
    const session = this.rawSession(sessionKey);
    const prompt = String(message || "").trim();
    const inputDescriptors = Array.isArray(inputs) ? inputs : [];
    if (!prompt && inputDescriptors.length === 0) throw new Error("message or input file required");
    const idempotency = String(idempotencyKey || "").trim();
    if (idempotency && session.idempotency?.[idempotency]) {
      const prior = await this.getSubmission(session.idempotency[idempotency]);
      if (prior) return prior;
    }
    if (this.sessionState(session).busy) {
      const err = new Error("session already has an active submission");
      err.code = "SESSION_BUSY";
      throw err;
    }
    if (session.status === "ready" && !await this.driverRunning(session)) {
      session.status = "stopped";
      session.lastError = "driver process is not running";
      await this.persistSession(session);
    }
    if (session.status !== "ready") {
      const err = new Error(`session is not ready: ${session.status}`);
      err.code = session.status === "auth_required" ? "AUTH_REQUIRED" : "SESSION_NOT_READY";
      throw err;
    }
    const submissionId = createId("sub");
    const marker = `<cli-runtime-submission id="${submissionId}"/>`;
    const acceptedAt = nowIso();
    const submission = {
      version: 1,
      submissionId,
      sessionKey: session.sessionKey,
      status: "accepted",
      driver: session.driver,
      workspace: session.workspace,
      message: prompt,
      inputs: [],
      outputs: [],
      outputError: null,
      marker,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : this.config.submissionTimeoutMs,
      reply: null,
      error: null,
      progress: null,
      artifactPath: null,
      artifactStartOffset: null,
      artifactEndOffset: null,
      acceptedAt,
      startedAt: null,
      completedAt: null,
    };
    const controller = new AbortController();
    const activeRuntime = { submission, controller, interrupted: false, phase: "preparing" };
    this.active.set(session.sessionKey, activeRuntime);
    session.activeSubmissionId = submissionId;
    session.lastError = null;
    session.status = "preparing";
    if (idempotency) {
      session.idempotency = { ...(session.idempotency || {}), [idempotency]: submissionId };
      const keys = Object.keys(session.idempotency);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete session.idempotency[key];
    }
    this.assertSessionInvariant(session);
    try {
      await this.persistSubmission(submission);
      await this.persistSession(session);
      await this.eventStore.append("submission.accepted", { sessionKey: session.sessionKey, submissionId });
      const prepared = await this.workspaceState.startTurn({
        workspace: session.workspace,
        sessionKey: session.sessionKey,
        submissionId,
        driver: session.driver,
        message: prompt,
        inputs: inputDescriptors,
        acceptedAt,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw Object.assign(new Error("submission interrupted"), { code: "SUBMISSION_INTERRUPTED" });
      const userPrompt = prompt || "Review the attached input file(s) and respond appropriately.";
      const submittedPrompt = `${normalizePrompt(`${userPrompt}${prepared.promptContext}`)} ${marker}`;
      submission.inputs = prepared.inputs;
      activeRuntime.phase = "submitting";
      session.status = "submitting";
      await this.persistSubmission(submission);
      await this.persistSession(session);
      activeRuntime.completion = new Promise((resolve) => setImmediate(() => this.executeSubmission(
        session,
        submission,
        submittedPrompt,
        activeRuntime,
      ).catch((err) => this.failUnexpectedExecution(session, submission, activeRuntime, err)).finally(resolve)));
      return publicSubmission(submission);
    } catch (err) {
      if (this.active.get(session.sessionKey) === activeRuntime) {
        const status = activeRuntime.interrupted || err.code === "SUBMISSION_INTERRUPTED" ? "interrupted" : "failed";
        const error = tailText(err.message || String(err), 20_000);
        await this.finalizeSubmission(session, submission, {
          status,
          error,
          completedAt: nowIso(),
        }).catch(() => {});
        this.active.delete(session.sessionKey);
        session.activeSubmissionId = null;
        session.lastSubmissionId = submissionId;
        session.status = status === "interrupted" ? "ready" : "attention_required";
        session.lastError = status === "interrupted" ? null : error;
        await this.persistSession(session).catch(() => {});
        await this.eventStore.append(`submission.${status}`, {
          sessionKey: session.sessionKey,
          submissionId,
          error,
        }).catch(() => {});
      }
      throw err;
    }
  }

  async monitorDriverProcess(session, signal) {
    while (!signal.aborted) {
      let state;
      try { state = await this.tmux.driverState(session.tmuxSessionName); } catch (err) {
        throw new Error(`terminal unavailable: ${err.message}`);
      }
      if (state.paneDead) return { processExited: true, exitCode: state.exitCode };
      await sleepWithSignal(400, signal);
    }
    return null;
  }

  async failUnexpectedExecution(session, submission, activeRuntime, error) {
    if (this.active.get(session.sessionKey) !== activeRuntime) return;
    const status = activeRuntime.interrupted ? "interrupted" : "failed";
    const failure = tailText(error.message || String(error), 20_000);
    await this.finalizeSubmission(session, submission, {
      status,
      error: failure,
      completedAt: nowIso(),
    });
    this.active.delete(session.sessionKey);
    session.activeSubmissionId = null;
    session.lastSubmissionId = submission.submissionId;
    session.status = status === "interrupted" ? "ready" : "attention_required";
    session.lastError = status === "interrupted" ? null : failure;
    await this.persistSession(session);
    await this.eventStore.append(`submission.${submission.status}`, {
      sessionKey: session.sessionKey,
      submissionId: submission.submissionId,
      error: submission.error,
    });
  }

  async confirmSubmission(session, observed, signal) {
    await this.tmux.sendKey(session.tmuxSessionName, "Enter");
    const deadline = Date.now() + (this.config.bindTimeoutMs || 15_000);
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("submission interrupted");
      if (observed.bound) return;
      const state = await this.tmux.driverState(session.tmuxSessionName);
      if (state.paneDead) {
        throw new Error(`driver exited (${state.exitCode ?? "unknown"}) before accepting prompt`);
      }
      await sleep(100);
    }
    throw new Error("driver did not accept prompt before bind timeout");
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
    await this.updateWorkspaceTurn({
      workspace: session.workspace,
      sessionKey: session.sessionKey,
      submissionId: submission.submissionId,
      progress: submission.progress,
      status: "running",
      startedAt: submission.startedAt,
    });
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
    let artifactPromise = null;
    let terminalPromise = null;
    try {
      artifactPromise = watchArtifacts({
        driver: session.driver,
        rootDir,
        baseline,
        marker: submission.marker,
        timeoutMs: submission.timeoutMs,
        pollMs: this.config.artifactPollMs,
        signal: watchController.signal,
        onBound: async ({ artifactPath, providerSessionId }) => {
          observed.bound = true;
          submission.artifactPath = artifactPath;
          submission.artifactStartOffset = baseline.get(artifactPath) || 0;
          submission.progress = publicProgress({
            ...(submission.progress || {}),
            artifactPath,
            providerSessionId,
          });
          await this.updateWorkspaceTurn({
            workspace: session.workspace,
            sessionKey: session.sessionKey,
            submissionId: submission.submissionId,
            progress: submission.progress,
            status: "running",
            startedAt: submission.startedAt,
          });
        },
        onProgress: async (progress) => {
          submission.progress = publicProgress(progress);
          await this.updateWorkspaceTurn({
            workspace: session.workspace,
            sessionKey: session.sessionKey,
            submissionId: submission.submissionId,
            progress: submission.progress,
            status: "running",
            startedAt: submission.startedAt,
          });
          await this.eventStore.append("submission.progress", {
            sessionKey: session.sessionKey,
            submissionId: submission.submissionId,
            progress: submission.progress,
          });
        },
      });
      artifactPromise.catch(() => {});
      terminalPromise = this.monitorDriverProcess(session, monitorController.signal);
      terminalPromise.catch(() => {});
      await this.tmux.sendKey(session.tmuxSessionName, "C-u");
      await this.tmux.pasteFile(
        session.tmuxSessionName,
        promptPath,
        `prompt-${safeId(submission.submissionId, 16)}`,
      );
      await sleep(100);
      await this.confirmSubmission(session, observed, controller.signal);
      activeRuntime.phase = "running";
      session.status = "running";
      await this.persistSession(session);
      let result = await Promise.race([artifactPromise, terminalPromise]);
      if (result?.processExited) {
        const drained = await Promise.race([artifactPromise, sleep(1000).then(() => null)]);
        if (drained?.terminal) result = drained;
        else throw new Error(`driver exited (${result.exitCode ?? "unknown"})`);
      }
      monitorController.abort();
      watchController.abort();
      await Promise.allSettled([artifactPromise, terminalPromise]);
      if (!result?.terminal) throw new Error("terminal monitor ended before driver completion");
      if (this.active.get(session.sessionKey) !== activeRuntime || session.status === "closed") {
        throw Object.assign(new Error("submission interrupted"), { code: "SUBMISSION_INTERRUPTED" });
      }
      const progress = publicProgress(result);
      const reply = tailText(result.reply || "", 200_000);
      const error = result.ok ? null : tailText(result.error || "driver turn failed", 20_000);
      const status = result.ok ? "completed" : "failed";
      const artifactPath = result.artifactPath || submission.artifactPath || progress?.artifactPath || null;
      const artifactEndOffset = result.throughOffset || progress?.throughOffset || null;
      if (result.providerSessionId) session.providerSessionId = result.providerSessionId;
      session.startMode = session.providerSessionId ? "resume" : "fresh";
      await this.finalizeSubmission(session, submission, {
        progress,
        reply,
        error,
        status,
        completedAt: nowIso(),
        artifactPath,
        artifactEndOffset,
      });
      this.active.delete(session.sessionKey);
      session.status = result.kind === "auth_required" ? "auth_required" : "ready";
      session.lastReply = reply || null;
      session.lastError = error;
      session.activeSubmissionId = null;
      session.lastSubmissionId = submission.submissionId;
      await this.persistSession(session);
      await this.eventStore.append(`submission.${submission.status}`, {
        sessionKey: session.sessionKey,
        submissionId: submission.submissionId,
        reply: tailText(submission.reply || "", 20_000),
        error: submission.error,
      });
      this.scheduleOperationalPrune();
    } catch (err) {
      monitorController.abort();
      watchController.abort();
      await Promise.allSettled([artifactPromise, terminalPromise].filter(Boolean));
      const status = activeRuntime.interrupted || err.code === "SUBMISSION_INTERRUPTED" ? "interrupted" : "failed";
      const error = tailText(err.message || String(err), 20_000);
      await this.finalizeSubmission(session, submission, {
        status,
        error,
        completedAt: nowIso(),
        artifactPath: submission.artifactPath || submission.progress?.artifactPath || null,
        artifactEndOffset: submission.progress?.throughOffset || null,
      });
      this.active.delete(session.sessionKey);
      if (session.status !== "closed") {
        session.status = status === "interrupted" ? "ready"
          : err.code === "AUTH_REQUIRED" ? "auth_required" : "attention_required";
        session.lastError = status === "interrupted" ? null : error;
        session.activeSubmissionId = null;
        session.lastSubmissionId = submission.submissionId;
      }
      if (session.status !== "closed") await this.persistSession(session);
      await this.eventStore.append(`submission.${submission.status}`, {
        sessionKey: session.sessionKey,
        submissionId: submission.submissionId,
        error: submission.error,
      });
      this.scheduleOperationalPrune();
    } finally {
      controller.signal.removeEventListener("abort", forwardInterrupt);
      this.active.delete(session.sessionKey);
      this.assertSessionInvariant(session);
    }
  }

  async getSubmission(submissionId) {
    for (const active of this.active.values()) {
      if (active.submission.submissionId === submissionId) return publicSubmission(active.submission);
    }
    return publicSubmission(await readJson(this.submissionPath(submissionId), null));
  }

  scheduleOperationalPrune() {
    if (this.prunePending) return;
    this.prunePending = true;
    setImmediate(() => this.pruneOperationalState().catch((err) => this.eventStore.append("runtime.prune_failed", {
      error: tailText(err.message || String(err), 4000),
    }).catch(() => {})).finally(() => { this.prunePending = false; }));
  }

  async pruneOperationalState() {
    const entries = await fs.readdir(this.submissionsDir, { withFileTypes: true }).catch(() => []);
    const terminal = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.submissionsDir, entry.name);
      const record = await readJson(filePath, null);
      if (!record || !["completed", "failed", "interrupted"].includes(record.status)) continue;
      terminal.push({ filePath, submissionId: record.submissionId, at: Date.parse(record.completedAt || record.acceptedAt) || 0 });
    }
    terminal.sort((a, b) => b.at - a.at);
    for (const item of terminal.slice(1000)) {
      await fs.rm(item.filePath, { force: true });
      const sessionDirs = await fs.readdir(this.sessionsDir, { withFileTypes: true }).catch(() => []);
      for (const dir of sessionDirs) {
        if (dir.isDirectory()) await fs.rm(path.join(this.sessionsDir, dir.name, "prompts", `${safeId(item.submissionId, 40)}.txt`), { force: true });
      }
    }
  }

  async finishWorkspaceTurn(session, submission) {
    try {
      const finished = await this.workspaceState.finishTurn({
        workspace: session.workspace,
        sessionKey: session.sessionKey,
        submission,
        driver: session.driver,
        progress: submission.progress,
      });
      if (finished.reused) {
        const record = finished.record;
        submission.status = record.status;
        submission.reply = record.assistant?.text || null;
        submission.error = record.failure || null;
        submission.completedAt = record.completedAt;
        submission.progress = {
          providerSessionId: record.providerSessionId || null,
          reasoning: Array.isArray(record.reasoning) ? record.reasoning : [],
          toolUses: (Array.isArray(record.tools) ? record.tools : []).map((tool) => ({
            id: tool.id,
            tool: tool.tool,
            success: tool.success,
            error: tool.error,
          })),
          lastAssistantMessage: record.assistant?.text || "",
        };
      }
      submission.outputs = finished.outputs;
      submission.outputError = finished.outputError;
      return finished;
    } catch (err) {
      submission.outputError = tailText(err.message || String(err), 4000);
      await this.eventStore.append("workspace.turn_state_failed", {
        sessionKey: session.sessionKey,
        submissionId: submission.submissionId,
        error: submission.outputError,
      }).catch(() => {});
      return null;
    }
  }

  async updateWorkspaceTurn(options) {
    try {
      return await this.workspaceState.updateTurn(options);
    } catch (err) {
      await this.eventStore.append("workspace.turn_state_failed", {
        sessionKey: options.sessionKey || null,
        submissionId: options.submissionId,
        error: tailText(err.message || String(err), 4000),
      }).catch(() => {});
      return null;
    }
  }

  async acknowledgeOutputs(submissionId, outputIds = null) {
    const submission = await readJson(this.submissionPath(submissionId), null);
    if (!submission) return null;
    const workspace = submission.workspace || this.rawSession(submission.sessionKey).workspace;
    submission.outputs = await this.workspaceState.acknowledgeOutputs({
      workspace,
      sessionKey: submission.sessionKey,
      submissionId,
      outputs: submission.outputs,
      outputIds,
    });
    await this.persistSubmission(submission);
    return publicSubmission(submission);
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
    if (!active) return { ok: true, interrupted: false, reason: "no active submission", session: publicSession(session) };
    const phase = active.phase;
    session.status = "interrupting";
    active.phase = "interrupting";
    active.interrupted = true;
    active.controller.abort();
    await this.persistSession(session);
    if (phase !== "preparing") await this.tmux.interrupt(session.tmuxSessionName).catch(() => {});
    await this.eventStore.append("session.interrupt_requested", {
      sessionKey: session.sessionKey,
      submissionId: active.submission.submissionId,
    });
    return { ok: true, interrupted: true, submissionId: active.submission.submissionId };
  }

  async restart(sessionKey) {
    const session = this.rawSession(sessionKey);
    if (this.sessionState(session).busy) {
      throw new Error("cannot restart a session with an active submission");
    }
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
    if (active) {
      await this.interrupt(sessionKey);
      const settled = active.completion || (async () => {
        while (this.active.get(session.sessionKey) === active) await sleep(50);
      })();
      await Promise.race([settled, sleep(10_000)]);
    }
    await this.tmux.kill(session.tmuxSessionName);
    const remaining = this.active.get(session.sessionKey);
    if (remaining) {
      remaining.interrupted = true;
      remaining.controller.abort();
      remaining.submission.status = "interrupted";
      remaining.submission.error = "submission interrupted while closing session";
      remaining.submission.completedAt = nowIso();
      await this.finishWorkspaceTurn(session, remaining.submission);
      await this.persistSubmission(remaining.submission);
      await this.eventStore.append("submission.interrupted", {
        sessionKey: session.sessionKey,
        submissionId: remaining.submission.submissionId,
        error: remaining.submission.error,
      });
      this.active.delete(session.sessionKey);
    }
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
      running: await this.driverRunning(session),
      command: this.tmux.attachCommand(session.tmuxSessionName),
    };
  }
}

module.exports = {
  SessionManager,
  publicSession,
  publicSubmission,
};
