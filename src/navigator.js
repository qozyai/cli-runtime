"use strict";

const { redactText } = require("./progress");
const { tailText } = require("./util");

const ACTIONS = new Set(["wait", "press_key", "submit_text", "auth_required", "fail"]);
const KEYS = new Set(["Enter", "Escape", "Tab", "Up", "Down", "Left", "Right", ...Array.from({ length: 10 }, (_, index) => String(index))]);

function normalizeDecision(value) {
  const source = value?.decision || value;
  const action = String(source?.action || "").trim();
  if (!ACTIONS.has(action)) throw new Error(`navigator returned unsupported action: ${action || "empty"}`);
  const reason = tailText(source?.reason || "", 1000) || null;
  if (action === "press_key") {
    const key = String(source?.key || "").trim();
    if (!KEYS.has(key)) throw new Error(`navigator returned unsupported key: ${key || "empty"}`);
    return { action, key, reason };
  }
  if (action === "submit_text") {
    const text = String(source?.text || "");
    if (!text || text.length > 256 || /[\x00-\x1f\x7f]/.test(text)) throw new Error("navigator returned invalid text");
    return { action, text, reason };
  }
  return { action, reason };
}

class Navigator {
  constructor({ config, eventStore, openaiHelper = null, fetchImpl = fetch }) {
    this.config = config;
    this.eventStore = eventStore;
    this.openaiHelper = openaiHelper;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.navigator.url || (this.config.navigator.useOpenAI && this.openaiHelper?.enabled));
  }

  async decide({ driver, phase, goal, screen, sessionKey = null, attempt = 1 }) {
    if (!this.enabled) return null;
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
        body = await this.openaiHelper.navigationDecision(payload);
      }
      const decision = normalizeDecision(body);
      await this.eventStore?.append("navigation.decision", {
        sessionKey,
        driver,
        phase,
        action: decision.action,
        reason: decision.reason,
      });
      return decision;
    } finally {
      clearTimeout(timer);
    }
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
