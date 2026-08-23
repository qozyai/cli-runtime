"use strict";

const path = require("node:path");
const { redactText } = require("../core/progress");
const { tailText } = require("../core/util");
const { OpenAINavigation } = require("./openai-navigation");
const { ScreenLibrary, compilePattern } = require("./screen-library");

const ACTIONS = new Set(["wait", "press_key", "submit_text", "auth_required", "fail"]);
const KEYS = new Set(["Enter", "Escape", "Tab", "Up", "Down", "Left", "Right", ...Array.from({ length: 10 }, (_, index) => String(index))]);

function normalizeDecision(value) {
  const source = value?.decision || value;
  const action = String(source?.action || "").trim();
  if (!ACTIONS.has(action)) throw new Error(`navigator returned unsupported action: ${action || "empty"}`);
  const reason = tailText(source?.reason || "", 1000) || null;
  // A bad recognition pattern must not cost the action it rode in on: the
  // pattern is dropped and only the lesson is lost. Spec 0022.
  const screenRegex = compilePattern(source?.screen_regex) ? String(source.screen_regex) : null;
  const steps = (Array.isArray(source?.steps) ? source.steps : [])
    .slice(0, 5)
    .map((step) => tailText(String(step || ""), 200))
    .filter(Boolean);
  if (action === "press_key") {
    const key = String(source?.key || "").trim();
    if (!KEYS.has(key)) throw new Error(`navigator returned unsupported key: ${key || "empty"}`);
    return { action, key, reason, steps, screenRegex };
  }
  if (action === "submit_text") {
    const text = String(source?.text || "");
    if (!text || text.length > 256 || /[\x00-\x1f\x7f]/.test(text)) throw new Error("navigator returned invalid text");
    return { action, text, reason, steps, screenRegex };
  }
  return { action, reason, steps, screenRegex };
}

class Navigator {
  // The OpenAI backend is built here rather than injected: navigation is a
  // drivers concern and must not depend on a chat surface existing. The
  // parameter remains for tests. Spec 0021.
  constructor({ config, eventStore, navigation = null, library = null, fetchImpl = fetch }) {
    this.config = config;
    this.eventStore = eventStore;
    this.navigation = navigation || new OpenAINavigation({ config, fetchImpl });
    this.library = library || (config.stateDir
      ? new ScreenLibrary({ filePath: path.join(config.stateDir, "navigation", "screens.jsonl") })
      : null);
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.navigator.url || (this.config.navigator.useOpenAI && this.navigation?.enabled));
  }

  async decide({ driver, phase, goal, screen, sessionKey = null, attempt = 1, attemptId = null }) {
    if (!this.enabled) return null;
    // The library answers before the model is paid for. A hit is a screen the
    // model was consulted about once during an attempt that then succeeded.
    const learned = this.library ? await this.library.match(driver, screen).catch(() => null) : null;
    if (learned) {
      this.eventStore?.append("navigation.decision", {
        sessionKey,
        driver,
        phase,
        action: learned.action.action,
        reason: learned.reason,
        source: "library",
        pattern: learned.pattern,
      }).catch((err) => {
        process.stderr.write(`[cli-runtime] event append failed (navigation.decision): ${err.message}\n`);
      });
      return { ...learned.action, reason: learned.reason, steps: [], screenRegex: learned.pattern, source: "library" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.navigator.timeoutMs);
    try {
      const payload = {
        version: 1,
        driver,
        phase,
        goal,
        attempt,
        screen: tailText(redactText(screen || ""), 4000),
        allowedActions: {
          wait: {},
          press_key: { keys: [...KEYS] },
          submit_text: { maxChars: 256, singleLine: true },
          auth_required: {},
          fail: {},
        },
      };
      let body;
      if (this.config.navigator.url) {
        const response = await this.fetch(this.config.navigator.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.navigator.apiKey ? { authorization: `Bearer ${this.config.navigator.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        try {
          body = await response.json();
        } catch (err) {
          if (err?.name === "AbortError" || /abort/i.test(String(err?.message || ""))) throw err;
          body = null;
        }
        if (!response.ok) throw new Error(body?.error || `navigator returned HTTP ${response.status}`);
      } else {
        body = await this.navigation.navigationDecision(payload);
      }
      const decision = normalizeDecision(body);
      // A lesson is only pending here; recordOutcome decides whether it is
      // kept. Callers that pass no attemptId read the library without ever
      // teaching it. Spec 0022.
      if (decision.screenRegex && attemptId && this.library
        && ["wait", "press_key", "submit_text"].includes(decision.action)) {
        const remembered = { action: decision.action };
        if (decision.key) remembered.key = decision.key;
        if (decision.text) remembered.text = decision.text;
        this.library.remember(attemptId, {
          driver,
          pattern: decision.screenRegex,
          action: remembered,
          reason: decision.reason,
        });
      }
      // Same rule as every other event append: observability never fails the
      // work it records. The navigation call is already paid for by this point,
      // and an unwritable event log must not discard its decision. Spec 0020.
      this.eventStore?.append("navigation.decision", {
        sessionKey,
        driver,
        phase,
        action: decision.action,
        reason: decision.reason,
        source: "model",
        pattern: decision.screenRegex,
      }).catch((err) => {
        process.stderr.write(`[cli-runtime] event append failed (navigation.decision): ${err.message}\n`);
      });
      return decision;
    } finally {
      clearTimeout(timer);
    }
  }

  // A successful attempt commits its lessons; anything else discards them.
  async recordOutcome(attemptId, success) {
    if (!attemptId || !this.library) return [];
    if (!success) {
      this.library.discard(attemptId);
      return [];
    }
    const committed = await this.library.commit(attemptId).catch((err) => {
      process.stderr.write(`[cli-runtime] screen library commit failed: ${err.message}\n`);
      return [];
    });
    if (committed.length > 0) {
      this.eventStore?.append("navigation.learned", {
        attemptId,
        patterns: committed.map((entry) => entry.pattern),
      }).catch(() => {});
    }
    return committed;
  }

  async apply(tmux, sessionName, decision) {
    if (!decision || decision.action === "wait") return;
    if (decision.action === "press_key") {
      await tmux.sendKey(sessionName, decision.key);
      return;
    }
    if (decision.action === "submit_text") {
      await tmux.sendKey(sessionName, "C-u");
      await tmux.sendLiteral(sessionName, decision.text);
      await tmux.sendKey(sessionName, "Enter");
    }
  }
}

module.exports = { Navigator, normalizeDecision };
