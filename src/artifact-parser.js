"use strict";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => typeof item === "string" ? item : String(item?.text || item?.content || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function claudeUserText(entry) {
  return entry?.type === "user" ? contentText(entry?.message?.content) : "";
}

function claudeAssistantText(entry) {
  if (entry?.type !== "assistant") return "";
  const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  return blocks.filter((item) => item?.type === "text").map((item) => String(item.text || "")).join("\n").trim();
}

function codexAssistantText(entry) {
  if (entry?.type !== "response_item" || entry?.payload?.type !== "message" || entry?.payload?.role !== "assistant") return "";
  return (Array.isArray(entry.payload.content) ? entry.payload.content : [])
    .map((item) => String(item?.text || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function codexReasoningText(entry) {
  const payload = entry?.payload || {};
  if (entry?.type === "event_msg" && payload.type === "agent_reasoning") {
    return String(payload.text || payload.message || "").trim();
  }
  if (entry?.type !== "response_item" || payload.type !== "reasoning") return "";
  return [
    ...(Array.isArray(payload.summary) ? payload.summary : []),
    ...(Array.isArray(payload.content) ? payload.content : []),
  ]
    .filter((item) => ["summary_text", "reasoning_text", "text"].includes(item?.type) && item?.text)
    .map((item) => String(item.text))
    .join("\n")
    .trim();
}

function cleanAssistantText(value, marker) {
  return String(value || "").split(marker).join("").trim();
}

function resultText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => resultText(item?.text ?? item?.content ?? item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") return resultText(value.text ?? value.content ?? "");
  return "";
}

function codexExitCode(payload, output) {
  for (const value of [payload?.exit_code, payload?.exitCode, payload?.metadata?.exit_code, payload?.metadata?.exitCode]) {
    if (Number.isInteger(Number(value))) return Number(value);
  }
  const text = String(output || "");
  try {
    const parsed = JSON.parse(text);
    for (const value of [parsed?.exit_code, parsed?.exitCode, parsed?.metadata?.exit_code, parsed?.metadata?.exitCode]) {
      if (Number.isInteger(Number(value))) return Number(value);
    }
  } catch {}
  const matches = [...text.matchAll(/\b(?:process|command|script)\s+exited with code\s+(-?\d+)\b/gi)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function authFailure(value) {
  return /(?:\b401\b|\bunauthenticated\b|authentication[_ ]failed|authentication credentials|not logged in|login (?:required|expired)|please run \/login|authorization required|invalid (?:api key|token))/i.test(String(value || ""));
}

function createArtifactParser({ driver, marker }) {
  if (!new Set(["claude", "codex"]).has(driver)) throw new Error(`unsupported artifact driver: ${driver}`);
  const state = {
    bound: false,
    providerSessionId: null,
    lastAssistantMessage: "",
    lastError: null,
    reasoning: [],
    toolUses: [],
  };

  function addReasoning(value) {
    const text = String(value || "").trim();
    if (!text || state.reasoning.at(-1) === text) return;
    state.reasoning.push(text);
    if (state.reasoning.length > 20) state.reasoning.splice(0, state.reasoning.length - 20);
  }

  function findTool(id) {
    for (let index = state.toolUses.length - 1; index >= 0; index -= 1) {
      if (state.toolUses[index].id === id) return state.toolUses[index];
    }
    return null;
  }

  function progress() {
    return {
      providerSessionId: state.providerSessionId,
      lastAssistantMessage: state.lastAssistantMessage,
      lastError: state.lastError,
      reasoning: state.reasoning.slice(-20),
      toolUses: state.toolUses.slice(-20),
    };
  }

  function terminal({ ok, reply = state.lastAssistantMessage, error = state.lastError, kind = null }) {
    const finalError = error || null;
    return {
      terminal: true,
      ok,
      kind: kind || (!ok && authFailure(finalError) ? "auth_required" : null),
      reply: reply || "",
      error: finalError,
      ...progress(),
    };
  }

  function parseClaude(entry) {
    const sessionId = String(entry?.sessionId || entry?.session_id || "").trim();
    if (sessionId) state.providerSessionId = sessionId;
    if (!state.bound && claudeUserText(entry).includes(marker)) state.bound = true;
    if (!state.bound) return null;

    if (entry?.type === "user") {
      const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        const tool = findTool(block.tool_use_id);
        if (!tool) continue;
        tool.success = block.is_error !== true;
        tool.error = block.is_error === true ? resultText(block.content) || "tool failed" : null;
      }
    }

    if (entry?.type !== "assistant") return { terminal: false, ...progress() };
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block?.type === "thinking") addReasoning(block.thinking);
      if (block?.type === "tool_use") {
        state.toolUses.push({
          id: block.id || null,
          tool: String(block.name || "unknown"),
          arguments: block.input ?? null,
          success: null,
          error: null,
        });
      }
    }
    const text = cleanAssistantText(claudeAssistantText(entry), marker);
    if (text) state.lastAssistantMessage = text;
    const explicitError = resultText(entry.error || entry.apiErrorStatus || entry?.message?.error || "");
    if (explicitError) state.lastError = text || explicitError;

    const stopReason = String(entry?.message?.stop_reason || "").trim();
    const apiError = entry?.isApiErrorMessage === true || Boolean(explicitError);
    if (apiError) {
      const error = text || state.lastError || `Claude API error${stopReason ? ` (${stopReason})` : ""}`;
      state.lastError = error;
      return terminal({ ok: false, reply: "", error });
    }
    if (stopReason === "max_tokens") {
      const error = "Claude stopped after reaching its token limit";
      state.lastError = error;
      return terminal({ ok: false, reply: state.lastAssistantMessage, error });
    }
    if (stopReason === "end_turn" && text) {
      return terminal({ ok: true, reply: state.lastAssistantMessage, error: null });
    }
    if (stopReason === "stop_sequence" && text && entry?.message?.model !== "<synthetic>") {
      return terminal({ ok: true, reply: state.lastAssistantMessage, error: null });
    }
    return { terminal: false, ...progress() };
  }

  function parseCodex(entry) {
    if (entry?.type === "session_meta") {
      const id = String(entry?.payload?.id || "").trim();
      if (id) state.providerSessionId = id;
    }
    if (!state.bound && entry?.type === "event_msg" && entry?.payload?.type === "user_message") {
      if (String(entry.payload.message || "").includes(marker)) state.bound = true;
    }
    if (!state.bound) return null;

    addReasoning(codexReasoningText(entry));
    const assistant = cleanAssistantText(codexAssistantText(entry), marker);
    if (assistant) state.lastAssistantMessage = assistant;
    const payload = entry?.payload || {};
    if (entry?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      state.toolUses.push({
        id: payload.call_id || payload.id || null,
        tool: String(payload.name || "unknown"),
        arguments: payload.arguments ?? payload.input ?? null,
        success: null,
        error: null,
      });
    }
    if (entry?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const tool = findTool(payload.call_id || payload.id);
      if (tool) {
        const output = resultText(payload.output);
        const exitCode = codexExitCode(payload, output);
        const explicitFailure = payload.success === false || payload.status === "failed" || payload.status === "error";
        const failed = explicitFailure || (exitCode !== null && exitCode !== 0);
        tool.success = !failed;
        tool.error = failed ? output || `tool exited with code ${exitCode}` : null;
      }
    }
    if (entry?.type === "event_msg") {
      if (payload.type === "agent_message" && payload.message) {
        state.lastAssistantMessage = cleanAssistantText(payload.message, marker);
      }
      if (payload.type === "error") state.lastError = String(payload.message || payload.codex_error_info || "Codex error");
      if (payload.type === "turn_aborted") {
        return terminal({ ok: false, reply: "", error: `Codex turn aborted: ${payload.reason || "aborted"}` });
      }
      if (payload.type === "task_complete") {
        const reply = cleanAssistantText(payload.last_agent_message || state.lastAssistantMessage, marker);
        if (reply) state.lastAssistantMessage = reply;
        return terminal({
          ok: Boolean(reply) && !state.lastError,
          reply,
          error: state.lastError || (reply ? null : "Codex completed without a response"),
        });
      }
    }
    return { terminal: false, ...progress() };
  }

  return {
    state,
    feed: driver === "claude" ? parseClaude : parseCodex,
  };
}

function replayArtifact({ driver, marker, entries }) {
  const parser = createArtifactParser({ driver, marker });
  let result = null;
  for (const entry of entries || []) {
    const next = parser.feed(entry);
    if (next) result = next;
    if (next?.terminal) break;
  }
  return result || { terminal: false, ...parser.state };
}

module.exports = {
  authFailure,
  codexExitCode,
  createArtifactParser,
  replayArtifact,
};
