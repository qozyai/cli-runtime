"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sleepWithSignal } = require("./util");
const { normalizeProgress, summarizeProgress } = require("./workspace-state");

const MAX_INCREMENT_BYTES = 8 * 1024 * 1024;

async function listJsonlFiles(rootDir) {
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files;
}

async function baselineArtifacts(rootDir) {
  const offsets = new Map();
  for (const filePath of await listJsonlFiles(rootDir)) {
    try { offsets.set(filePath, (await fs.stat(filePath)).size); } catch {}
  }
  return offsets;
}

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
  const blocks = [
    ...(Array.isArray(payload.summary) ? payload.summary : []),
    ...(Array.isArray(payload.content) ? payload.content : []),
  ];
  return blocks
    .filter((item) => ["summary_text", "reasoning_text", "text"].includes(item?.type) && item?.text)
    .map((item) => String(item.text))
    .join("\n")
    .trim();
}

function providerSessionIdFromPath(filePath) {
  const name = path.basename(String(filePath || ""));
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return match ? match[1] : null;
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

function createParser(driver, marker) {
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
    if (entry?.type === "assistant") {
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
      if (entry.error || entry.apiErrorStatus) state.lastError = String(entry.error || entry.apiErrorStatus);
      // Claude may persist a thinking-only assistant record with end_turn just
      // before the text record for the same response.
      if (entry?.message?.stop_reason === "end_turn" && text) {
        return {
          terminal: true,
          ok: !state.lastError,
          reply: state.lastAssistantMessage,
          error: state.lastError,
          ...progress(),
        };
      }
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
        const failed = /(?:script|command|process) (?:failed|timed out)|exit(?:ed)? (?:code|status) [1-9]/i.test(output);
        tool.success = !failed;
        tool.error = failed ? output || "tool failed" : null;
      }
    }
    if (entry?.type === "event_msg") {
      if (payload.type === "agent_message" && payload.message) {
        state.lastAssistantMessage = cleanAssistantText(payload.message, marker);
      }
      if (payload.type === "error") state.lastError = String(payload.message || payload.codex_error_info || "Codex error");
      if (payload.type === "turn_aborted") {
        return { terminal: true, ok: false, reply: "", error: `Codex turn aborted: ${payload.reason || "aborted"}`, ...progress() };
      }
      if (payload.type === "task_complete") {
        const reply = cleanAssistantText(payload.last_agent_message || state.lastAssistantMessage, marker);
        if (reply) state.lastAssistantMessage = reply;
        return {
          terminal: true,
          ok: Boolean(reply) && !state.lastError,
          reply,
          error: state.lastError || (reply ? null : "Codex completed without a response"),
          ...progress(),
        };
      }
    }
    return { terminal: false, ...progress() };
  }

  return {
    state,
    parse: driver === "claude" ? parseClaude : parseCodex,
  };
}

async function watchArtifacts({
  driver,
  rootDir,
  baseline,
  marker,
  timeoutMs,
  pollMs,
  signal,
  onBound,
  onProgress,
}) {
  const offsets = new Map(baseline || []);
  const remainders = new Map();
  const parser = createParser(driver, marker);
  let boundFile = null;
  let lastProgressJson = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("submission interrupted");
    const files = boundFile ? [boundFile] : await listJsonlFiles(rootDir);
    for (const filePath of files) {
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      let offset = offsets.has(filePath) ? offsets.get(filePath) : 0;
      if (stat.size < offset) offset = 0;
      if (stat.size === offset) continue;
      if (stat.size - offset > MAX_INCREMENT_BYTES) offset = stat.size - MAX_INCREMENT_BYTES;
      const length = stat.size - offset;
      const handle = await fs.open(filePath, "r");
      const buffer = Buffer.alloc(length);
      try { await handle.read(buffer, 0, length, offset); } finally { await handle.close(); }
      offsets.set(filePath, stat.size);
      const combined = `${remainders.get(filePath) || ""}${buffer.toString("utf8")}`;
      const lines = combined.split("\n");
      remainders.set(filePath, lines.pop() || "");
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const parsed = parser.parse(entry);
        if (parser.state.bound && !boundFile) {
          boundFile = filePath;
          if (!parser.state.providerSessionId) parser.state.providerSessionId = providerSessionIdFromPath(filePath);
          await onBound?.({
            artifactPath: filePath,
            providerSessionId: parser.state.providerSessionId,
          });
        }
        if (!parsed) continue;
        const result = { ...parsed, throughOffset: stat.size };
        const progressJson = JSON.stringify(result);
        if (!result.terminal && progressJson !== lastProgressJson) {
          lastProgressJson = progressJson;
          await onProgress?.({ ...result, artifactPath: filePath });
        }
        if (result.terminal) return { ...result, artifactPath: filePath };
      }
    }
    await sleepWithSignal(pollMs, signal);
  }
  throw new Error(`driver artifacts did not complete within ${timeoutMs}ms`);
}

function publicProgress(progress, status = "running") {
  if (!progress) return null;
  const normalized = normalizeProgress(progress, status);
  return {
    providerSessionId: normalized.providerSessionId,
    lastAssistantMessage: normalized.lastAssistantMessage,
    lastError: normalized.lastError,
    reasoning: normalized.reasoning,
    toolUses: normalized.tools.map((tool) => ({
      callId: tool.callId,
      tool: tool.tool,
      arguments: tool.arguments,
      success: tool.success,
      error: tool.error,
    })),
    summary: summarizeProgress(progress, status, normalized),
    artifactPath: normalized.artifactPath,
    throughOffset: normalized.throughOffset,
  };
}

module.exports = {
  baselineArtifacts,
  listJsonlFiles,
  publicProgress,
  watchArtifacts,
};
