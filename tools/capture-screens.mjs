#!/usr/bin/env node
// Record every distinct screen a tmux pane shows, for building a replayable
// corpus of real authentication flows (spec 0022). Development tool: run it
// beside one real login, then sanitize representative frames into fixtures.
// Raw captures may contain codes and URLs; keep them out of the repository.
//
// Usage:
//   node tools/capture-screens.mjs <tmux-socket> <session-name> <output-dir> [poll-ms]
//
// Writes NNN.txt per distinct frame and index.jsonl with {at, file, bytes}.
// Stops on Ctrl-C or when the session disappears.
"use strict";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const [socket, session, outputDir, pollMsRaw] = process.argv.slice(2);
if (!socket || !session || !outputDir) {
  process.stderr.write("usage: capture-screens.mjs <tmux-socket> <session-name> <output-dir> [poll-ms]\n");
  process.exit(64);
}
const pollMs = Number(pollMsRaw) > 0 ? Number(pollMsRaw) : 200;

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
let previous = null;
let frame = 0;
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

process.stderr.write(`recording ${session} on -L ${socket} every ${pollMs}ms into ${outputDir}\n`);
while (running) {
  let screen;
  try {
    const result = await execFileAsync(
      "tmux",
      ["-L", socket, "capture-pane", "-p", "-J", "-S", "-140", "-t", session],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    screen = String(result.stdout || "");
  } catch (err) {
    process.stderr.write(`session gone or capture failed: ${String(err.stderr || err.message).trim()}\n`);
    break;
  }
  if (screen !== previous) {
    previous = screen;
    frame += 1;
    const file = `${String(frame).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(outputDir, file), screen, { mode: 0o600 });
    await fs.appendFile(
      path.join(outputDir, "index.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), file, bytes: Buffer.byteLength(screen) })}\n`,
      { mode: 0o600 },
    );
    process.stderr.write(`frame ${file} (${Buffer.byteLength(screen)} bytes)\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
process.stderr.write(`recorded ${frame} distinct frame(s)\n`);
