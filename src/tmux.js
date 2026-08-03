"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { isolatedProcessEnv, shellQuote, sleep } = require("./util");

const execFileAsync = promisify(execFile);
const EXIT_STATUS_WAIT_MS = 250;
const EXIT_STATUS_POLL_MS = 25;

class Tmux {
  constructor(socketName = "qozyai-cli-runtime") {
    this.socketName = socketName;
  }

  async run(args, { allowFailure = false } = {}) {
    try {
      const result = await execFileAsync("tmux", ["-L", this.socketName, ...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      return String(result.stdout || "");
    } catch (err) {
      if (allowFailure) return null;
      const message = String(err.stderr || err.stdout || err.message || err).trim();
      throw new Error(`tmux ${args[0]}: ${message}`);
    }
  }

  async has(sessionName) {
    return (await this.run(["has-session", "-t", sessionName], { allowFailure: true })) !== null;
  }

  async createShell(sessionName, workspace) {
    if (await this.has(sessionName)) throw new Error(`tmux session already exists: ${sessionName}`);
    await this.run([
      "new-session", "-d", "-s", sessionName,
      "-x", "160", "-y", "48", "-c", workspace,
    ]);
  }

  async startCommand(sessionName, command, args, env = {}) {
    const envParts = Object.entries(isolatedProcessEnv({ TERM: "screen-256color", COLORTERM: "truecolor", ...env }))
      .map(([key, value]) => `${key}=${shellQuote(value)}`);
    const invocation = [
      "exec", "env", "-i", ...envParts,
      shellQuote(command), ...args.map(shellQuote),
    ].join(" ");
    await this.run(["set-option", "-p", "-t", sessionName, "remain-on-exit", "on"]);
    await this.run(["respawn-pane", "-k", "-t", sessionName, invocation]);
  }

  async driverState(sessionName) {
    let paneDead;
    let value;
    const deadline = Date.now() + EXIT_STATUS_WAIT_MS;
    while (true) {
      const output = await this.run([
        "display-message", "-p", "-t", sessionName,
        "#{pane_dead}\t#{pane_dead_status}",
      ]);
      [paneDead, value = ""] = output.trimEnd().split("\t");
      if (paneDead !== "1" || /^-?\d+$/.test(value)) break;
      if (Date.now() >= deadline) break;
      await sleep(EXIT_STATUS_POLL_MS);
    }
    return {
      paneDead: paneDead === "1",
      state: paneDead === "1" ? "exited" : "running",
      exitCode: paneDead === "1" && /^-?\d+$/.test(value) ? Number(value) : null,
    };
  }

  async capture(sessionName, lines = 120) {
    return this.run(["capture-pane", "-p", "-J", "-S", `-${Math.max(1, lines)}`, "-t", sessionName]);
  }

  async cursorLine(sessionName) {
    const cursorY = Number((await this.run([
      "display-message", "-p", "-t", sessionName, "#{cursor_y}",
    ])).trim());
    if (!Number.isInteger(cursorY) || cursorY < 0) return "";
    return this.run(["capture-pane", "-p", "-S", String(cursorY), "-E", String(cursorY), "-t", sessionName]);
  }

  async sendKey(sessionName, key) {
    await this.run(["send-keys", "-t", sessionName, key]);
  }

  async sendLiteral(sessionName, value) {
    if (!String(value || "")) return;
    await this.run(["send-keys", "-t", sessionName, "-l", "--", String(value)]);
  }

  async pasteFile(sessionName, filePath, bufferName) {
    await this.run(["load-buffer", "-b", bufferName, filePath]);
    try {
      await this.run(["paste-buffer", "-p", "-d", "-b", bufferName, "-t", sessionName]);
    } finally {
      await this.run(["delete-buffer", "-b", bufferName], { allowFailure: true });
    }
  }

  async interrupt(sessionName) {
    await this.sendKey(sessionName, "Escape");
  }

  async kill(sessionName) {
    await this.run(["kill-session", "-t", sessionName], { allowFailure: true });
  }

  attachCommand(sessionName) {
    return `tmux -L ${shellQuote(this.socketName)} attach-session -t ${shellQuote(sessionName)}`;
  }
}

module.exports = { Tmux };
