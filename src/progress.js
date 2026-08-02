"use strict";

const path = require("node:path");

const MAX_REASONING_CHUNKS = 3;
const MAX_TOOL_USES = 3;
const MAX_REASONING_CHARS = 2000;
const MAX_TOOL_ERROR_CHARS = 4000;
const MAX_STATUS_CHARS = 500;
const MAX_HISTORY_MESSAGE_CHARS = 40_000;

const MIME_BY_EXTENSION = new Map([
  [".aac", "audio/aac"], [".csv", "text/csv"], [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"], [".htm", "text/html"], [".html", "text/html"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".json", "application/json"],
  [".m4a", "audio/mp4"], [".md", "text/markdown"], [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"], [".mp4", "video/mp4"], [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"], [".pdf", "application/pdf"], [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".svg", "image/svg+xml"], [".txt", "text/plain"], [".wav", "audio/wav"],
  [".webm", "video/webm"], [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

function safeFilename(value, fallback = "file") {
  const base = path.basename(String(value || "")).normalize("NFKD");
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 160) || fallback;
}

function mimeTypeFor(filePath, fallback = "application/octet-stream") {
  return MIME_BY_EXTENSION.get(path.extname(String(filePath || "")).toLowerCase()) || fallback;
}

function redactText(value) {
  return String(value || "")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=\-]{4,}/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\b\d{6,12}:AA[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

function boundedText(value, maxChars) {
  const normalized = redactText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}

function boundedHistoryText(value, maxChars = MAX_HISTORY_MESSAGE_CHARS) {
  const text = redactText(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 28))}\n[history text truncated]`;
}

function normalizeProgress(progress, status = "running") {
  const reasoning = (Array.isArray(progress?.reasoning) ? progress.reasoning : [])
    .slice(-MAX_REASONING_CHUNKS)
    .map((item) => boundedText(item, MAX_REASONING_CHARS))
    .filter(Boolean);
  const tools = (Array.isArray(progress?.toolUses) ? progress.toolUses : [])
    .slice(-MAX_TOOL_USES)
    .map((tool) => ({
      id: tool?.id || null,
      tool: boundedText(tool?.tool || "unknown", 200),
      success: typeof tool?.success === "boolean" ? tool.success : null,
      error: tool?.success === false ? boundedText(tool?.error || "tool failed", MAX_TOOL_ERROR_CHARS) : null,
    }));
  return {
    status,
    throughOffset: Number.isFinite(progress?.throughOffset) ? progress.throughOffset : null,
    artifactPath: progress?.artifactPath || null,
    providerSessionId: progress?.providerSessionId || null,
    reasoning,
    tools,
    lastAssistantMessage: boundedText(progress?.lastAssistantMessage || "", 8000),
    lastError: boundedText(progress?.lastError || "", MAX_TOOL_ERROR_CHARS) || null,
  };
}

function summarizeProgress(progress, status = "running", normalizedProgress = null) {
  const normalized = normalizedProgress || normalizeProgress(progress, status);
  const lines = [];
  if (status === "completed") lines.push("Completed.");
  else if (["failed", "interrupted"].includes(status)) lines.push(status === "failed" ? "Stopped with an error." : "Interrupted.");
  else lines.push("Working.");
  if (normalized.reasoning.length > 0) lines.push(normalized.reasoning.at(-1));
  else if (status === "running" && normalized.lastAssistantMessage) lines.push(normalized.lastAssistantMessage);
  if (normalized.tools.length > 0) {
    lines.push(`Recent tools: ${normalized.tools.map((tool) => {
      const marker = tool.success === true ? "ok" : tool.success === false ? "failed" : "running";
      return `${tool.tool} (${marker})`;
    }).join(", ")}`);
  }
  if (normalized.lastError) lines.push(`Error: ${normalized.lastError}`);
  const summary = lines.join("\n").trim();
  if (summary.length <= MAX_STATUS_CHARS) return summary;
  return `${summary.slice(0, Math.max(0, MAX_STATUS_CHARS - 14))}...[truncated]`;
}

module.exports = {
  MAX_STATUS_CHARS,
  boundedHistoryText,
  boundedText,
  mimeTypeFor,
  normalizeProgress,
  redactText,
  safeFilename,
  summarizeProgress,
};
