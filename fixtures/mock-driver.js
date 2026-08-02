#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const driver = process.env.CLI_RUNTIME_DRIVER || "claude";
const home = process.env.HOME;
const sessionId = crypto.randomUUID();
let startupGate = process.argv.includes("--startup-gate");

function artifactPath() {
  if (driver === "claude") {
    const dir = path.join(home, ".claude", "projects", "mock-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${sessionId}.jsonl`);
  }
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const dir = path.join(home, ".codex", "sessions", yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-${sessionId}.jsonl`);
}

const filePath = artifactPath();
if (driver === "codex") {
  fs.appendFileSync(filePath, `${JSON.stringify({ type: "session_meta", timestamp: new Date().toISOString(), payload: { id: sessionId } })}\n`);
}

function append(value) {
  fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`);
}

function complete(line) {
  const clean = line.replace(/\s*<cli-runtime-submission id="[^"]+"\/>\s*$/, "").trim();
  if (clean.includes("EXIT")) process.exit(7);
  if (clean.includes("HANG")) {
    if (driver === "claude") append({ type: "user", sessionId, message: { role: "user", content: line } });
    else append({ type: "event_msg", payload: { type: "user_message", message: line } });
    return;
  }
  const reply = `MOCK_${driver.toUpperCase()}: ${clean}`;
  if (driver === "claude") {
    append({ type: "user", sessionId, message: { role: "user", content: line } });
    append({
      type: "assistant",
      sessionId,
      message: { role: "assistant", content: [{ type: "thinking", thinking: `Inspecting ${clean}` }], stop_reason: "end_turn" },
    });
    if (clean.includes("TOOL")) {
      append({
        type: "assistant",
        sessionId,
        message: { role: "assistant", content: [{ type: "tool_use", id: "tool-mock", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" },
      });
      append({
        type: "user",
        sessionId,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-mock", content: "", is_error: false }] },
      });
    }
    append({
      type: "assistant",
      sessionId,
      message: { role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn" },
    });
  } else {
    append({ type: "event_msg", payload: { type: "user_message", message: line } });
    append({ type: "event_msg", payload: { type: "agent_reasoning", text: `Inspecting ${clean}` } });
    append({ type: "event_msg", payload: { type: "agent_message", message: `Working on ${clean}` } });
    if (clean.includes("TOOL")) {
      append({ type: "response_item", payload: { type: "custom_tool_call", call_id: "call-mock", name: "exec", input: "true" } });
      append({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-mock", output: [{ type: "input_text", text: "Script completed" }] } });
    }
    append({ type: "event_msg", payload: { type: "task_complete", last_agent_message: reply } });
  }
  process.stdout.write(`\n${reply}\n`);
  rl.prompt();
}

process.stdout.write(startupGate ? "Unfamiliar startup screen. Enter 7 to continue.\n" : driver === "claude" ? "Claude Code mock\n" : "OpenAI Codex mock\n");
const readyPrompt = driver === "claude" ? "❯ " : "› ";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: startupGate ? "" : readyPrompt });
if (!startupGate) rl.prompt();
rl.on("line", (line) => {
  if (startupGate) {
    if (line.trim() === "7") {
      startupGate = false;
      process.stdout.write(`${driver === "claude" ? "Claude Code" : "OpenAI Codex"} mock\n`);
      rl.setPrompt(readyPrompt);
      rl.prompt();
    }
    return;
  }
  const delay = line.includes("SLOW") ? 1500 : 20;
  setTimeout(() => complete(line), delay);
});
rl.on("close", () => process.exit(0));
